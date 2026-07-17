import { describe, expect, it } from "vitest";
import { Texture } from "three";
import { FXEmitter } from "../../src/emitter/FXEmitter";
import { FXArtifactMaterial } from "../../src/render/FXArtifactMaterial";
import type { FXBehaviorArtifact, FXRenderArtifact } from "../../src/artifact/FXArtifact";
import {
  FX_CORE_LIFECYCLE,
  FX_CORE_POSITION,
  FX_LIFETIME,
  FX_POSITION_Y,
} from "../../src/coreLayout";
import type { GLTypeInfo } from "../../src/instancedParticle/glTypeInfo";
import type { FXInstancedParticle } from "../../src/instancedParticle/FXInstancedParticle";
import { unlitArtifact, VEC2_VARYING, VEC3_VARYING } from "../helpers/artifacts";

/** Reaches the emitter's private mesh to inspect its per-particle buffers. */
function meshOf(emitter: FXEmitter): FXInstancedParticle {
  return (emitter as unknown as { mesh: FXInstancedParticle }).mesh;
}

/** Drives one private tick on `emitter` with the given dt. */
function tickEmitter(emitter: FXEmitter, dt: number): void {
  (emitter as unknown as { tick(deltaTime: number): void }).tick(dt);
}

/**
 * A behavior artifact with a live `gravity` binding: spawn seeds `lifetime`, and update
 * accumulates `gravity` into each particle's `position.y`. Scrubbing the binding must be
 * read on the next tick.
 */
function gravityBehavior(gravity: number): FXBehaviorArtifact {
  return {
    buffers: [
      { name: FX_CORE_POSITION, stride: 3 },
      { name: FX_CORE_LIFECYCLE, stride: 2 },
    ],
    attributeWrites: [],
    bindings: { b_gravity$0: { value: gravity } },
    spawnWrittenBuffers: [FX_CORE_LIFECYCLE],
    updateWrittenBuffers: [FX_CORE_POSITION],
    spawn(buffers, start, count): void {
      const lifecycle = buffers[FX_CORE_LIFECYCLE];
      for (let i = start; i < start + count; i++) {
        lifecycle[i * 2 + FX_LIFETIME] = 1000;
      }
    },
    update(buffers, count, dt, bindings): void {
      const position = buffers[FX_CORE_POSITION];
      const g = bindings["b_gravity$0"].value as number;
      for (let i = 0; i < count; i++) {
        position[i * 3 + FX_POSITION_Y] += g * dt;
      }
    },
  };
}

describe("FXEmitter.applyValues - behavior bindings", () => {
  it("scrubs a binding value that the next update tick reads", () => {
    const emitter = FXEmitter.fromArtifacts(unlitArtifact(), gravityBehavior(-1));
    try {
      emitter.burst(1);
      const posY = (): number =>
        meshOf(emitter).propertyBuffers[FX_CORE_LIFECYCLE].array.length > 0
          ? (meshOf(emitter).propertyBuffers[FX_CORE_POSITION].array[FX_POSITION_Y] as number)
          : 0;

      tickEmitter(emitter, 1); // gravity -1 -> y = -1
      expect(posY()).toBeCloseTo(-1, 6);

      emitter.applyValues({ bindings: { b_gravity$0: 10 } });
      tickEmitter(emitter, 1); // gravity now +10 -> y = -1 + 10 = 9
      expect(posY()).toBeCloseTo(9, 6);
    } finally {
      emitter.destroy();
    }
  });

  it("ignores an unknown binding name (safe no-op, no throw)", () => {
    const emitter = FXEmitter.fromArtifacts(unlitArtifact(), gravityBehavior(-1));
    try {
      expect(() => emitter.applyValues({ bindings: { nope$9: 42 } })).not.toThrow();
      // The real binding is untouched.
      emitter.burst(1);
      tickEmitter(emitter, 1);
      expect(meshOf(emitter).propertyBuffers[FX_CORE_POSITION].array[FX_POSITION_Y]).toBeCloseTo(
        -1,
        6,
      );
    } finally {
      emitter.destroy();
    }
  });

  it("is a no-op after destroy", () => {
    const emitter = FXEmitter.fromArtifacts(unlitArtifact(), gravityBehavior(-1));
    emitter.destroy();
    expect(() => emitter.applyValues({ bindings: { b_gravity$0: 5 } })).not.toThrow();
  });
});

function coreVaryings(): Record<string, GLTypeInfo> {
  return {
    position: VEC3_VARYING,
    lifecycle: VEC2_VARYING,
  };
}

/** Builds the Three material from the driver and returns its bound uniform map. */
function boundUniforms(material: FXArtifactMaterial): Record<string, { value: unknown }> {
  return (
    material.buildThreeMaterial(coreVaryings()) as unknown as {
      uniforms: Record<string, { value: unknown }>;
    }
  ).uniforms;
}

describe("FXEmitter.applyValues - render uniforms", () => {
  const withScalar = (): FXRenderArtifact => ({
    lightingIntrinsics: [],
    uniformDeclarations: ["uniform float u_speed$0;"],
    vertex: { varyingDeclarations: [], helperFunctions: [], body: [] },
    fragment: { varyingDeclarations: [], helperFunctions: [], body: [] },
    outputs: { albedo: "vec4(u_speed$0)" },
    uniforms: { u_speed$0: { type: "float", value: 0.5 } },
    attributeReads: [],
  });

  const withExternal = (): FXRenderArtifact => ({
    lightingIntrinsics: [],
    uniformDeclarations: ["uniform sampler2D u_flame$0;"],
    vertex: { varyingDeclarations: [], helperFunctions: [], body: [] },
    fragment: { varyingDeclarations: [], helperFunctions: [], body: [] },
    outputs: { albedo: "texture2D(u_flame$0, p_uv)" },
    uniforms: { u_flame$0: { type: "sampler2D", external: "flame" } },
    attributeReads: [],
  });

  it("mutates the shared artifact slot bound into the Three uniforms", () => {
    const render = withScalar();
    const material = new FXArtifactMaterial(render);
    const bound = boundUniforms(material)["u_speed$0"] as { value: number };
    expect(bound.value).toBe(0.5);

    material.applyUniformValues({ u_speed$0: 0.9 });
    // The Three uniform shares the artifact's slot object, so the scrub is visible.
    expect(bound.value).toBe(0.9);
    expect(render.uniforms["u_speed$0"].value).toBe(0.9);
  });

  it("scrubs an external texture through its durable per-emitter slot", () => {
    const first = new Texture();
    const second = new Texture();
    const material = new FXArtifactMaterial(withExternal(), { flame: first });
    const bound = boundUniforms(material)["u_flame$0"] as { value: Texture };
    expect(bound.value).toBe(first);

    material.applyUniformValues({ u_flame$0: second });
    // The external slot bound into Three is the same object we scrub -> it swaps live.
    expect(bound.value).toBe(second);
  });

  it("ignores an unknown uniform name (safe no-op)", () => {
    const material = new FXArtifactMaterial(withScalar());
    expect(() => material.applyUniformValues({ nope$9: 1 })).not.toThrow();
  });
});

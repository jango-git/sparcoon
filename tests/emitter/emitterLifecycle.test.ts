import type { Material } from "three";
import { describe, expect, it, vi } from "vitest";

import { FX_AGE, FX_LIFETIME } from "../../src/coreLayout";
import { FXEmitter } from "../../src/emitter/FXEmitter";
import { buildPrimitiveGeometry } from "../../src/instancedParticle/primitiveGeometry";
import { FXArtifactMaterial } from "../../src/render/FXArtifactMaterial";
import { behaviorArtifact, unlitArtifact } from "../helpers/artifacts";
import { particlesOf, tickEmitter } from "../helpers/internals";
import { fieldOf } from "../helpers/slots";

/** A plain emitter: flat-white render, a spawn that seeds lifetime 4. */
function plainEmitter(options?: Parameters<typeof FXEmitter.fromArtifacts>[2]): FXEmitter {
  return FXEmitter.fromArtifacts(unlitArtifact(), behaviorArtifact({ lifetime: 4 }), options);
}

describe("FXEmitter construction", () => {
  it("fails fast for a behavior artifact with no spawn function, building no depth material", () => {
    // A particle emitter's whole job is seeding births, so an update-only artifact can never drive
    // one - refused at construction, not in the frame tick.
    const build = vi.spyOn(FXArtifactMaterial.prototype, "buildThreeDepthMaterial");
    try {
      expect(() =>
        FXEmitter.fromArtifacts(unlitArtifact(), behaviorArtifact({ noSpawn: true }), {
          castShadow: true,
        }),
      ).toThrow(/cannot seed births \(update-only\)/);
      expect(build).not.toHaveBeenCalled();
    } finally {
      build.mockRestore();
    }
  });

  it("rejects a capacity below one or fractional in every build", () => {
    expect(() => plainEmitter({ expectedCapacity: 0 })).toThrow(RangeError);
    expect(() => plainEmitter({ expectedCapacity: 2.5 })).toThrow(RangeError);
    expect(() => plainEmitter({ expectedCapacity: Number.NaN })).toThrow(RangeError);
  });
});

describe("FXEmitter.reset", () => {
  it("leaves nothing to simulate until the next birth", () => {
    const update = vi.fn();
    const emitter = FXEmitter.fromArtifacts(unlitArtifact(), behaviorArtifact({ update }));
    try {
      tickEmitter(emitter, 0.1);
      expect(update).not.toHaveBeenCalled();

      emitter.burst(2);
      tickEmitter(emitter, 0.1);
      tickEmitter(emitter, 0.1);
      expect(update).toHaveBeenCalled();

      emitter.reset();
      update.mockClear();
      tickEmitter(emitter, 0.1);
      expect(update).not.toHaveBeenCalled();
      expect(emitter.particleCount).toBe(0);
    } finally {
      emitter.destroy();
    }
  });
});

describe("FXEmitter.destroy", () => {
  it("dispatches dispose on the geometry and the mounted material exactly once", () => {
    const emitter = plainEmitter();
    const mesh = particlesOf(emitter);
    let geometryDisposed = 0;
    let materialDisposed = 0;
    mesh.geometry.addEventListener("dispose", () => geometryDisposed++);
    (mesh.material as Material).addEventListener("dispose", () => materialDisposed++);

    emitter.destroy();
    emitter.destroy();
    expect(geometryDisposed).toBe(1);
    expect(materialDisposed).toBe(1);
  });

  it("disposes the shadow depth material it built", () => {
    const emitter = plainEmitter({ castShadow: true });
    const depth = particlesOf(emitter).customDepthMaterial as Material;
    let disposed = 0;
    depth.addEventListener("dispose", () => disposed++);
    emitter.destroy();
    expect(disposed).toBe(1);
  });

  it("never disposes an app-supplied custom geometry (it is the caller's, possibly shared)", () => {
    const custom = buildPrimitiveGeometry("box");
    const emitter = FXEmitter.fromArtifacts(
      unlitArtifact({ geometry: { type: "custom", external: "myMesh" } }),
      behaviorArtifact({ lifetime: 4 }),
      { geometries: { myMesh: custom } },
    );
    let customDisposed = 0;
    custom.addEventListener("dispose", () => customDisposed++);

    emitter.destroy();
    expect(customDisposed).toBe(0);
  });

  it("leaves an inert emitter: nothing schedules, spawns, swaps or reports any more", () => {
    const render = unlitArtifact({
      uniformDeclarations: ["uniform float u_glow;"],
      uniforms: { u_glow: { type: "float", value: 0 } },
    });
    const emitter = FXEmitter.fromArtifacts(render, behaviorArtifact({ lifetime: 4 }));
    const mesh = particlesOf(emitter);
    const material = mesh.material;
    emitter.burst(2, { delay: 1 });
    emitter.destroy();

    expect(emitter.burst(5)).toBe(-1);
    expect(emitter.play(10)).toBe(-1);
    expect(emitter.stop()).toBe(false);
    emitter.prewarm(2);
    emitter.reset();
    expect(emitter.particleCount).toBe(0);

    emitter.applyValues({ uniforms: { u_glow: 1 } });
    expect(render.uniforms["u_glow"]).toHaveProperty("value", 0);
    emitter.applyRenderArtifact(unlitArtifact(), { castShadow: true });
    expect(mesh.material).toBe(material);
    expect(mesh.customDepthMaterial).toBeUndefined();
    emitter.applyTrailArtifact({ render: unlitArtifact(), frames: 2, sampleInterval: 0.1 });
    expect(emitter.hasTrail).toBe(false);

    const listener = vi.fn();
    emitter.onParticleDeath(listener)();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("respawn into reused ring slots", () => {
  function lifecycleAt(emitter: FXEmitter, row: number, offset: number): number {
    return fieldOf(particlesOf(emitter), "lifecycle")[row * 3 + offset];
  }

  it("starts a birth into a dead particle's slot at age 0, not the previous occupant's age", () => {
    const emitter = plainEmitter({ expectedCapacity: 2 });
    try {
      emitter.burst(2);
      tickEmitter(emitter, 0); // births land in a tick; a paused one seeds without simulating
      expect(emitter.particleCount).toBe(2);
      // The spawn seeds lifetime = 4; age starts at 0.
      expect(lifecycleAt(emitter, 0, FX_LIFETIME)).toBe(4);
      expect(lifecycleAt(emitter, 0, FX_AGE)).toBe(0);

      // Age past lifetime so both particles die; their slots stay in place, dead.
      tickEmitter(emitter, 5);
      expect(emitter.particleCount).toBe(0);
      expect(lifecycleAt(emitter, 0, FX_AGE)).toBeGreaterThanOrEqual(4);

      // The ring holds 2, so the second burst wraps back onto slots 0..1, which still hold the
      // dead occupants' age >= lifetime. No spawn can reset age, so the claim must zero it.
      emitter.burst(2);
      tickEmitter(emitter, 0);
      expect(emitter.particleCount).toBe(2);
      expect(lifecycleAt(emitter, 0, FX_AGE)).toBe(0);
      expect(lifecycleAt(emitter, 1, FX_AGE)).toBe(0);

      // A stale age would cull them on the very next tick.
      tickEmitter(emitter, 0.01);
      expect(emitter.particleCount).toBe(2);
    } finally {
      emitter.destroy();
    }
  });
});

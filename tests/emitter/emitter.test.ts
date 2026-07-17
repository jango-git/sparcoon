import { describe, expect, it } from "vitest";
import { FXEmitter } from "../../src/emitter/FXEmitter";
import type { FXInstancedParticle } from "../../src/instancedParticle/FXInstancedParticle";
import { FX_POSITION_Y } from "../../src/coreLayout";
import { behaviorArtifact, unlitArtifact } from "../helpers/artifacts";

/** Reaches the emitter's private mesh to inspect its per-particle buffers. */
function meshOf(emitter: FXEmitter): FXInstancedParticle {
  return (emitter as unknown as { mesh: FXInstancedParticle }).mesh;
}

/** Drives one private tick on `emitter` with the given dt. */
function tickEmitter(emitter: FXEmitter, dt: number): void {
  (emitter as unknown as { tick(deltaTime: number): void }).tick(dt);
}

describe("FXEmitter wires the behavior attribute channel", () => {
  it("allocates a_fx_<name> at construction and fills it on spawn", () => {
    // Behavior seeds lifetime + a per-particle `seed` float = 0.5.
    const emitter = FXEmitter.fromArtifacts(
      unlitArtifact(),
      behaviorArtifact({
        lifetime: 5,
        attributes: [{ name: "seed", components: 1, value: [0.5] }],
      }),
    );
    try {
      const mesh = meshOf(emitter);
      // Allocated up front from the behavior artifact's attributeWrites.
      expect(mesh.propertyBuffers["fx_seed"]).toBeDefined();
      expect(mesh.propertyBuffers["fx_seed"].itemSize).toBe(1);

      emitter.burst(2);
      expect(emitter.particleCount).toBe(2);

      const seed = mesh.propertyBuffers["fx_seed"].array;
      expect(seed[0]).toBeCloseTo(0.5, 6);
      expect(seed[1]).toBeCloseTo(0.5, 6);
    } finally {
      emitter.destroy();
    }
  });

  it("ticks without error and keeps particles alive within their lifetime", () => {
    const emitter = FXEmitter.fromArtifacts(
      unlitArtifact(),
      behaviorArtifact({
        lifetime: 5,
        attributes: [{ name: "seed", components: 1, value: [0.5] }],
      }),
    );
    try {
      emitter.burst(3);
      // Drive a few frames; particles have lifetime 5, so all survive.
      emitter.prewarm(1);
      expect(emitter.particleCount).toBe(3);
      expect(meshOf(emitter).propertyBuffers["fx_seed"].array[0]).toBeCloseTo(0.5, 6);
    } finally {
      emitter.destroy();
    }
  });

  it("shares one buffer when behavior writes and render reads the same attribute", () => {
    // Behavior stores a vec3 `offset` at spawn; the material reads it back into albedo.
    // Both sides name `offset` -> a single a_fx_offset buffer.
    const emitter = FXEmitter.fromArtifacts(
      unlitArtifact({
        attributeReads: [{ name: "offset", components: 3 }],
        outputs: { albedo: "vec4(p_fx_offset, 1.0)" },
      }),
      behaviorArtifact({
        lifetime: 5,
        attributes: [{ name: "offset", components: 3, value: [1, 2, 3] }],
      }),
    );
    try {
      const mesh = meshOf(emitter);
      // A single shared vec3 buffer, allocated up front from the merged set.
      expect(mesh.propertyBuffers["fx_offset"].itemSize).toBe(3);

      emitter.burst(1);
      const offset = mesh.propertyBuffers["fx_offset"].array;
      expect([offset[0], offset[1], offset[2]]).toEqual([1, 2, 3]);
    } finally {
      emitter.destroy();
    }
  });

  it("runs the update kernel each tick and moves particles (integration path)", () => {
    // An update that advances position.y by 2 units/second - the executor-model analog
    // of an `integrate-motion` node writing `position += velocity * dt`.
    const emitter = FXEmitter.fromArtifacts(
      unlitArtifact(),
      behaviorArtifact({
        lifetime: 100,
        update: (buffers, count, dt) => {
          const position = buffers.position;
          for (let i = 0; i < count; i++) {
            position[i * 3 + FX_POSITION_Y] += 2 * dt;
          }
        },
        updateWrittenBuffers: ["position"],
      }),
    );
    try {
      emitter.burst(1);
      const position = meshOf(emitter).propertyBuffers.position.array;
      expect(position[FX_POSITION_Y]).toBe(0);

      tickEmitter(emitter, 1);
      // Age tick + update ran: the particle rose 2 units and stays alive (lifetime 100).
      expect(emitter.particleCount).toBe(1);
      expect(position[FX_POSITION_Y]).toBeCloseTo(2, 6);

      tickEmitter(emitter, 0.5);
      expect(position[FX_POSITION_Y]).toBeCloseTo(3, 6);
    } finally {
      emitter.destroy();
    }
  });
});

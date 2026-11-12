import { describe, expect, it } from "vitest";

import { FX_POSITION_Y } from "../../src/coreLayout";
import { FXEmitter } from "../../src/emitter/FXEmitter";
import { behaviorArtifact, unlitArtifact } from "../helpers/artifacts";
import { landBirths, particlesOf, tickEmitter } from "../helpers/internals";
import { fieldComponents, fieldOf } from "../helpers/slots";

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
      const mesh = particlesOf(emitter);
      // Laid out up front from the behavior artifact's slot.
      expect(fieldComponents(mesh, "fx_seed")).toBeDefined();
      expect(fieldComponents(mesh, "fx_seed")).toBe(1);

      emitter.burst(2);
      expect(emitter.particleCount).toBe(0); // due, seeded in the next tick
      landBirths(emitter);
      expect(emitter.particleCount).toBe(2);

      const seed = fieldOf(mesh, "fx_seed");
      expect(seed[0]).toBeCloseTo(0.5, 6);
      expect(seed[1]).toBeCloseTo(0.5, 6);
    } finally {
      emitter.destroy();
    }
  });

  it("shares one buffer when behavior writes and render reads the same attribute", () => {
    // Behavior seeds a per-particle vec3 `tint`; the material reads it back into albedo. Both
    // sides name `tint` -> a single a_fx_tint buffer.
    const emitter = FXEmitter.fromArtifacts(
      unlitArtifact({
        attributeReads: [{ name: "tint", components: 3 }],
        outputs: { albedo: "vec4(p_fx_tint, 1.0)" },
      }),
      behaviorArtifact({
        lifetime: 5,
        attributes: [{ name: "tint", components: 3, valueFn: (slot) => [slot, 2 * slot, 0.5] }],
      }),
    );
    try {
      const mesh = particlesOf(emitter);
      // A single shared vec3 buffer, allocated up front from the merged set.
      expect(fieldComponents(mesh, "fx_tint")).toBe(3);

      emitter.burst(2);
      landBirths(emitter);
      // Each particle got its own value, in its own slot.
      expect(Array.from(fieldOf(mesh, "fx_tint").subarray(0, 6))).toEqual([0, 0, 0.5, 1, 2, 0.5]);
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
        update: (fields, count, dt) => {
          const position = fields.position;
          for (let i = 0; i < count; i++) {
            position[i * 3 + FX_POSITION_Y] += 2 * dt;
          }
        },
      }),
    );
    try {
      emitter.burst(1);
      const positionY = (): number => fieldOf(particlesOf(emitter), "position")[FX_POSITION_Y];
      tickEmitter(emitter, 1);
      // Born in this tick: seeded after its update, not moved yet.
      expect(emitter.particleCount).toBe(1);
      expect(positionY()).toBe(0);

      tickEmitter(emitter, 1);
      // Age tick + update ran: the particle rose 2 units and stays alive (lifetime 100).
      expect(emitter.particleCount).toBe(1);
      expect(positionY()).toBeCloseTo(2, 6);

      tickEmitter(emitter, 0.5);
      expect(positionY()).toBeCloseTo(3, 6);
    } finally {
      emitter.destroy();
    }
  });
});

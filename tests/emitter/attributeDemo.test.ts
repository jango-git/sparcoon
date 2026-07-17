import { describe, expect, it } from "vitest";
import { FXEmitter } from "../../src/emitter/FXEmitter";
import type { FXInstancedParticle } from "../../src/instancedParticle/FXInstancedParticle";
import { behaviorArtifact, unlitArtifact } from "../helpers/artifacts";

function meshOf(emitter: FXEmitter): FXInstancedParticle {
  return (emitter as unknown as { mesh: FXInstancedParticle }).mesh;
}

/**
 * The "per-particle spawn color" column, end to end: behavior seeds a random rgb `tint`
 * at spawn (an ordinary attribute in the executor model - randoms are inline `Math.random`,
 * no builtin channel), the render artifact reads it back and paints albedo.
 */
describe("per-particle spawn color demo", () => {
  it("colors particles from a spawn attribute", () => {
    const emitter = FXEmitter.fromArtifacts(
      unlitArtifact({
        attributeReads: [{ name: "tint", components: 3 }],
        outputs: { albedo: "vec4(p_fx_tint, 1.0)" },
      }),
      behaviorArtifact({
        lifetime: 3,
        attributes: [
          {
            name: "tint",
            components: 3,
            valueFn: () => [Math.random(), Math.random(), Math.random()],
          },
        ],
      }),
    );
    try {
      const mesh = meshOf(emitter);
      expect(mesh.propertyBuffers["fx_tint"].itemSize).toBe(3);

      emitter.burst(2);
      // The seeded tint is a per-particle rgb in [0, 1]; both particles filled.
      const tint = mesh.propertyBuffers["fx_tint"].array;
      for (let i = 0; i < 6; i++) {
        expect(tint[i]).toBeGreaterThanOrEqual(0);
        expect(tint[i]).toBeLessThanOrEqual(1);
      }
      // Position rode the core buffer independently (no overlap with tint).
      expect(mesh.propertyBuffers.position.itemSize).toBe(3);
    } finally {
      emitter.destroy();
    }
  });
});

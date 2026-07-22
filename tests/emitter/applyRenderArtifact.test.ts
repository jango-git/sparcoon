import { describe, expect, it } from "vitest";
import { FXEmitter } from "../../src/emitter/FXEmitter";
import type { FXInstancedParticle } from "../../src/instancedParticle/FXInstancedParticle";
import { behaviorArtifact, unlitArtifact } from "../helpers/artifacts";

/** Reaches the emitter's private mesh to inspect its per-particle buffers/geometry/material. */
function meshOf(emitter: FXEmitter): FXInstancedParticle {
  return (emitter as unknown as { mesh: FXInstancedParticle }).mesh;
}

// Exercises FXEmitter.applyRenderArtifact: a render-only structural edit (new shader, geometry,
// shadow flags) applied in place, without rebuilding the emitter or resetting live particles -
// the fix for the editor's "render-only edit restarts playback" issue.
describe("FXEmitter.applyRenderArtifact", () => {
  it("swaps the material and geometry without touching particle state", () => {
    const emitter = FXEmitter.fromArtifacts(
      unlitArtifact({ outputs: { albedo: "vec4(1.0)" } }),
      behaviorArtifact({
        lifetime: 5,
        attributes: [{ name: "seed", components: 1, value: [0.5] }],
      }),
    );
    try {
      emitter.burst(3);
      expect(emitter.particleCount).toBe(3);
      const mesh = meshOf(emitter);
      const seedBefore = mesh.propertyBuffers["fx_seed"].array.slice();
      const previousMaterial = mesh.material;
      const previousGeometry = mesh.geometry.getAttribute("position");

      emitter.applyRenderArtifact(
        unlitArtifact({
          outputs: { albedo: "vec4(0.0, 1.0, 0.0, 1.0)" },
          geometry: { type: "primitive", primitive: "box" },
        }),
      );

      // Same emitter, same mesh instance, same live particles - only material/base geometry moved.
      expect(meshOf(emitter)).toBe(mesh);
      expect(emitter.particleCount).toBe(3);
      expect(Array.from(mesh.propertyBuffers["fx_seed"].array)).toEqual(Array.from(seedBefore));
      expect(mesh.material).not.toBe(previousMaterial);
      // A box's base geometry has more vertices than the default plane - proves the swap landed.
      expect(mesh.geometry.getAttribute("position")).not.toBe(previousGeometry);
      expect(mesh.geometry.getAttribute("position").count).toBeGreaterThan(previousGeometry.count);
    } finally {
      emitter.destroy();
    }
  });

  it("still runs ticks and integrates state after a swap", () => {
    const emitter = FXEmitter.fromArtifacts(unlitArtifact(), behaviorArtifact({ lifetime: 5 }));
    try {
      emitter.burst(2);
      emitter.applyRenderArtifact(unlitArtifact({ outputs: { albedo: "vec4(0.5)" } }));
      expect(() => emitter.prewarm(1)).not.toThrow();
      expect(emitter.particleCount).toBe(2);
    } finally {
      emitter.destroy();
    }
  });

  it("builds and disposes a depth material when castShadow toggles on then off", () => {
    const emitter = FXEmitter.fromArtifacts(unlitArtifact(), behaviorArtifact({ lifetime: 5 }));
    try {
      const mesh = meshOf(emitter);
      expect(mesh.customDepthMaterial).toBeUndefined();

      emitter.applyRenderArtifact(unlitArtifact(), { castShadow: true });
      expect(mesh.customDepthMaterial).toBeDefined();
      expect(mesh.castShadow).toBe(true);
      const depthMaterial = mesh.customDepthMaterial;

      emitter.applyRenderArtifact(unlitArtifact(), { castShadow: false });
      expect(mesh.customDepthMaterial).toBeUndefined();
      expect(mesh.castShadow).toBe(false);
      // The old depth material must be disposed, not merely dropped.
      expect(depthMaterial?.dispose).toBeDefined();
    } finally {
      emitter.destroy();
    }
  });

  it("rejects a render artifact whose attribute reads add a name the driver never allocated", () => {
    // The original render artifact reads nothing extra; behavior writes no custom attributes
    // either, so this driver's varyings are exactly the two core buffers.
    const emitter = FXEmitter.fromArtifacts(unlitArtifact(), behaviorArtifact({ lifetime: 5 }));
    try {
      const mesh = meshOf(emitter);
      const materialBefore = mesh.material;

      expect(() =>
        emitter.applyRenderArtifact(
          unlitArtifact({ attributeReads: [{ name: "glow", components: 1 }] }),
        ),
      ).toThrow(/attribute reads no longer match/);

      // Rejected in place: nothing about the live emitter changed.
      expect(mesh.material).toBe(materialBefore);
    } finally {
      emitter.destroy();
    }
  });

  it("is a no-op on a destroyed emitter", () => {
    const emitter = FXEmitter.fromArtifacts(unlitArtifact(), behaviorArtifact({ lifetime: 5 }));
    emitter.destroy();
    expect(() => emitter.applyRenderArtifact(unlitArtifact())).not.toThrow();
  });
});

import { describe, expect, it } from "vitest";
import type { Material } from "three";
import { FXEmitter } from "../../src/emitter/FXEmitter";
import { behaviorArtifact, unlitArtifact } from "../helpers/artifacts";
import { landBirths, particlesOf } from "../helpers/internals";
import { fieldComponents, fieldOf } from "../helpers/slots";

// FXEmitter.applyRenderArtifact: a render-only structural edit (new shader, geometry, shadow flags)
// applied in place, without rebuilding the emitter or resetting live particles.
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
      landBirths(emitter);
      expect(emitter.particleCount).toBe(3);
      const mesh = particlesOf(emitter);
      const seedBefore = fieldOf(mesh, "fx_seed").slice();
      const previousMaterial = mesh.material;
      const previousGeometry = mesh.geometry.getAttribute("position");

      emitter.applyRenderArtifact(
        unlitArtifact({
          outputs: { albedo: "vec4(0.0, 1.0, 0.0, 1.0)" },
          geometry: { type: "primitive", primitive: "box" },
        }),
      );

      // Same emitter, same mesh instance, same live particles - only material/base geometry moved.
      expect(particlesOf(emitter)).toBe(mesh);
      expect(emitter.particleCount).toBe(3);
      expect(Array.from(fieldOf(mesh, "fx_seed"))).toEqual(Array.from(seedBefore));
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
      emitter.prewarm(1);
      expect(emitter.particleCount).toBe(2);
    } finally {
      emitter.destroy();
    }
  });

  it("builds and disposes a depth material when castShadow toggles on then off", () => {
    const emitter = FXEmitter.fromArtifacts(unlitArtifact(), behaviorArtifact({ lifetime: 5 }));
    try {
      const mesh = particlesOf(emitter);
      expect(mesh.customDepthMaterial).toBeUndefined();

      emitter.applyRenderArtifact(unlitArtifact(), { castShadow: true });
      expect(mesh.customDepthMaterial).toBeDefined();
      expect(mesh.castShadow).toBe(true);
      let depthDisposed = 0;
      (mesh.customDepthMaterial as Material).addEventListener("dispose", () => depthDisposed++);

      emitter.applyRenderArtifact(unlitArtifact(), { castShadow: false });
      expect(mesh.customDepthMaterial).toBeUndefined();
      expect(mesh.castShadow).toBe(false);
      // Disposed, not merely dropped.
      expect(depthDisposed).toBe(1);
    } finally {
      emitter.destroy();
    }
  });

  it("applies in place a render reading an attribute nothing writes, adding no buffer", () => {
    // The behavior writes no custom attribute, so the mesh holds exactly the two core buffers - and
    // keeps holding them (how the shader reads such an attribute: attributePackingIntegration).
    const emitter = FXEmitter.fromArtifacts(unlitArtifact(), behaviorArtifact({ lifetime: 5 }));
    try {
      const mesh = particlesOf(emitter);
      const materialBefore = mesh.material;
      const attributesBefore = Object.keys(mesh.geometry.attributes).sort();

      emitter.applyRenderArtifact(
        unlitArtifact({ attributeReads: [{ name: "glow", components: 1 }] }),
      );

      expect(particlesOf(emitter)).toBe(mesh);
      expect(mesh.material).not.toBe(materialBefore);
      expect(Object.keys(mesh.geometry.attributes).sort()).toEqual(attributesBefore);
      expect(fieldComponents(mesh, "fx_glow") !== undefined).toBe(false);
    } finally {
      emitter.destroy();
    }
  });

  it("rebinds the views to what the new render reads, leaving the particles as they are", () => {
    const seedRender = unlitArtifact({
      attributeReads: [{ name: "seed", components: 1 }],
      outputs: { albedo: "vec4(p_fx_seed)" },
    });
    const emitter = FXEmitter.fromArtifacts(
      seedRender,
      behaviorArtifact({
        lifetime: 5,
        attributes: [{ name: "seed", components: 1, value: [0.5] }],
      }),
    );
    try {
      emitter.burst(2);
      landBirths(emitter);
      const mesh = particlesOf(emitter);
      const views = (): number[] =>
        Object.keys(mesh.geometry.attributes)
          .filter((name) => name.startsWith("a_"))
          .sort()
          .map((name) => mesh.geometry.getAttribute(name).itemSize);
      // position, then lifecycle + seed.
      expect(views()).toEqual([3, 4]);

      emitter.applyRenderArtifact(unlitArtifact());
      // The seed is read no more: the lifecycle view ends before it.
      expect(views()).toEqual([3, 3]);
      expect(emitter.particleCount).toBe(2);
      expect(Array.from(fieldOf(mesh, "fx_seed").subarray(0, 2))).toEqual([0.5, 0.5]);

      emitter.applyRenderArtifact(seedRender);
      expect(views()).toEqual([3, 4]);
    } finally {
      emitter.destroy();
    }
  });

  it("rejects a render artifact reading a written attribute at another width", () => {
    const emitter = FXEmitter.fromArtifacts(
      unlitArtifact(),
      behaviorArtifact({ lifetime: 5, attributes: [{ name: "seed", components: 1 }] }),
    );
    try {
      const mesh = particlesOf(emitter);
      const materialBefore = mesh.material;

      expect(() =>
        emitter.applyRenderArtifact(
          unlitArtifact({ attributeReads: [{ name: "seed", components: 3 }] }),
        ),
      ).toThrow(/conflicting widths/);

      // Rejected in place: nothing about the live emitter changed.
      expect(mesh.material).toBe(materialBefore);
    } finally {
      emitter.destroy();
    }
  });
});

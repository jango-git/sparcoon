import { describe, expect, it } from "vitest";
import { PerspectiveCamera } from "three";
import { FXEmitter } from "../../src/emitter/FXEmitter";
import type { FXInstancedParticle } from "../../src/instancedParticle/FXInstancedParticle";
import { FX_POSITION_X, FX_POSITION_Z } from "../../src/coreLayout";
import { behaviorArtifact, unlitArtifact } from "../helpers/artifacts";

function meshOf(emitter: FXEmitter): FXInstancedParticle {
  return (emitter as unknown as { mesh: FXInstancedParticle }).mesh;
}

/** Invokes the private per-frame handler (ticks + runs the depth sort). */
function renderFrame(emitter: FXEmitter, dt: number): void {
  (emitter as unknown as { onRendering: (dt: number) => void }).onRendering(dt);
}

/** A behavior artifact: long lifetime, no motion, so positions stay put. */
function staticBehavior(): ReturnType<typeof behaviorArtifact> {
  return behaviorArtifact({ lifetime: 100 });
}

describe("FXEmitter depth sort respects the emitter transform (audit-4 E1)", () => {
  it("maps the camera into mesh-local space so a rotated emitter sorts back-to-front", () => {
    const emitter = FXEmitter.fromArtifacts(unlitArtifact(), staticBehavior(), {
      sortFraction: 1, // sort every frame
    });
    try {
      emitter.burst(2);
      expect(emitter.particleCount).toBe(2);

      // Two particles on the local z axis. Under the emitter's 180 degrees Y rotation,
      // local +z maps to world -z, so relative to a camera on world +z the
      // particle at local +z is the *far* one and must sort first (back-to-front).
      const position = meshOf(emitter).propertyBuffers.position.array;
      const itemSize = meshOf(emitter).propertyBuffers.position.itemSize;
      // Row 0: local z = +10 (far in world). Row 1: local z = -10 (near in world).
      position[0 * itemSize + FX_POSITION_Z] = 10;
      position[1 * itemSize + FX_POSITION_Z] = -10;

      // Rotate the emitter 180 degrees about Y and place the camera far on world +z.
      emitter.rotation.y = Math.PI;
      const camera = new PerspectiveCamera();
      camera.position.set(0, 0, 1000);
      camera.updateMatrixWorld();
      emitter.sortCamera = camera;

      renderFrame(emitter, 0); // dt=0: no aging/integration, positions preserved

      // Back-to-front => farthest (world) first. The local +z particle is farthest,
      // so it must now occupy row 0.
      expect(position[0 * itemSize + FX_POSITION_Z]).toBeCloseTo(10, 6);
      expect(position[1 * itemSize + FX_POSITION_Z]).toBeCloseTo(-10, 6);
      // The other components rode along with their row (sanity: no partial swap).
      expect(position[0 * itemSize + FX_POSITION_X]).toBeCloseTo(0, 6);
    } finally {
      emitter.destroy();
    }
  });

  it("sorts identically when the emitter is untransformed (regression guard)", () => {
    const emitter = FXEmitter.fromArtifacts(unlitArtifact(), staticBehavior(), {
      sortFraction: 1,
    });
    try {
      emitter.burst(2);
      const position = meshOf(emitter).propertyBuffers.position.array;
      const itemSize = meshOf(emitter).propertyBuffers.position.itemSize;
      position[0 * itemSize + FX_POSITION_Z] = 10; // near (closer to +z camera)
      position[1 * itemSize + FX_POSITION_Z] = -10; // far

      const camera = new PerspectiveCamera();
      camera.position.set(0, 0, 1000);
      camera.updateMatrixWorld();
      emitter.sortCamera = camera;

      renderFrame(emitter, 0);

      // No emitter transform: farthest from the +z camera (z = -10) sorts first.
      expect(position[0 * itemSize + FX_POSITION_Z]).toBeCloseTo(-10, 6);
      expect(position[1 * itemSize + FX_POSITION_Z]).toBeCloseTo(10, 6);
    } finally {
      emitter.destroy();
    }
  });

  it("sorts by world distance under non-uniform scale (shear-safe)", () => {
    const emitter = FXEmitter.fromArtifacts(unlitArtifact(), staticBehavior(), {
      sortFraction: 1,
    });
    try {
      emitter.burst(2);
      const position = meshOf(emitter).propertyBuffers.position.array;
      const itemSize = meshOf(emitter).propertyBuffers.position.itemSize;

      // Squash the z axis 10x. With the camera at world (0,0,100):
      //   A = local (0,0,1) -> world (0,0,0.1),  world dist^2 ~= 9980
      //   B = local (10,0,5) -> world (10,0,0.5), world dist^2 ~= 10000  (farther)
      // In world space B sorts first; a *local*-space approximation would misorder them.
      const writeRow = (row: number, x: number, z: number): void => {
        position[row * itemSize + FX_POSITION_X] = x;
        position[row * itemSize + 1] = 0;
        position[row * itemSize + FX_POSITION_Z] = z;
      };
      writeRow(0, 0, 1); // A
      writeRow(1, 10, 5); // B

      emitter.scale.set(1, 1, 0.1);
      const camera = new PerspectiveCamera();
      camera.position.set(0, 0, 100);
      camera.updateMatrixWorld();
      emitter.sortCamera = camera;

      renderFrame(emitter, 0);

      // Back-to-front: B (world-farthest) must occupy row 0.
      expect(position[0 * itemSize + FX_POSITION_X]).toBeCloseTo(10, 6);
      expect(position[0 * itemSize + FX_POSITION_Z]).toBeCloseTo(5, 6);
      expect(position[1 * itemSize + FX_POSITION_X]).toBeCloseTo(0, 6);
      expect(position[1 * itemSize + FX_POSITION_Z]).toBeCloseTo(1, 6);
    } finally {
      emitter.destroy();
    }
  });
});

import { describe, expect, it } from "vitest";
import { MeshBasicMaterial } from "three";
import { FXInstancedParticle } from "../../src/instancedParticle/FXInstancedParticle";
import { buildPrimitiveGeometry } from "../../src/instancedParticle/primitiveGeometry";
import { FX_AGE, FX_LIFETIME } from "../../src/coreLayout";
import { FLOAT_VARYING, VEC3_VARYING } from "../helpers/artifacts";

/** The core lifecycle buffer is a vec3 `[age, lifetime, id]`. */
const LIFECYCLE_STRIDE = 3;

/**
 * A mesh with the two fixed core buffers (position vec3 + lifecycle vec3) plus a
 * one-float `fx_seed` attribute buffer.
 */
function makeMesh(): FXInstancedParticle {
  return new FXInstancedParticle(
    {
      position: VEC3_VARYING,
      lifecycle: VEC3_VARYING,
      fx_seed: FLOAT_VARYING,
    },
    4,
    4,
    new MeshBasicMaterial(),
    buildPrimitiveGeometry("plane"),
  );
}

describe("FXInstancedParticle - attribute buffers", () => {
  it("compacts an attribute buffer alongside the core lifecycle buffer when a particle dies", () => {
    const mesh = makeMesh();
    mesh.createInstances(3);

    const lifecycle = mesh.propertyBuffers.lifecycle.array;
    const seed = mesh.propertyBuffers["fx_seed"].array;
    for (let i = 0; i < 3; i++) {
      lifecycle[i * LIFECYCLE_STRIDE + FX_LIFETIME] = 1;
      lifecycle[i * LIFECYCLE_STRIDE + FX_AGE] = 0;
      seed[i] = 10 + i;
    }
    lifecycle[1 * LIFECYCLE_STRIDE + FX_AGE] = 2; // particle 1 is dead (age >= lifetime)

    mesh.removeDeadParticles();

    expect(mesh.instanceCount).toBe(2);
    // Survivors copied down: old row 0 -> 0, old row 2 -> 1; the seed rides along.
    expect(seed[0]).toBe(10);
    expect(seed[1]).toBe(12);
  });
});

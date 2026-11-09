import { describe, expect, it } from "vitest";
import { MeshBasicMaterial, Vector3 } from "three";
import { FXInstancedParticle } from "../../src/instancedParticle/FXInstancedParticle";
import { buildPrimitiveGeometry } from "../../src/instancedParticle/primitiveGeometry";
import { FX_AGE, FX_LIFETIME, FX_POSITION_Z } from "../../src/coreLayout";
import { FLOAT_VARYING, VEC3_VARYING } from "../helpers/artifacts";

/** The core lifecycle buffer is a vec3 `[age, lifetime, id]`. */
const LIFECYCLE_STRIDE = 3;

/**
 * A ring of `capacity` slots with the two fixed core buffers (position vec3 + lifecycle vec3)
 * plus a one-float `fx_seed` attribute buffer.
 */
function makeMesh(capacity = 4): FXInstancedParticle {
  return new FXInstancedParticle(
    {
      position: VEC3_VARYING,
      lifecycle: VEC3_VARYING,
      fx_seed: FLOAT_VARYING,
    },
    capacity,
    new MeshBasicMaterial(),
    buildPrimitiveGeometry("plane"),
  );
}

/** Gives every slot in `[start, end)` the lifetime `lifetime` - what a spawn kernel would do. */
function seedLifetime(mesh: FXInstancedParticle, start: number, end: number, lifetime = 1): void {
  const lifecycle = mesh.propertyBuffers.lifecycle.array;
  for (let i = start; i < end; i++) {
    lifecycle[i * LIFECYCLE_STRIDE + FX_LIFETIME] = lifetime;
  }
}

describe("FXInstancedParticle - fixed-capacity ring", () => {
  it("claims contiguous slots at the cursor and draws up to the high-water mark", () => {
    const mesh = makeMesh();
    expect(mesh.claim(3)).toEqual([{ start: 0, count: 3 }]);
    expect(mesh.instanceCount).toBe(3);
    expect(mesh.liveCount).toBe(3);
    expect(mesh.instanceCapacity).toBe(4);
  });

  it("splits a claim that wraps past the end into two runs", () => {
    const mesh = makeMesh();
    mesh.claim(3);
    seedLifetime(mesh, 0, 3);
    // Slots 0..2 die; the next claim of 3 runs 3..3 then wraps onto 0..1.
    mesh.advanceAges(2);
    expect(mesh.claim(3)).toEqual([
      { start: 3, count: 1 },
      { start: 0, count: 2 },
    ]);
    expect(mesh.instanceCount).toBe(4);
    expect(mesh.overflowCount).toBe(0);
  });

  it("never moves a particle when another one dies - a slot is held for life", () => {
    const mesh = makeMesh();
    mesh.claim(3);
    seedLifetime(mesh, 0, 3);
    const seed = mesh.propertyBuffers["fx_seed"].array;
    seed[0] = 10;
    seed[1] = 11;
    seed[2] = 12;
    mesh.propertyBuffers.lifecycle.array[1 * LIFECYCLE_STRIDE + FX_AGE] = 5; // slot 1 dies

    mesh.advanceAges(0.1);

    expect(mesh.liveCount).toBe(2);
    expect(mesh.instanceCount).toBe(3); // the dead slot is still drawn (the shader hides it)
    expect([seed[0], seed[1], seed[2]]).toEqual([10, 11, 12]);
  });

  it("zeroes a reused slot so a birth never inherits its previous occupant's age", () => {
    const mesh = makeMesh(2);
    mesh.claim(2);
    seedLifetime(mesh, 0, 2);
    mesh.propertyBuffers["fx_seed"].array[0] = 7;
    mesh.advanceAges(3); // both dead, age 3

    mesh.claim(1);
    const lifecycle = mesh.propertyBuffers.lifecycle.array;
    expect(lifecycle[0 * LIFECYCLE_STRIDE + FX_AGE]).toBe(0);
    expect(mesh.propertyBuffers["fx_seed"].array[0]).toBe(0);
  });

  it("counts overwritten live particles and births beyond capacity as overflow", () => {
    const mesh = makeMesh();
    mesh.claim(4);
    seedLifetime(mesh, 0, 4);
    expect(mesh.overflowCount).toBe(0);

    // Ring full of live particles: two more births overwrite slots 0..1.
    expect(mesh.claim(2)).toEqual([{ start: 0, count: 2 }]);
    expect(mesh.overflowCount).toBe(2);
    expect(mesh.liveCount).toBe(4);

    // A burst larger than the ring seeds every slot once from the cursor; the rest are lost.
    seedLifetime(mesh, 0, 4);
    expect(mesh.claim(6)).toEqual([
      { start: 2, count: 2 },
      { start: 0, count: 2 },
    ]);
    expect(mesh.overflowCount).toBe(2 + 2 + 4);
  });

  it("drop() kills every particle at once and rewinds the cursor, keeping the overflow tally", () => {
    const mesh = makeMesh();
    mesh.claim(4);
    seedLifetime(mesh, 0, 4);
    mesh.claim(1); // one overflow

    mesh.drop();

    expect(mesh.liveCount).toBe(0);
    expect(mesh.instanceCount).toBe(0);
    expect(mesh.overflowCount).toBe(1);
    expect(mesh.claim(1)).toEqual([{ start: 0, count: 1 }]);
    expect(mesh.overflowCount).toBe(1);
  });

  it("sorting gathers the live particles in front and restarts the cursor right after them", () => {
    const mesh = makeMesh();
    mesh.claim(4);
    seedLifetime(mesh, 0, 4);
    const position = mesh.propertyBuffers.position.array;
    for (let i = 0; i < 4; i++) {
      position[i * 3 + FX_POSITION_Z] = i; // slot i at z = i
    }
    mesh.propertyBuffers.lifecycle.array[1 * LIFECYCLE_STRIDE + FX_AGE] = 5; // slot 1 dies
    mesh.advanceAges(0);

    mesh.sortByDistance(new Vector3(0, 0, -10));

    // Back to front from a camera at z = -10: z 3, 2, 0; the dead slot goes behind them all.
    expect([position[0 * 3 + 2], position[1 * 3 + 2], position[2 * 3 + 2]]).toEqual([3, 2, 0]);
    expect(mesh.instanceCount).toBe(3);
    expect(mesh.claim(1)).toEqual([{ start: 3, count: 1 }]);
    expect(mesh.overflowCount).toBe(0);
  });
});

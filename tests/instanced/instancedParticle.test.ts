import { type InterleavedBufferAttribute, MeshBasicMaterial, Vector3 } from "three";
import { describe, expect, it } from "vitest";

import { FX_AGE, FX_LIFETIME, FX_POSITION_Z } from "../../src/coreLayout";
import { FXInstancedParticle } from "../../src/instancedParticle/FXInstancedParticle";
import { slotLayout } from "../../src/instancedParticle/FXParticleSlot";
import { buildPrimitiveGeometry } from "../../src/instancedParticle/primitiveGeometry";
import { packConsecutive } from "../../src/render/FXAttributePacking";
import { allViews, fieldOf, setField } from "../helpers/slots";

/**
 * A ring of `capacity` slots with the two fixed core fields (position vec3 + lifecycle vec3
 * `[age, lifetime, id]`) plus a one-float `fx_seed` attribute, interleaved.
 */
const SLOT = slotLayout([
  { name: "position", components: 3 },
  { name: "lifecycle", components: 3 },
  { name: "fx_seed", components: 1 },
]);

function makeMesh(capacity = 4): FXInstancedParticle {
  return new FXInstancedParticle(
    SLOT,
    allViews(SLOT),
    capacity,
    new MeshBasicMaterial(),
    buildPrimitiveGeometry("plane"),
  );
}

/** Gives every slot in `[start, end)` the lifetime `lifetime` - what a spawn kernel would do. */
function seedLifetime(mesh: FXInstancedParticle, start: number, end: number, lifetime = 1): void {
  for (let i = start; i < end; i++) {
    setField(mesh, "lifecycle", i, FX_LIFETIME, lifetime);
  }
}

const setAge = (mesh: FXInstancedParticle, slot: number, age: number): void => {
  setField(mesh, "lifecycle", slot, FX_AGE, age);
};

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
    setField(mesh, "fx_seed", 0, 0, 10);
    setField(mesh, "fx_seed", 1, 0, 11);
    setField(mesh, "fx_seed", 2, 0, 12);
    setAge(mesh, 1, 5); // slot 1 dies

    mesh.advanceAges(0.1);
    const seed = fieldOf(mesh, "fx_seed");

    expect(mesh.liveCount).toBe(2);
    expect(mesh.instanceCount).toBe(3); // the dead slot is still drawn (the shader hides it)
    expect([seed[0], seed[1], seed[2]]).toEqual([10, 11, 12]);
  });

  it("reports a death by the liveness captured before the update, so a kill counts", () => {
    const mesh = makeMesh();
    mesh.claim(3);
    seedLifetime(mesh, 0, 3);
    setAge(mesh, 2, 5); // slot 2 is already dead before the tick
    const deaths: number[] = [];

    mesh.captureLiveness();
    setAge(mesh, 0, 1); // the update kills slot 0: age = lifetime
    mesh.advanceAges(0.1, (slot) => deaths.push(slot));

    expect(deaths).toEqual([0]);
    expect(mesh.liveCount).toBe(1);
  });

  it("refuses to report deaths without a liveness capture before the update", () => {
    const mesh = makeMesh();
    mesh.claim(1);
    seedLifetime(mesh, 0, 1);
    expect(() => mesh.advanceAges(0.1, () => undefined)).toThrow(/captureLiveness/);
  });

  it("zeroes a reused slot so a birth never inherits its previous occupant's age", () => {
    const mesh = makeMesh(2);
    mesh.claim(2);
    seedLifetime(mesh, 0, 2);
    setField(mesh, "fx_seed", 0, 0, 7);
    mesh.advanceAges(3); // both dead, age 3

    mesh.claim(1);
    expect(fieldOf(mesh, "lifecycle")[0 * 3 + FX_AGE]).toBe(0);
    expect(fieldOf(mesh, "fx_seed")[0]).toBe(0);
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
    for (let i = 0; i < 4; i++) {
      setField(mesh, "position", i, FX_POSITION_Z, i); // slot i at z = i
      setField(mesh, "fx_seed", i, 0, i);
    }
    setAge(mesh, 1, 5); // slot 1 dies
    mesh.advanceAges(0);

    mesh.sortByDistance(new Vector3(0, 0, -10));
    const position = fieldOf(mesh, "position");

    // Back to front from a camera at z = -10: z 3, 2, 0; the dead slot goes behind them all.
    expect([position[0 * 3 + 2], position[1 * 3 + 2], position[2 * 3 + 2]]).toEqual([3, 2, 0]);
    // Every field moves with its particle, not the position alone.
    expect(Array.from(fieldOf(mesh, "fx_seed").subarray(0, 3))).toEqual([3, 2, 0]);
    expect(mesh.instanceCount).toBe(3);
    expect(mesh.claim(1)).toEqual([{ start: 3, count: 1 }]);
    expect(mesh.overflowCount).toBe(0);
  });

  it("binds the slot through its packed views, one interleaved buffer", () => {
    const mesh = makeMesh();
    // [position, lifecycle, fx_seed] as declared: position alone, then lifecycle + seed as a vec4.
    const names = Object.keys(mesh.geometry.attributes).filter((name) => name.startsWith("a_"));
    expect(names.sort()).toEqual(["a_pack0", "a_pack1"]);
  });

  it("replaces its views in place, leaving no stale one and the slots untouched", () => {
    const mesh = makeMesh();
    mesh.claim(1);
    setField(mesh, "fx_seed", 0, 0, 7);
    const buffer = (mesh.geometry.getAttribute("a_pack1") as InterleavedBufferAttribute).data;
    // A render reading only the core fields: lifecycle no longer shares a view with the seed.
    const coreOnly = packConsecutive(SLOT.fields, (index) => `pack${String(index)}`, {
      reads: (name) => name !== "fx_seed",
    });
    mesh.replaceMaterialAndBaseGeometry(
      new MeshBasicMaterial(),
      buildPrimitiveGeometry("plane"),
      coreOnly,
    );
    const pack1 = mesh.geometry.getAttribute("a_pack1") as InterleavedBufferAttribute;
    expect(pack1.itemSize).toBe(3);
    expect(pack1.data).toBe(buffer);
    expect(fieldOf(mesh, "fx_seed")[0]).toBe(7);

    mesh.replaceMaterialAndBaseGeometry(new MeshBasicMaterial(), buildPrimitiveGeometry("plane"), [
      coreOnly[0],
    ]);
    const names = Object.keys(mesh.geometry.attributes).filter((name) => name.startsWith("a_"));
    expect(names).toEqual(["a_pack0"]);
  });

  it("refuses a slot without both core fields", () => {
    expect(
      () =>
        new FXInstancedParticle(
          slotLayout([{ name: "position", components: 3 }]),
          [],
          1,
          new MeshBasicMaterial(),
          buildPrimitiveGeometry("plane"),
        ),
    ).toThrow(/lifecycle/);
  });
});

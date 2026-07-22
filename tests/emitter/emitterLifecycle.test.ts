import { describe, expect, it } from "vitest";
import type { Material } from "three";
import { FXEmitter } from "../../src/emitter/FXEmitter";
import { FXWorld } from "../../src/world/FXWorld";
import type { FXInstancedParticle } from "../../src/instancedParticle/FXInstancedParticle";
import { buildPrimitiveGeometry } from "../../src/instancedParticle/primitiveGeometry";
import { FX_AGE, FX_ID, FX_LIFETIME } from "../../src/coreLayout";
import { behaviorArtifact, unlitArtifact } from "../helpers/artifacts";

function meshOf(emitter: FXEmitter): FXInstancedParticle {
  return (emitter as unknown as { mesh: FXInstancedParticle }).mesh;
}

/** A plain emitter: flat-white render, a spawn that seeds lifetime 4. */
function plainEmitter(options?: Parameters<typeof FXEmitter.fromArtifacts>[2]): FXEmitter {
  return FXEmitter.fromArtifacts(unlitArtifact(), behaviorArtifact({ lifetime: 4 }), options);
}

describe("FXEmitter.destroy releases GPU resources (audit-3 R4)", () => {
  it("dispatches dispose on the geometry and the mounted material exactly once", () => {
    const emitter = plainEmitter();
    const mesh = meshOf(emitter);
    let geometryDisposed = 0;
    let materialDisposed = 0;
    mesh.geometry.addEventListener("dispose", () => geometryDisposed++);
    (mesh.material as Material).addEventListener("dispose", () => materialDisposed++);

    emitter.destroy();
    expect(geometryDisposed).toBe(1);
    expect(materialDisposed).toBe(1);
  });

  it("does not throw on a double destroy", () => {
    const emitter = plainEmitter();
    emitter.destroy();
    expect(() => emitter.destroy()).not.toThrow();
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
});

describe("post-destroy lifecycle guards (audit-3 R7)", () => {
  it("no-ops scheduling after destroy", () => {
    const emitter = plainEmitter();
    emitter.destroy();

    expect(emitter.burst(5)).toBe(-1);
    expect(emitter.particleCount).toBe(0);
    expect(emitter.play(10)).toBe(-1);
    expect(emitter.stop()).toBe(false);
  });
});

describe("update-only artifact guard (audit-3 R8)", () => {
  it("fails fast at construction for a behavior artifact with no spawn function", () => {
    // A particle emitter's whole job is seeding births, so an update-only artifact
    // (no spawn) can never drive one - refused at construction, not in the frame tick.
    expect(() =>
      FXEmitter.fromArtifacts(unlitArtifact(), behaviorArtifact({ noSpawn: true })),
    ).toThrow(/cannot seed births \(update-only\)/);
  });
});

describe("respawn into reused buffer rows (audit-4 B1)", () => {
  function tick(emitter: FXEmitter, deltaTime: number): void {
    (emitter as unknown as { tick(dt: number): void }).tick(deltaTime);
  }

  function lifecycleAt(emitter: FXEmitter, row: number, offset: number): number {
    const { array, itemSize } = meshOf(emitter).propertyBuffers.lifecycle;
    return array[row * itemSize + offset];
  }

  it("a second burst into rows freed by dead particles starts them at age 0, not the previous occupant's age", () => {
    const emitter = plainEmitter();
    try {
      // First burst into a freshly zeroed capacity - the one case that was already correct.
      emitter.burst(2);
      expect(emitter.particleCount).toBe(2);
      // The spawn seeds lifetime = 4; age starts at 0.
      expect(lifecycleAt(emitter, 0, FX_LIFETIME)).toBe(4);
      expect(lifecycleAt(emitter, 0, FX_AGE)).toBe(0);

      // Age past lifetime so both particles die and their rows are compacted away.
      tick(emitter, 5);
      expect(emitter.particleCount).toBe(0);

      // Second burst reuses rows 0..1 - which still hold age >= lifetime from the dead
      // occupants unless createInstances zeroes them. No spawn can reset age, so a stale
      // age is unrecoverable.
      emitter.burst(2);
      expect(emitter.particleCount).toBe(2);
      expect(lifecycleAt(emitter, 0, FX_AGE)).toBe(0);
      expect(lifecycleAt(emitter, 1, FX_AGE)).toBe(0);

      // Before the fix these were born with age ~5 >= lifetime 4 and the very next
      // tick culled them straight back to zero.
      tick(emitter, 0.01);
      expect(emitter.particleCount).toBe(2);
    } finally {
      emitter.destroy();
    }
  });
});

describe("per-particle id (JS/CPU backend, host-owned like age)", () => {
  function tick(emitter: FXEmitter, deltaTime: number): void {
    (emitter as unknown as { tick(dt: number): void }).tick(deltaTime);
  }

  function lifecycleAt(emitter: FXEmitter, row: number, offset: number): number {
    const { array, itemSize } = meshOf(emitter).propertyBuffers.lifecycle;
    return array[row * itemSize + offset];
  }

  it("assigns each newly spawned particle a monotonically increasing id, never reused across bursts", () => {
    const emitter = plainEmitter();
    try {
      emitter.burst(3);
      expect(lifecycleAt(emitter, 0, FX_ID)).toBe(0);
      expect(lifecycleAt(emitter, 1, FX_ID)).toBe(1);
      expect(lifecycleAt(emitter, 2, FX_ID)).toBe(2);

      emitter.burst(2);
      expect(lifecycleAt(emitter, 3, FX_ID)).toBe(3);
      expect(lifecycleAt(emitter, 4, FX_ID)).toBe(4);
    } finally {
      emitter.destroy();
    }
  });

  it("keeps a surviving particle's own id when an earlier row's death compacts it down", () => {
    const emitter = plainEmitter();
    try {
      emitter.burst(3); // ids 0, 1, 2 at rows 0, 1, 2
      const { array, itemSize } = meshOf(emitter).propertyBuffers.lifecycle;
      // Force row 0 alone to die - the fixture's fixed lifetime (4) would otherwise kill all
      // three together.
      array[0 * itemSize + FX_AGE] = 100;
      tick(emitter, 0.01);

      expect(emitter.particleCount).toBe(2);
      // Compaction copies surviving rows 1/2 down over the dead row 0 - each id travels with
      // its own row.
      expect(lifecycleAt(emitter, 0, FX_ID)).toBe(1);
      expect(lifecycleAt(emitter, 1, FX_ID)).toBe(2);
    } finally {
      emitter.destroy();
    }
  });

  it("does not reset the id counter on reset() - a stop/replay must not reissue ids already handed out", () => {
    const emitter = plainEmitter();
    try {
      emitter.burst(2); // ids 0, 1
      emitter.reset();
      expect(emitter.particleCount).toBe(0);

      emitter.burst(1);
      expect(lifecycleAt(emitter, 0, FX_ID)).toBe(2);
    } finally {
      emitter.destroy();
    }
  });
});

describe("sortFraction validation (audit-3 R9 / E8)", () => {
  it("clamps sortFraction above 1 to 1", () => {
    const emitter = plainEmitter({ sortFraction: 5 });
    try {
      expect(emitter.sortFraction).toBe(1);
    } finally {
      emitter.destroy();
    }
  });
});

/** Drives one private tick on `emitter` with the given dt. */
function tickEmitter(emitter: FXEmitter, dt: number): void {
  (emitter as unknown as { tick(deltaTime: number): void }).tick(dt);
}

describe("emitter runtime fixes (audit-4 E3/E4/E6/E10)", () => {
  it("play() emits the final partial tick that lands inside duration (E3)", () => {
    const emitter = plainEmitter();
    try {
      // play(100/s, duration 0.05s). A 0.5s dt spike overshoots the duration; the play
      // is removed this tick, but the 0.05s slice inside it still emits rate*0.05 = 5.
      emitter.play(100, { duration: 0.05 });
      tickEmitter(emitter, 0.5);
      expect(emitter.particleCount).toBe(5);
    } finally {
      emitter.destroy();
    }
  });

  it("burst rejects a fractional count (E4)", () => {
    const emitter = plainEmitter();
    try {
      expect(() => emitter.burst(2.5)).toThrow(/integer/);
    } finally {
      emitter.destroy();
    }
  });

  it("prewarm and reset no-op after destroy (E6)", () => {
    const emitter = plainEmitter();
    emitter.destroy();
    expect(() => emitter.prewarm(1)).not.toThrow();
    expect(() => emitter.reset()).not.toThrow();
    expect(emitter.particleCount).toBe(0);
  });

  it("wraps the shared u_time clock so it never grows unbounded (E10)", () => {
    const world = new FXWorld();
    const clock = world as unknown as { elapsedTime: number };
    const period = 573 * 2 * Math.PI;
    // Advance well past the ~1 hour wrap period (400 * 10s = 4000s > period).
    for (let i = 0; i < 400; i++) {
      world.update(10);
    }
    expect(clock.elapsedTime).toBeGreaterThanOrEqual(0);
    expect(clock.elapsedTime).toBeLessThan(period);
  });
});

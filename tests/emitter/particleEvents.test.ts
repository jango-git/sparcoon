import { afterEach, describe, expect, it } from "vitest";

import type {
  FXBehaviorArtifact,
  FXEmitterTransform,
  FXInheritLayout,
} from "../../src/artifact/FXArtifact";
import {
  FX_AGE,
  FX_CORE_LIFECYCLE,
  FX_CORE_LIFECYCLE_STRIDE,
  FX_CORE_POSITION,
  FX_ID,
  FX_LIFETIME,
} from "../../src/coreLayout";
import { connectReaction, fireSpawnAction } from "../../src/effect/FXSpawnAction";
import { FXEmitter } from "../../src/emitter/FXEmitter";
import type { FXParticleEvent, FXParticleEventKind } from "../../src/emitter/FXEmitter.Internal";
import { FXWorld } from "../../src/world/FXWorld";
import { killingBehavior, placingBehavior, unlitArtifact } from "../helpers/artifacts";
import { landBirths } from "../helpers/internals";
import { fieldBehavior } from "../helpers/slots";

const worlds: FXWorld[] = [];

function newWorld(): FXWorld {
  const world = new FXWorld();
  worlds.push(world);
  return world;
}

afterEach(() => {
  for (const world of worlds.splice(0)) {
    world.dispose();
  }
});

function emitterIn(world: FXWorld, behavior: FXBehaviorArtifact, capacity = 16): FXEmitter {
  return FXEmitter.fromArtifacts(unlitArtifact(), behavior, { expectedCapacity: capacity }, world);
}

/** Copies each `kind` event out of the reused object the listener receives. */
function collectEvents(emitter: FXEmitter, kind: FXParticleEventKind): FXParticleEvent[] {
  const events: FXParticleEvent[] = [];
  emitter.onParticleEvent(kind, (event) => {
    events.push({
      position: [...event.position],
      velocity: [...event.velocity],
      slot: event.slot.slice(),
    });
  });
  return events;
}

function collectDeaths(emitter: FXEmitter): FXParticleEvent[] {
  return collectEvents(emitter, "death");
}

describe('FXEmitter.onParticleEvent("death")', () => {
  it("reports each death once, after the world ticked, where it died and how it moved", () => {
    const world = newWorld();
    const emitter = emitterIn(world, placingBehavior(0.25));
    const deaths = collectDeaths(emitter);
    emitter.burst(1);
    world.update(0.1); // born at x 0
    world.update(0.1); // age 0.1, x 0.2
    world.update(0.1); // age 0.2, x 0.4
    expect(deaths).toEqual([]);
    world.update(0.1); // updated to x 0.6, then aged to 0.3 >= 0.25: dies
    expect(deaths).toHaveLength(1);
    expect(deaths[0].position[0]).toBeCloseTo(0.6, 5);
    expect(deaths[0].velocity[0]).toBeCloseTo(2, 4);
    expect(deaths[0].velocity[1]).toBe(0);
    world.update(0.1);
    expect(deaths).toHaveLength(1);
  });

  it("reports a particle its update kills, once, where it was killed", () => {
    const world = newWorld();
    const emitter = emitterIn(world, killingBehavior(10, 0.4));
    const deaths = collectDeaths(emitter);
    emitter.burst(1);
    world.update(0.1); // born at x 0
    world.update(0.1); // x 0.2
    expect(deaths).toEqual([]);
    world.update(0.1); // x 0.4: killed long before its lifetime of 10
    expect(deaths).toHaveLength(1);
    expect(deaths[0].position[0]).toBeCloseTo(0.4, 5);
    expect(deaths[0].velocity[0]).toBeCloseTo(2, 4);
    expect(emitter.particleCount).toBe(0);
    world.update(0.1); // still dead: the update kills it again, but it is not a death again
    expect(deaths).toHaveLength(1);
  });

  it("hands deaths out after every emitter of the world ticked", () => {
    const world = newWorld();
    const emitter = emitterIn(world, placingBehavior(0.05));
    const seen: number[] = [];
    // A second object ticking after the emitter: the death must not have reached the listener yet.
    world.registerObject({
      onWorldTick: () => {
        seen.push(-1);
      },
      destroy: () => undefined,
    });
    emitter.onParticleEvent("death", () => {
      seen.push(1);
    });
    emitter.burst(1);
    world.update(0.1); // born
    world.update(0.1); // dies
    expect(seen).toEqual([-1, -1, 1]);
  });

  it("does not count a particle a full ring overwrites, nor ones reset() clears", () => {
    const world = newWorld();
    const emitter = emitterIn(world, placingBehavior(10), 2);
    const deaths = collectDeaths(emitter);
    emitter.burst(2);
    world.update(0.1);
    emitter.burst(2); // overwrites both live particles
    world.update(0.1);
    emitter.reset();
    world.update(0.1);
    expect(deaths).toEqual([]);
  });

  it("drops the deaths of the past prewarm() simulates", () => {
    const world = newWorld();
    const emitter = emitterIn(world, placingBehavior(0.05));
    const deaths = collectDeaths(emitter);
    emitter.burst(1);
    landBirths(emitter);
    emitter.prewarm(0.5); // the particle dies inside the simulated past
    world.update(0.1);
    expect(deaths).toEqual([]);
  });

  it("drops the deaths a reset() lands on before they are handed out", () => {
    const world = newWorld();
    const emitter = emitterIn(world, placingBehavior(0.05));
    const deaths = collectDeaths(emitter);
    let resetOnTick = false;
    // Ticks after the emitter, so it resets it between its deaths and their hand-out.
    world.registerObject({
      onWorldTick: () => {
        if (resetOnTick) {
          emitter.reset();
        }
      },
      destroy: () => undefined,
    });
    emitter.burst(1);
    world.update(0.1); // born
    resetOnTick = true;
    world.update(0.1); // dies, then the reset drops the death
    expect(deaths).toEqual([]);
  });

  it("stops handing out a tick's deaths once a listener resets the emitter", () => {
    const world = newWorld();
    const emitter = emitterIn(world, placingBehavior(0.05));
    let calls = 0;
    emitter.onParticleEvent("death", () => {
      calls += 1;
      emitter.reset();
    });
    emitter.burst(3);
    world.update(0.1); // born
    world.update(0.1); // all three die; the first listener call drops the other two
    expect(calls).toBe(1);
  });

  it("never hands a death out again after a listener threw on it", () => {
    const world = newWorld();
    const emitter = emitterIn(world, placingBehavior(0.05));
    let calls = 0;
    emitter.onParticleEvent("death", () => {
      calls += 1;
      throw new Error("listener failed");
    });
    emitter.burst(1);
    world.update(0.1); // born
    expect(() => world.update(0.1)).toThrow(/listener failed/); // dies
    expect(() => world.update(0.1)).not.toThrow();
    expect(calls).toBe(1);
  });

  it("stops reporting once the last listener detached, even from inside a dispatch", () => {
    const world = newWorld();
    const emitter = emitterIn(world, placingBehavior(0.05));
    let calls = 0;
    const detach = emitter.onParticleEvent("death", () => {
      calls += 1;
      detach();
    });
    emitter.burst(2);
    world.update(0.1);
    world.update(0.1); // both die; the snapshot of listeners still sees both deaths
    expect(calls).toBe(2);
    emitter.burst(1);
    world.update(0.1);
    world.update(0.1);
    expect(calls).toBe(2);
  });
});

describe("death reactions", () => {
  it("bursts the target from where the source's particle died, at its velocity", () => {
    // When the burst lands is FXEffect's death-reaction test; this one checks the pose it spawns
    // from.
    const world = newWorld();
    const poses: FXEmitterTransform[] = [];
    const target = emitterIn(world, placingBehavior(10, poses));
    const source = emitterIn(world, placingBehavior(0.15));
    connectReaction(source, "death", target, { kind: "burst", count: 3 });
    source.burst(1);
    world.update(0.1); // born
    world.update(0.1); // age 0.1, x 0.2
    world.update(0.1); // x 0.4, then aged to 0.2 >= 0.15: dies
    world.update(0.1);
    expect(poses).toHaveLength(1);
    expect(poses[0].worldMatrix[12]).toBeCloseTo(0.4, 5);
    expect(poses[0].velocity[0]).toBeCloseTo(2, 4);
  });

  it("refuses a play without end: one per death would pile up", () => {
    const world = newWorld();
    const source = emitterIn(world, placingBehavior(1));
    const target = emitterIn(world, placingBehavior(1));
    expect(() =>
      connectReaction(source, "death", target, { kind: "play", rate: 10, duration: 0 }),
    ).toThrow(/finite duration/);
  });

  it("refuses a play over distance: it spawns from where the particle died, which does not move", () => {
    const world = newWorld();
    const source = emitterIn(world, placingBehavior(1));
    const target = emitterIn(world, placingBehavior(1));
    expect(() =>
      connectReaction(source, "death", target, {
        kind: "play",
        rate: 10,
        duration: 1,
        over: "distance",
      }),
    ).toThrow(/over distance/);
  });

  it("fires a zero count or rate as a no-op rather than throwing", () => {
    const world = newWorld();
    const target = emitterIn(world, placingBehavior(1));
    expect(() => {
      fireSpawnAction(target, { kind: "burst", count: 0 });
      fireSpawnAction(target, { kind: "play", rate: 0, duration: 1 });
    }).not.toThrow();
    world.update(0.1);
    expect(target.particleCount).toBe(0);
  });
});

/**
 * A behavior whose newborns live `lifetime` and get a `tag` of `firstTag` plus their birth's id,
 * recording each spawn call's `inherited` values into `inherits` (one entry per call).
 */
function taggingBehavior(
  lifetime: number,
  options: {
    firstTag?: number;
    inherit?: FXInheritLayout;
    inherits?: number[][];
  } = {},
): FXBehaviorArtifact {
  const firstTag = options.firstTag ?? 0;
  return fieldBehavior({
    buffers: [
      { name: FX_CORE_POSITION, stride: 3 },
      { name: FX_CORE_LIFECYCLE, stride: FX_CORE_LIFECYCLE_STRIDE },
      { name: "tag", stride: 2 },
    ],
    ...(options.inherit === undefined ? {} : { inherit: options.inherit }),
    spawn(fields, start, count, _bindings, _emitter, inherited): void {
      options.inherits?.push([...inherited]);
      const lifecycle = fields[FX_CORE_LIFECYCLE];
      for (let i = start; i < start + count; i++) {
        const row = i * FX_CORE_LIFECYCLE_STRIDE;
        lifecycle[row + FX_LIFETIME] = lifetime;
        fields.tag[i * 2] = firstTag + lifecycle[row + FX_ID];
        fields.tag[i * 2 + 1] = -1;
      }
    },
  });
}

// The slot taggingBehavior lays out: position 0..2, lifecycle 3..5, tag 6..7.
const TAG_OFFSET = 6;
const LIFETIME_OFFSET = 3 + FX_LIFETIME;
const AGE_OFFSET = 3 + FX_AGE;

describe("a death's slot", () => {
  it("is the whole slot as the particle died, taken before a birth of the same tick claims it", () => {
    const world = newWorld();
    // One slot: the burst landing in the tick the first particle dies overwrites it.
    const emitter = emitterIn(world, taggingBehavior(0.15, { firstTag: 10 }), 1);
    const deaths = collectDeaths(emitter);
    emitter.burst(1);
    world.update(0.1); // id 0 born, tag 10
    emitter.burst(1);
    world.update(0.1); // id 0 ages to 0.1; id 1 overwrites it: no death
    world.update(0.1); // id 1 ages to 0.1
    emitter.burst(1);
    world.update(0.1); // id 1 dies of age, then id 2 claims its slot in the same tick
    expect(deaths).toHaveLength(1);
    expect([...deaths[0].slot.subarray(TAG_OFFSET)]).toEqual([11, -1]);
    expect(deaths[0].slot[LIFETIME_OFFSET]).toBeCloseTo(0.15, 6);
    expect(emitter.particleSlot.stride).toBe(deaths[0].slot.length);
  });
});

describe("inheritance", () => {
  const inherit: FXInheritLayout = { stride: 3, defaults: [7, 8, 9] };

  function linked(copies: readonly number[]): {
    world: FXWorld;
    source: FXEmitter;
    inherits: number[][];
  } {
    const world = newWorld();
    const inherits: number[][] = [];
    const target = emitterIn(world, taggingBehavior(10, { inherit, inherits }));
    const source = emitterIn(world, taggingBehavior(0.05, { firstTag: 20 }));
    connectReaction(source, "death", target, { kind: "burst", count: 2 }, copies);
    return { world, source, inherits };
  }

  it("hands a reaction's births what its copies take of the dying particle, the rest defaults", () => {
    const { world, source, inherits } = linked([TAG_OFFSET, 1, 2]);
    source.burst(1);
    world.update(0.1); // born, tag [20, -1]
    world.update(0.1); // dies
    expect(inherits).toEqual([]);
    world.update(0.1); // the reaction's burst lands: one spawn call for both births
    expect(inherits).toEqual([[7, 20, -1]]);
  });

  it("hands each death its own values", () => {
    const { world, source, inherits } = linked([TAG_OFFSET, 0, 1]);
    source.burst(2);
    world.update(0.1); // ids 0 and 1 born, tags 20 and 21
    world.update(0.1); // both die
    world.update(0.1);
    expect(inherits).toEqual([
      [20, 8, 9],
      [21, 8, 9],
    ]);
  });

  it("gives a birth no death spawned the defaults: a host's burst, with or without an origin", () => {
    const world = newWorld();
    const inherits: number[][] = [];
    const emitter = emitterIn(world, taggingBehavior(10, { inherit, inherits }));
    emitter.burst(1);
    emitter.burst(1, { origin: { position: [1, 0, 0] } });
    emitter.burst(1, { origin: { position: [2, 0, 0], inherited: [1, 2, 3] } });
    world.update(0.1);
    expect(inherits).toEqual([
      [7, 8, 9],
      [7, 8, 9],
      [1, 2, 3],
    ]);
  });

  it("keeps a play's inherited values for its whole duration, copied at the call", () => {
    const world = newWorld();
    const inherits: number[][] = [];
    const emitter = emitterIn(world, taggingBehavior(10, { inherit, inherits }));
    const values = [1, 2, 3];
    emitter.play(10, { duration: 0.3, origin: { position: [0, 0, 0], inherited: values } });
    values[0] = 100;
    world.update(0.1);
    world.update(0.1);
    world.update(0.1);
    // One spawn call per tick that emits; how many emit is the play's own arithmetic.
    expect(inherits.length).toBeGreaterThan(1);
    expect(new Set(inherits.map((values) => values.join()))).toEqual(new Set(["1,2,3"]));
  });

  it("refuses inherited values of another length than the defaults", () => {
    const world = newWorld();
    const emitter = emitterIn(world, taggingBehavior(10, { inherit }));
    expect(() => emitter.burst(1, { origin: { position: [0, 0, 0], inherited: [1, 2] } })).toThrow(
      /inherited: expected 3 values/,
    );
  });

  it("refuses an inherit layout whose defaults are not as long as its stride", () => {
    const world = newWorld();
    expect(() =>
      emitterIn(world, taggingBehavior(10, { inherit: { stride: 2, defaults: [1] } })),
    ).toThrow(/defaults: expected 2 values/);
  });

  it("refuses copies outside the source's slot or the target's layout, or not whole triples", () => {
    const world = newWorld();
    const target = emitterIn(world, taggingBehavior(10, { inherit }));
    const source = emitterIn(world, taggingBehavior(1));
    const action = { kind: "burst", count: 1 } as const;
    expect(() => connectReaction(source, "death", target, action, [TAG_OFFSET, 0])).toThrow(
      /triples/,
    );
    expect(() => connectReaction(source, "death", target, action, [TAG_OFFSET, 0, 3])).toThrow(
      /does not copy within/,
    );
    expect(() => connectReaction(source, "death", target, action, [0, 2, 2])).toThrow(
      /does not copy within/,
    );
    expect(() => connectReaction(source, "death", target, action, [0, 0, 0])).toThrow(
      /does not copy within/,
    );
  });
});

describe('FXEmitter.onParticleEvent("birth")', () => {
  it("reports each birth once, after the world ticked, where it was placed and how its pose moved", () => {
    const world = newWorld();
    const emitter = emitterIn(world, placingBehavior(10));
    const births = collectEvents(emitter, "birth");
    emitter.burst(1, { origin: { position: [1, 2, 3], velocity: [0, 5, 0] } });
    expect(births).toEqual([]);
    world.update(0.1);
    expect(births).toHaveLength(1);
    expect(births[0].position).toEqual([1, 2, 3]);
    expect(births[0].velocity).toEqual([0, 5, 0]);
    world.update(0.1);
    expect(births).toHaveLength(1);
  });

  it("reports every birth of a burst with its own slot, as its spawn left it", () => {
    const world = newWorld();
    const emitter = emitterIn(world, taggingBehavior(10, { firstTag: 30 }));
    const births = collectEvents(emitter, "birth");
    emitter.burst(3);
    world.update(0.1);
    expect(births.map((birth) => [...birth.slot.subarray(TAG_OFFSET)])).toEqual([
      [30, -1],
      [31, -1],
      [32, -1],
    ]);
    // Not updated yet: born at age 0.
    expect(births[0].slot[AGE_OFFSET]).toBe(0);
  });

  it("does not report a birth seeded dead", () => {
    const world = newWorld();
    const emitter = emitterIn(world, taggingBehavior(0));
    const births = collectEvents(emitter, "birth");
    emitter.burst(2);
    world.update(0.1);
    expect(births).toEqual([]);
  });

  it("reports only the births a burst larger than the ring seeds", () => {
    const world = newWorld();
    const emitter = emitterIn(world, placingBehavior(10), 2);
    const births = collectEvents(emitter, "birth");
    emitter.burst(5);
    world.update(0.1);
    expect(births).toHaveLength(2);
  });

  it("hands out a tick's deaths before its births", () => {
    const world = newWorld();
    const emitter = emitterIn(world, placingBehavior(0.05));
    const seen: string[] = [];
    emitter.onParticleEvent("birth", () => {
      seen.push("birth");
    });
    emitter.onParticleEvent("death", () => {
      seen.push("death");
    });
    emitter.burst(1);
    world.update(0.1); // born
    emitter.burst(1);
    world.update(0.1); // the first dies in the update, the second is born after it
    expect(seen).toEqual(["birth", "death", "birth"]);
  });

  it("drops the births of the past prewarm() simulates", () => {
    const world = newWorld();
    const emitter = emitterIn(world, placingBehavior(10));
    const births = collectEvents(emitter, "birth");
    emitter.play(10, { duration: 1 });
    emitter.prewarm(0.5);
    expect(emitter.particleCount).toBeGreaterThan(0);
    world.update(0);
    expect(births).toEqual([]);
  });

  it("drops the births a reset() lands on before they are handed out", () => {
    const world = newWorld();
    const emitter = emitterIn(world, placingBehavior(10));
    const births = collectEvents(emitter, "birth");
    // Ticks after the emitter, so it resets it between its births and their hand-out.
    world.registerObject({
      onWorldTick: () => {
        emitter.reset();
      },
      destroy: () => undefined,
    });
    emitter.burst(1);
    world.update(0.1);
    expect(births).toEqual([]);
  });

  it("stops reporting births once the last listener detached, deaths still reported", () => {
    const world = newWorld();
    const emitter = emitterIn(world, placingBehavior(0.05));
    const deaths = collectDeaths(emitter);
    let births = 0;
    const detach = emitter.onParticleEvent("birth", () => {
      births += 1;
    });
    detach();
    emitter.burst(1);
    world.update(0.1);
    world.update(0.1);
    expect(births).toBe(0);
    expect(deaths).toHaveLength(1);
  });

  it("refuses a kind that is no particle event", () => {
    const world = newWorld();
    const emitter = emitterIn(world, placingBehavior(1));
    expect(() => emitter.onParticleEvent("spawn" as FXParticleEventKind, () => undefined)).toThrow(
      /expected one of birth, death/,
    );
  });
});

describe("birth reactions", () => {
  it("bursts the target a tick later from where the source's particle was born", () => {
    const world = newWorld();
    const poses: FXEmitterTransform[] = [];
    const target = emitterIn(world, placingBehavior(10, poses));
    const source = emitterIn(world, placingBehavior(10));
    connectReaction(source, "birth", target, { kind: "burst", count: 3 });
    source.burst(1, { origin: { position: [1, 0, 0], velocity: [4, 0, 0] } });
    world.update(0.1); // the source's particle is born
    expect(target.particleCount).toBe(0);
    world.update(0.1); // the reaction's burst lands
    expect(target.particleCount).toBe(3);
    expect(poses).toHaveLength(1);
    expect(poses[0].worldMatrix[12]).toBeCloseTo(1, 6);
    expect(poses[0].velocity).toEqual([4, 0, 0]);
  });

  it("hands its births what its copies take of the newborn", () => {
    const world = newWorld();
    const inherits: number[][] = [];
    const inherit: FXInheritLayout = { stride: 2, defaults: [7, 8] };
    const target = emitterIn(world, taggingBehavior(10, { inherit, inherits }));
    const source = emitterIn(world, taggingBehavior(10, { firstTag: 40 }));
    connectReaction(source, "birth", target, { kind: "burst", count: 1 }, [TAG_OFFSET, 1, 1]);
    source.burst(2);
    world.update(0.1);
    world.update(0.1);
    expect(inherits).toEqual([
      [7, 40],
      [7, 41],
    ]);
  });
});

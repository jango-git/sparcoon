import { afterEach, describe, expect, it } from "vitest";
import type { FXBehaviorArtifact, FXEmitterTransform } from "../../src/artifact/FXArtifact";
import { connectDeathReaction, fireSpawnAction } from "../../src/effect/FXSpawnAction";
import { FXEmitter } from "../../src/emitter/FXEmitter";
import type { FXParticleDeath } from "../../src/emitter/FXEmitter.Internal";
import { FXWorld } from "../../src/world/FXWorld";
import { killingBehavior, placingBehavior, unlitArtifact } from "../helpers/artifacts";
import { landBirths } from "../helpers/internals";

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

/** Copies each death out of the reused object the listener receives. */
function collectDeaths(emitter: FXEmitter): FXParticleDeath[] {
  const deaths: FXParticleDeath[] = [];
  emitter.onParticleDeath((death) => {
    deaths.push({ position: [...death.position], velocity: [...death.velocity] });
  });
  return deaths;
}

describe("FXEmitter.onParticleDeath", () => {
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
    emitter.onParticleDeath(() => {
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
    emitter.onParticleDeath(() => {
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
    emitter.onParticleDeath(() => {
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
    const detach = emitter.onParticleDeath(() => {
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
    connectDeathReaction(source, target, { kind: "burst", count: 3 });
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
      connectDeathReaction(source, target, { kind: "play", rate: 10, duration: 0 }),
    ).toThrow(/finite duration/);
  });

  it("refuses a play over distance: it spawns from where the particle died, which does not move", () => {
    const world = newWorld();
    const source = emitterIn(world, placingBehavior(1));
    const target = emitterIn(world, placingBehavior(1));
    expect(() =>
      connectDeathReaction(source, target, {
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

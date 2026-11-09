import { afterEach, describe, expect, it } from "vitest";
import type { FXEmitterTransform } from "../../src/artifact/FXArtifact";
import { FXEmitter } from "../../src/emitter/FXEmitter";
import { FXWorld } from "../../src/world/FXWorld";
import { behaviorArtifact, placingBehavior, unlitArtifact } from "../helpers/artifacts";
import { particlesOf, tickEmitter } from "../helpers/internals";

// Times below are exact binary fractions (0.125, 0.25, ...), so no tick lands a hair short of a
// delay or duration boundary.

/** A plain emitter: flat-white render, a spawn that seeds lifetime 100. */
function plainEmitter(): FXEmitter {
  return FXEmitter.fromArtifacts(unlitArtifact(), behaviorArtifact({ lifetime: 100 }));
}

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

describe("FXEmitter.burst", () => {
  it("rejects a fractional count", () => {
    const emitter = plainEmitter();
    try {
      expect(() => emitter.burst(2.5)).toThrow(/integer/);
    } finally {
      emitter.destroy();
    }
  });

  it("spawns a delayed burst on the tick its delay runs out", () => {
    const emitter = plainEmitter();
    try {
      emitter.burst(3, { delay: 0.25 });
      tickEmitter(emitter, 0.125);
      expect(emitter.particleCount).toBe(0);
      tickEmitter(emitter, 0.125);
      expect(emitter.particleCount).toBe(3);
    } finally {
      emitter.destroy();
    }
  });
});

describe("FXEmitter.play", () => {
  it("emits the final partial tick that lands inside its duration", () => {
    const emitter = plainEmitter();
    try {
      // 100/s for 0.0625 s: a 0.5 s tick overshoots the duration and removes the play, but the
      // slice inside it still emits rate * 0.0625 = 6 (6.25, the remainder dropped with the play).
      emitter.play(100, { duration: 0.0625 });
      tickEmitter(emitter, 0.5);
      expect(emitter.particleCount).toBe(6);
      tickEmitter(emitter, 0.5);
      expect(emitter.particleCount).toBe(6);
    } finally {
      emitter.destroy();
    }
  });

  it("waits out its delay, then emits for the overshoot of the tick the delay ends in", () => {
    const emitter = plainEmitter();
    try {
      emitter.play(8, { delay: 0.25 });
      tickEmitter(emitter, 0.125); // 0.125 s of delay left
      expect(emitter.particleCount).toBe(0);
      tickEmitter(emitter, 0.5); // the delay ends 0.375 s before the tick does: 8 * 0.375 = 3
      expect(emitter.particleCount).toBe(3);
      tickEmitter(emitter, 0.125); // 8 * 0.125 = 1 more
      expect(emitter.particleCount).toBe(4);
    } finally {
      emitter.destroy();
    }
  });
});

describe("FXEmitter.stop", () => {
  it("cancels one pending delayed burst by its handler, leaving the others", () => {
    const emitter = plainEmitter();
    try {
      const cancelled = emitter.burst(5, { delay: 0.25 });
      emitter.burst(2, { delay: 0.25 });
      expect(emitter.stop(cancelled)).toBe(true);
      expect(emitter.stop(cancelled)).toBe(false); // already gone
      tickEmitter(emitter, 0.5);
      expect(emitter.particleCount).toBe(2);
    } finally {
      emitter.destroy();
    }
  });

  it("cancels one active play by its handler, leaving the others", () => {
    const emitter = plainEmitter();
    try {
      const cancelled = emitter.play(8);
      emitter.play(4);
      tickEmitter(emitter, 0.5); // 4 + 2
      expect(emitter.particleCount).toBe(6);
      expect(emitter.stop(cancelled)).toBe(true);
      tickEmitter(emitter, 0.5); // only the 4/s play: +2
      expect(emitter.particleCount).toBe(8);
    } finally {
      emitter.destroy();
    }
  });

  it("cannot cancel an undelayed burst: it is due already", () => {
    const emitter = plainEmitter();
    try {
      const handler = emitter.burst(3);
      expect(emitter.stop(handler)).toBe(false);
      tickEmitter(emitter, 0.125);
      expect(emitter.particleCount).toBe(3);
    } finally {
      emitter.destroy();
    }
  });

  it("stops every play and pending burst with no handler, reporting whether there were any", () => {
    const emitter = plainEmitter();
    try {
      expect(emitter.stop()).toBe(false);
      emitter.play(8);
      emitter.burst(2, { delay: 0.25 });
      expect(emitter.stop()).toBe(true);
      tickEmitter(emitter, 0.5);
      expect(emitter.particleCount).toBe(0);
      expect(emitter.stop()).toBe(false);
    } finally {
      emitter.destroy();
    }
  });
});

describe("spawning at an origin", () => {
  function emitterIn(world: FXWorld, poses: FXEmitterTransform[] = [], capacity = 16): FXEmitter {
    return FXEmitter.fromArtifacts(
      unlitArtifact(),
      placingBehavior(10, poses),
      { expectedCapacity: capacity },
      world,
    );
  }

  it("spawns from the emitter's own rotation and scale, moved to the origin, at its velocity", () => {
    const world = newWorld();
    const poses: FXEmitterTransform[] = [];
    const emitter = emitterIn(world, poses);
    emitter.rotation.y = Math.PI / 2;
    emitter.scale.set(2, 2, 2);
    emitter.position.set(5, 0, 0);
    emitter.updateMatrixWorld();
    emitter.burst(1, { origin: { position: [1, 2, 3], velocity: [0, 4, 0] } });
    world.update(0.1);

    expect(poses).toHaveLength(1);
    const own = particlesOf(emitter).matrixWorld.elements;
    expect(poses[0].worldMatrix.slice(0, 12)).toEqual(own.slice(0, 12));
    expect(poses[0].worldMatrix.slice(12, 15)).toEqual([1, 2, 3]);
    expect(poses[0].velocity).toEqual([0, 4, 0]);
    expect(poses[0].angularVelocity).toEqual([0, 0, 0]);
  });

  it("seeds an origin birth after the tick's own, so both backends number them alike", () => {
    const world = newWorld();
    const poses: FXEmitterTransform[] = [];
    const emitter = emitterIn(world, poses);
    emitter.burst(1, { origin: { position: [7, 0, 0] } });
    emitter.burst(1);
    world.update(0.1);
    expect(poses.map((pose) => pose.worldMatrix[12])).toEqual([0, 7]);
  });

  it("keeps a play at an origin running across a loop, but stops one following the emitter", () => {
    const world = newWorld();
    const emitter = emitterIn(world, [], 256);
    emitter.play(10, { origin: { position: [0, 0, 0] } });
    emitter.play(10);
    world.update(0.5);
    const before = emitter.particleCount;
    emitter.loopTimeline();
    world.update(0.5);
    world.update(0.5);
    // Only the play at the origin still emits: 10/s for 1s.
    expect(emitter.particleCount - before).toBe(10);
  });

  it("rejects an origin that is not three finite numbers", () => {
    const world = newWorld();
    const emitter = emitterIn(world);
    expect(() => emitter.burst(1, { origin: { position: [0, 0] } })).toThrow(/\[x, y, z\]/);
    expect(() => emitter.play(1, { origin: { position: [0, Number.NaN, 0] } })).toThrow(/finite/);
  });
});

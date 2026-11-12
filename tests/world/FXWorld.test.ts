import { describe, expect, it } from "vitest";

import { FXWorld } from "../../src/world/FXWorld";
import { effectSpec, emitterSpec, TestEffect } from "../helpers/effectSpecs";

/** An effect bursting 4 particles at t = 0.3, in `world` (the default world when omitted). */
function burstingEffect(world?: FXWorld): TestEffect {
  return new TestEffect(
    effectSpec({
      emitters: [emitterSpec("e", { events: [{ kind: "burst", time: 0.3, count: 4 }] })],
    }),
    world === undefined ? {} : { world },
  );
}

describe("FXWorld default instance", () => {
  it("returns a stable lazily created default, and the static update ticks it", () => {
    const a = FXWorld.getDefault();
    const b = FXWorld.getDefault();
    expect(a).toBe(b);
    expect(() => FXWorld.update(0.016)).not.toThrow();
  });

  it("creates a fresh default after the old one is disposed", () => {
    const first = FXWorld.getDefault();
    first.dispose();
    const second = FXWorld.getDefault();
    expect(second).not.toBe(first);
    expect(() => second.update(0.016)).not.toThrow();
  });
});

describe("FXWorld drives its own effects", () => {
  it("advances a subscribed effect's timeline on update", () => {
    const world = new FXWorld();
    const effect = burstingEffect(world);
    effect.play();
    expect(effect.getEmitter("e")!.particleCount).toBe(0); // burst at t=0.3, not reached
    world.update(1); // crosses t=0.3 -> 4 particles
    expect(effect.getEmitter("e")!.particleCount).toBe(4);
    world.dispose();
  });

  it("does not drive an effect that belongs to a different world", () => {
    const owner = new FXWorld();
    const other = new FXWorld();
    const effect = burstingEffect(owner);
    effect.play();

    other.update(1); // the effect belongs to `owner`, so this must not advance it
    expect(effect.getEmitter("e")!.particleCount).toBe(0);

    owner.update(1);
    expect(effect.getEmitter("e")!.particleCount).toBe(4);
    owner.dispose();
    other.dispose();
  });
});

describe("FXWorld.dispose", () => {
  it("disposes every registered effect, is idempotent, and then no-ops update", () => {
    const world = new FXWorld();
    const effect = burstingEffect(world);
    effect.play();
    world.update(1);
    expect(effect.getEmitter("e")!.particleCount).toBe(4);

    world.dispose();
    expect(effect.getEmitter("e")).toBeUndefined(); // the effect was disposed with the world
    expect(() => world.dispose()).not.toThrow();
    expect(() => world.update(1)).not.toThrow(); // disposed world is inert
  });
});

describe("FXWorld clock", () => {
  it("hands its objects a shared u_time that wraps instead of growing unbounded", () => {
    const world = new FXWorld();
    const times: number[] = [];
    world.registerObject({
      onWorldTick: (_deltaTime, elapsedTime) => {
        times.push(elapsedTime);
      },
      destroy: () => undefined,
    });
    // Well past the ~1 hour wrap period: 400 * 10 s = 4000 s.
    for (let i = 0; i < 400; i++) {
      world.update(10);
    }
    const period = 573 * 2 * Math.PI;
    expect(times[0]).toBe(10);
    expect(Math.max(...times)).toBeLessThan(period);
    expect(Math.min(...times)).toBeGreaterThanOrEqual(0);
    // It did wrap: some tick's time fell back below the previous one.
    expect(times.some((time, i) => i > 0 && time < times[i - 1])).toBe(true);
    world.dispose();
  });
});

import { describe, expect, it } from "vitest";
import { FXEffect } from "../../src/effect/FXEffect";
import { FXWorld } from "../../src/world/FXWorld";
import type {
  FXEffectEmitterSpec,
  FXEffectSpec,
  FXTransform,
} from "../../src/effect/FXEffectSpec";
import { behaviorArtifact, unlitArtifact } from "../helpers/artifacts";

const IDENTITY_TRANSFORM: FXTransform = {
  position: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
};

function emitterSpec(name: string): FXEffectEmitterSpec {
  return {
    name,
    render: unlitArtifact(),
    behavior: behaviorArtifact({ lifetime: 100 }),
    expectedCapacity: 64,
    sortInterval: 0,
    externalSlots: [],
    transform: IDENTITY_TRANSFORM,
    transformTracks: [],
    tracks: [],
    events: [{ kind: "burst", time: 0.3, count: 4 }],
    liveChannels: [],
    liveParams: [],
  };
}

function spec(): FXEffectSpec {
  return {
    duration: 0,
    fps: 30,
    transform: IDENTITY_TRANSFORM,
    transformTracks: [],
    emitters: [emitterSpec("e")],
    meshes: [],
  };
}

class TestEffect extends FXEffect {
  public constructor(world?: FXWorld) {
    super(spec(), {}, world === undefined ? {} : { world });
  }
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
    const effect = new TestEffect(world);
    effect.play();
    expect(effect.getEmitter("e")!.particleCount).toBe(0); // burst at t=0.3, not reached
    world.update(1); // crosses t=0.3 -> 4 particles
    expect(effect.getEmitter("e")!.particleCount).toBe(4);
    world.dispose();
  });

  it("does not drive an effect that belongs to a different world", () => {
    const owner = new FXWorld();
    const other = new FXWorld();
    const effect = new TestEffect(owner);
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
    const effect = new TestEffect(world);
    effect.play();
    world.update(1);
    expect(effect.getEmitter("e")!.particleCount).toBe(4);

    world.dispose();
    expect(effect.getEmitter("e")).toBeUndefined(); // the effect was disposed with the world
    expect(() => world.dispose()).not.toThrow();
    expect(() => world.update(1)).not.toThrow(); // disposed world is inert
  });
});

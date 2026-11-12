import { afterEach, describe, expect, it } from "vitest";

import type { FXParticleKernelArtifact } from "../../src/artifact/FXArtifact";
import { FX_CORE_LIFECYCLE, FX_CORE_POSITION } from "../../src/coreLayout";
import { FXEmitter } from "../../src/emitter/FXEmitter";
import type { FXFromArtifactsOptions } from "../../src/emitter/FXFromArtifactsOptions";
import { FXWorld } from "../../src/world/FXWorld";
import { behaviorArtifact, unlitArtifact } from "../helpers/artifacts";
import { effectSpec, emitterSpec, TestEffect } from "../helpers/effectSpecs";
import { tickEmitter } from "../helpers/internals";
import { callsNamed, mockRenderer } from "../helpers/mockWebGL";

const KERNEL: FXParticleKernelArtifact = {
  vertexSource: "",
  fragmentSource: "",
  buffers: [
    { name: FX_CORE_POSITION, stride: 3 },
    { name: FX_CORE_LIFECYCLE, stride: 3 },
  ],
  transformFeedbackVaryings: ["out_position", "out_lifecycle"],
  bindings: {},
};

const emitters: FXEmitter[] = [];
const worlds: FXWorld[] = [];

afterEach(() => {
  for (const emitter of emitters.splice(0)) {
    emitter.destroy();
  }
  for (const world of worlds.splice(0)) {
    world.dispose();
  }
});

/** A JS emitter whose particles live exactly `lifetime` seconds. */
function emitter(lifetime: number, options: FXFromArtifactsOptions = {}): FXEmitter {
  const built = FXEmitter.fromArtifacts(unlitArtifact(), behaviorArtifact({ lifetime }), {
    expectedCapacity: 4,
    ...options,
  });
  emitters.push(built);
  return built;
}

/** Ticks `count` times by `deltaTime`. */
function tick(target: FXEmitter, count: number, deltaTime = 0.25): void {
  for (let i = 0; i < count; i++) {
    tickEmitter(target, deltaTime);
  }
}

describe("FXEmitter.maxLifetime", () => {
  it("settles a tick after its last particle reaches maxLifetime", () => {
    const target = emitter(0.5, { maxLifetime: 0.5 });
    target.burst(2);
    tick(target, 1); // born: age 0
    tick(target, 1); // age 0.25
    expect(target.isSettled).toBe(false);
    tick(target, 1); // age 0.5: dead
    expect(target.isSettled).toBe(false);
    tick(target, 1); // dead a whole tick: a float32 age rounded short of its lifetime is too
    expect(target.isSettled).toBe(true);
    expect(target.particleCount).toBe(0);
  });

  it("counts from the last birth, not the first", () => {
    const target = emitter(0.5, { maxLifetime: 0.5 });
    target.burst(1);
    tick(target, 2);
    target.burst(1);
    tick(target, 3);
    expect(target.isSettled).toBe(false);
    tick(target, 1);
    expect(target.isSettled).toBe(true);
  });

  it("waits for a delayed burst and an active play", () => {
    const target = emitter(0.25, { maxLifetime: 0.25 });
    target.burst(1, { delay: 1 });
    tick(target, 3);
    expect(target.isSettled).toBe(false);
    tick(target, 3); // the burst landed at 1 s, its particle died at 1.25 s
    expect(target.isSettled).toBe(true);

    target.play(4, { duration: 1 });
    tick(target, 4);
    expect(target.isSettled).toBe(false);
    tick(target, 2);
    expect(target.isSettled).toBe(true);
  });

  it("rejects a negative maxLifetime", () => {
    expect(() => emitter(1, { maxLifetime: -1 })).toThrow(/maxLifetime/);
  });

  it("never settles by itself without maxLifetime", () => {
    const target = emitter(0.25);
    target.burst(1);
    tick(target, 8);
    expect(target.particleCount).toBe(0);
    expect(target.isSettled).toBe(false);
  });

  it("lets the trail fade out first, then settles", () => {
    const target = emitter(0.5, {
      maxLifetime: 0.5,
      trail: { render: unlitArtifact(), frames: 3, sampleInterval: 0.25 },
    });
    target.burst(1);
    tick(target, 3); // the particle died here, its trail still shows older points
    expect(target.isSettled).toBe(false);
    tick(target, 2);
    expect(target.isSettled).toBe(false);
    tick(target, 1); // the oldest drawn point was recorded a tick after the death
    expect(target.isSettled).toBe(true);
  });

  it("settles a GPU emitter too: no pass and nothing drawn after", () => {
    const { renderer, gl } = mockRenderer();
    const target = emitter(0.5, { maxLifetime: 0.5, gpuKernel: KERNEL, renderer });
    target.burst(1);
    tick(target, 4);
    expect(target.isSettled).toBe(true);
    const passes = callsNamed(gl, "drawArrays").length;
    tick(target, 2);
    expect(callsNamed(gl, "drawArrays")).toHaveLength(passes);
  });
});

describe('FXEffect "drained"', () => {
  function effect(maxLifetimes: readonly (number | undefined)[]): {
    target: TestEffect;
    world: FXWorld;
  } {
    const world = new FXWorld();
    worlds.push(world);
    const target = new TestEffect(
      effectSpec({
        duration: 0.5,
        loop: false,
        emitters: maxLifetimes.map((maxLifetime, index) =>
          emitterSpec(`e${String(index)}`, {
            behavior: behaviorArtifact({ lifetime: 0.5 }),
            events: [{ kind: "burst", time: 0, count: 2 }],
            ...(maxLifetime === undefined ? {} : { maxLifetime }),
          }),
        ),
      }),
      { world },
    );
    return { target, world };
  }

  function drainsOf(target: TestEffect): () => number {
    let drains = 0;
    target.addEventListener("drained", () => {
      drains += 1;
    });
    return () => drains;
  }

  it("comes once per playback, after the effect finished and every emitter settled", () => {
    const { target, world } = effect([0.5, 0.5]);
    const drains = drainsOf(target);
    target.play();
    for (let i = 0; i < 8; i++) {
      world.update(0.25);
    }
    expect(drains()).toBe(1);

    target.play();
    for (let i = 0; i < 8; i++) {
      world.update(0.25);
    }
    expect(drains()).toBe(2);
  });

  it("never comes while an emitter has no maxLifetime", () => {
    const { target, world } = effect([0.5, undefined]);
    const drains = drainsOf(target);
    target.play();
    for (let i = 0; i < 16; i++) {
      world.update(0.25);
    }
    expect(drains()).toBe(0);
  });
});

import { describe, expect, it } from "vitest";

import type { FXBehaviorArtifact, FXEmitterTransform } from "../../src/artifact/FXArtifact";
import { FXSimulationHolder } from "../../src/emitter/FXSimulationHolder";

const TRANSFORM: FXEmitterTransform = {
  worldMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  velocity: [0, 0, 0],
  angularVelocity: [0, 0, 0],
};

/** A behavior recording the seed each of its kernels is called with. */
function recording(seeds: string[]): FXBehaviorArtifact {
  return {
    buffers: [{ name: "lifecycle", stride: 3 }],
    bindings: {},
    spawn(_slots, _start, _count, seed): void {
      seeds.push(`spawn ${seed.toString()}`);
    },
    update(_slots, _count, _deltaTime, seed): void {
      seeds.push(`update ${seed.toString()}`);
    },
  };
}

function run(holder: FXSimulationHolder): void {
  const slots = new Float32Array(3);
  holder.spawn(slots, 0, 1, TRANSFORM, new Float32Array(0));
  holder.update(slots, 1, 0.016, TRANSFORM);
  holder.spawn(slots, 0, 1, TRANSFORM, new Float32Array(0));
  holder.update(slots, 1, 0.016, TRANSFORM);
}

describe("FXSimulationHolder seed", () => {
  it("gives every update a new seed and a spawn the last update's", () => {
    const seeds: string[] = [];
    run(new FXSimulationHolder(recording(seeds)));
    expect(seeds).toEqual(["spawn 0", "update 1", "spawn 1", "update 2"]);
  });

  it("starts every simulation from the same seed, so runs repeat", () => {
    const first: string[] = [];
    const second: string[] = [];
    run(new FXSimulationHolder(recording(first)));
    run(new FXSimulationHolder(recording(second)));
    expect(second).toEqual(first);
  });
});

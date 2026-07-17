import { describe, expect, it } from "vitest";
import type { FXBehaviorArtifact, FXEmitterTransform } from "../../src/artifact/FXArtifact";
import { FX_CORE_LIFECYCLE, FX_CORE_POSITION, FX_LIFETIME } from "../../src/coreLayout";
import { FXEmitter } from "../../src/emitter/FXEmitter";
import { unlitArtifact } from "../helpers/artifacts";

/** Drives one private tick on `emitter` with the given dt. */
function tickEmitter(emitter: FXEmitter, dt: number): void {
  (emitter as unknown as { tick(deltaTime: number): void }).tick(dt);
}

interface Captured {
  readonly velocity: readonly number[];
  readonly angularVelocity: readonly number[];
}

function lastOf<T>(values: readonly T[]): T | undefined {
  return values[values.length - 1];
}

function capture(emitter: FXEmitterTransform | undefined): Captured | undefined {
  return emitter === undefined
    ? undefined
    : { velocity: [...emitter.velocity], angularVelocity: [...emitter.angularVelocity] };
}

/** A behavior artifact whose spawn/update just record the `emitter` transform argument they saw. */
function capturingBehavior(
  spawnCaptures: Captured[],
  updateCaptures: Captured[],
): FXBehaviorArtifact {
  return {
    buffers: [
      { name: FX_CORE_POSITION, stride: 3 },
      { name: FX_CORE_LIFECYCLE, stride: 2 },
    ],
    attributeWrites: [],
    bindings: {},
    spawnWrittenBuffers: [FX_CORE_LIFECYCLE],
    updateWrittenBuffers: [],
    spawn(buffers, start, count, _bindings, emitter): void {
      const lifecycle = buffers[FX_CORE_LIFECYCLE];
      for (let i = start; i < start + count; i++) {
        lifecycle[i * 2 + FX_LIFETIME] = 1000;
      }
      const captured = capture(emitter);
      if (captured !== undefined) {
        spawnCaptures.push(captured);
      }
    },
    update(_buffers, _count, _dt, _bindings, emitter): void {
      const captured = capture(emitter);
      if (captured !== undefined) {
        updateCaptures.push(captured);
      }
    },
  };
}

describe("FXEmitter exposes world-space velocity/angular velocity to the behavior kernel", () => {
  it("reports zero motion on the very first tick (no prior pose to diff against)", () => {
    const spawnCaptures: Captured[] = [];
    const updateCaptures: Captured[] = [];
    const emitter = FXEmitter.fromArtifacts(
      unlitArtifact(),
      capturingBehavior(spawnCaptures, updateCaptures),
    );
    try {
      emitter.burst(1);
      tickEmitter(emitter, 1);
      expect(spawnCaptures[0]).toEqual({ velocity: [0, 0, 0], angularVelocity: [0, 0, 0] });
      expect(updateCaptures[0]).toEqual({ velocity: [0, 0, 0], angularVelocity: [0, 0, 0] });
    } finally {
      emitter.destroy();
    }
  });

  it("reports world-space linear velocity once the emitter has actually moved", () => {
    const spawnCaptures: Captured[] = [];
    const updateCaptures: Captured[] = [];
    const emitter = FXEmitter.fromArtifacts(
      unlitArtifact(),
      capturingBehavior(spawnCaptures, updateCaptures),
    );
    try {
      emitter.burst(1);
      tickEmitter(emitter, 1); // establishes the position-(0,0,0) baseline

      emitter.position.set(2, 0, 0);
      tickEmitter(emitter, 0.5); // moved 2 units in 0.5s -> 4 units/s

      expect(lastOf(updateCaptures)?.velocity[0]).toBeCloseTo(4, 6);
      expect(lastOf(updateCaptures)?.velocity[1]).toBeCloseTo(0, 6);
      expect(lastOf(updateCaptures)?.velocity[2]).toBeCloseTo(0, 6);
    } finally {
      emitter.destroy();
    }
  });

  it("gives every spawn/update call within one tick the same value, even across multiple bursts", () => {
    // Regression guard for the multi-invocation pitfall: worldTransform() (and thus the
    // emitter argument) is fetched once per pending burst plus once for the update phase -
    // computing velocity/angular velocity per-call instead of once per tick would corrupt it
    // the moment more than one of those fires in the same tick.
    const spawnCaptures: Captured[] = [];
    const updateCaptures: Captured[] = [];
    const emitter = FXEmitter.fromArtifacts(
      unlitArtifact(),
      capturingBehavior(spawnCaptures, updateCaptures),
    );
    try {
      tickEmitter(emitter, 1); // establishes the position-(0,0,0) baseline, no particles yet

      emitter.position.set(3, 0, 0);
      // Both bursts are pending (not fired yet) and expire inside the next tick's dt, so both
      // spawnBurst() calls - plus the update phase - land inside a single tick(dt) call.
      emitter.burst(1, { delay: 0.05 });
      emitter.burst(1, { delay: 0.05 });
      tickEmitter(emitter, 1); // moved 3 units in 1s -> 3 units/s

      expect(spawnCaptures).toHaveLength(2);
      const expected = { velocity: [3, 0, 0], angularVelocity: [0, 0, 0] };
      for (const value of [spawnCaptures[0], spawnCaptures[1], lastOf(updateCaptures)]) {
        expect(value?.velocity[0]).toBeCloseTo(expected.velocity[0], 6);
        expect(value?.velocity[1]).toBeCloseTo(expected.velocity[1], 6);
        expect(value?.velocity[2]).toBeCloseTo(expected.velocity[2], 6);
      }
    } finally {
      emitter.destroy();
    }
  });

  it("resets the velocity/angular-velocity baseline on reset(), avoiding a restart teleport spike", () => {
    const spawnCaptures: Captured[] = [];
    const updateCaptures: Captured[] = [];
    const emitter = FXEmitter.fromArtifacts(
      unlitArtifact(),
      capturingBehavior(spawnCaptures, updateCaptures),
    );
    try {
      emitter.burst(1);
      tickEmitter(emitter, 1); // baseline at (0,0,0)
      emitter.position.set(10, 0, 0);
      tickEmitter(emitter, 1); // 10 units/s - proves the tracker was live before reset

      emitter.reset();
      emitter.position.set(-50, 0, 0); // an unrelated jump, as if the effect restarted elsewhere
      emitter.burst(1);
      tickEmitter(emitter, 1);

      expect(lastOf(updateCaptures)).toEqual({ velocity: [0, 0, 0], angularVelocity: [0, 0, 0] });
    } finally {
      emitter.destroy();
    }
  });
});

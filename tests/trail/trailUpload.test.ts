import { describe, expect, it } from "vitest";
import { FX_CORE_POSITION } from "../../src/coreLayout";
import { FXEmitter } from "../../src/emitter/FXEmitter";
import { markRange, type FXRangedBuffer } from "../../src/trail/FXTrailHistory.Internal";
import type { FXTrailOptions } from "../../src/trail/FXTrail";
import { behaviorArtifact, unlitArtifact } from "../helpers/artifacts";
import { tickEmitter, trailOf, type TrailInternals } from "../helpers/internals";

/**
 * What the GPU sees of a JS trail history: only the ranges it marks for upload, per tick - so a
 * point left un-uploaded (frame 0 while the head is there) must never be drawn from.
 *
 * Every tick is half a sample interval, both exact binary fractions, so two ticks always move the
 * head on exactly once.
 */

const SAMPLE_INTERVAL = 0.125;
const TICK = SAMPLE_INTERVAL / 2;

/** Each update moves every particle +1 along x. */
function movingBehavior(lifetime: number): ReturnType<typeof behaviorArtifact> {
  return behaviorArtifact({
    lifetime,
    updateWrittenBuffers: [FX_CORE_POSITION],
    update(buffers, count): void {
      const position = buffers[FX_CORE_POSITION];
      for (let i = 0; i < count; i++) {
        position[i * 3] += 1;
      }
    },
  });
}

function trailEmitter(frames: number, capacity: number, lifetime: number): FXEmitter {
  const trail: FXTrailOptions = {
    render: unlitArtifact(),
    frames,
    sampleInterval: SAMPLE_INTERVAL,
  };
  return FXEmitter.fromArtifacts(unlitArtifact(), movingBehavior(lifetime), {
    expectedCapacity: capacity,
    trail,
  });
}

/** A copy of the history as the GPU holds it: updated only by the ranges marked since last time. */
class GPUView {
  public readonly data: Float32Array;
  public uploads = 0;

  constructor(private readonly trail: TrailInternals) {
    // The first render uploads the whole (zero) buffer.
    this.data = new Float32Array(trail.history.array);
  }

  /** What a render now uploads; returns the marked ranges. */
  public render(): { start: number; count: number }[] {
    const { buffer, array } = this.trail.history;
    const ranges = [...buffer.updateRanges];
    for (const range of ranges) {
      this.data.set(array.subarray(range.start, range.start + range.count), range.start);
      this.uploads += 1;
    }
    buffer.updateRanges.length = 0;
    buffer.needsUpdate = false;
    return ranges;
  }

  /** The segments the CPU trail shader links, by its own predicate (see trailPrologue). */
  public linkedSegments(withTailTest = true): { frame: number; slot: number }[] {
    const { stride, capacity, frames } = this.trail.history;
    const tail = Math.fround(this.trail.uniforms.tail.value);
    const linked: { frame: number; slot: number }[] = [];
    for (let frame = 0; frame < frames; frame++) {
      for (let slot = 0; slot < capacity; slot++) {
        const a = (frame * capacity + slot) * stride;
        const b = ((frame + 1) * capacity + slot) * stride;
        const [aTag, aTime] = [this.data[a + 3], this.data[a + 7]];
        const [bTag, bTime] = [this.data[b + 3], this.data[b + 7]];
        if (
          aTag > 0.5 &&
          Math.abs(aTag - bTag) < 0.5 &&
          bTime > aTime &&
          (!withTailTest || aTime >= tail)
        ) {
          linked.push({ frame, slot });
        }
      }
    }
    return linked;
  }
}

describe("trail history uploads (JS backend)", () => {
  it("never links a segment from last lap's frame 0, which the head-0 ticks leave un-uploaded", () => {
    const frames = 4;
    const emitter = trailEmitter(frames, 1, 1000);
    try {
      const view = new GPUView(trailOf(emitter));
      emitter.burst(1);
      let staleSeen = false;
      // Three laps of the ring, two ticks per recorded frame.
      for (let i = 0; i < frames * 2 * 3; i++) {
        tickEmitter(emitter, TICK);
        view.render();
        // One live particle: `frames` recorded points, so at most `frames - 1` segments.
        expect(view.linkedSegments().length).toBeLessThanOrEqual(frames - 1);
        staleSeen ||= view.linkedSegments(false).length > frames - 1;
      }
      // The case the tail test guards really happens (from the second lap on).
      expect(staleSeen).toBe(true);
      // And a steady trail still draws its whole length.
      expect(view.linkedSegments().length).toBe(frames - 1);
    } finally {
      emitter.destroy();
    }
  });

  it("keeps the whole trail when the head frame is frame 0", () => {
    const frames = 3;
    const emitter = trailEmitter(frames, 2, 1000);
    try {
      const view = new GPUView(trailOf(emitter));
      emitter.burst(2);
      // The first tick records frame 0; every second one after it moves the head on.
      for (let i = 0; i < 1 + 2 * frames * 2; i++) {
        tickEmitter(emitter, TICK);
      }
      view.render();
      // Lap 3 just began: the head is frame 0, its point read only through the mirror.
      expect(trailOf(emitter).head).toBe(0);
      expect(view.linkedSegments().map((segment) => segment.frame)).toEqual([1, 1, 2, 2]);
    } finally {
      emitter.destroy();
    }
  });

  it("stops recording once nothing is alive and every frame is dead, and resyncs on the next birth", () => {
    const frames = 3;
    // Born in the first tick, dead (age 0.125 >= 0.1) in the third.
    const emitter = trailEmitter(frames, 2, 0.1);
    try {
      const view = new GPUView(trailOf(emitter));
      emitter.burst(2);
      // The dead points then take `frames` head moves to replace the last live frame - and one
      // more record finds the history idle.
      for (let i = 0; i < 2 + frames * 2 + 2; i++) {
        tickEmitter(emitter, TICK);
        view.render();
      }
      expect(view.linkedSegments()).toEqual([]);
      // Every point's tag (its fourth float; nothing else recorded here) reads dead.
      const { array, stride } = trailOf(emitter).history;
      expect(array.every((value, index) => index % stride !== 3 || value === 0)).toBe(true);
      for (let i = 0; i < 10; i++) {
        tickEmitter(emitter, TICK);
        expect(view.render()).toEqual([]);
      }

      emitter.burst(1);
      tickEmitter(emitter, TICK);
      // The whole buffer once, then the usual one range per tick.
      expect(view.render()).toEqual([{ start: 0, count: trailOf(emitter).history.array.length }]);
      expect(view.data).toEqual(trailOf(emitter).history.array);
      tickEmitter(emitter, TICK);
      expect(view.render()).toHaveLength(1);
    } finally {
      emitter.destroy();
    }
  });

  it("merges every tick before a render into one upload range (three >= 0.159)", () => {
    const emitter = trailEmitter(5, 4, 1000);
    try {
      const view = new GPUView(trailOf(emitter));
      emitter.burst(4);
      // A prewarm: many ticks, no render in between.
      for (let i = 0; i < 40; i++) {
        tickEmitter(emitter, TICK);
      }
      expect(trailOf(emitter).history.buffer.updateRanges).toHaveLength(1);
      view.render();
      expect(view.data).toEqual(trailOf(emitter).history.array);
    } finally {
      emitter.destroy();
    }
  });
});

describe("markRange", () => {
  it("widens three 0.157's single update range across ticks, and restarts it once uploaded", () => {
    const legacy: FXRangedBuffer = { updateRange: { offset: 0, count: -1 }, needsUpdate: false };
    markRange(legacy, 40, 10);
    expect(legacy.updateRange).toEqual({ offset: 40, count: 10 });
    expect(legacy.needsUpdate).toBe(true);
    markRange(legacy, 10, 5); // before it
    expect(legacy.updateRange).toEqual({ offset: 10, count: 40 });
    markRange(legacy, 70, 10); // after it
    expect(legacy.updateRange).toEqual({ offset: 10, count: 70 });
    markRange(legacy, 20, 5); // inside it
    expect(legacy.updateRange).toEqual({ offset: 10, count: 70 });

    // What three 0.157 does once it has uploaded the range.
    legacy.updateRange = { offset: 0, count: -1 };
    legacy.needsUpdate = false;
    markRange(legacy, 5, 3);
    expect(legacy.updateRange).toEqual({ offset: 5, count: 3 });
  });

  it("keeps newer three's range list to one merged range", () => {
    const updateRanges: { start: number; count: number }[] = [];
    const modern: FXRangedBuffer = {
      updateRanges,
      addUpdateRange: (start, count) => updateRanges.push({ start, count }),
      needsUpdate: false,
    };
    markRange(modern, 40, 10);
    markRange(modern, 10, 5);
    markRange(modern, 70, 10);
    expect(updateRanges).toEqual([{ start: 10, count: 70 }]);
    expect(modern.needsUpdate).toBe(true);
  });

  it("skips an empty range", () => {
    const legacy: FXRangedBuffer = { updateRange: { offset: 0, count: -1 }, needsUpdate: false };
    markRange(legacy, 10, 0);
    expect(legacy.updateRange).toEqual({ offset: 0, count: -1 });
    expect(legacy.needsUpdate).toBe(false);
  });
});

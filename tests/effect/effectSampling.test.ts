import { describe, expect, it } from "vitest";
import type {
  FXKeyframe,
  FXQuat,
  FXTrack,
  FXTransform,
  FXTransformTrack,
} from "../../src/effect/FXEffectSpec";
import {
  frameOfTime,
  keyframeSegment,
  normalizeQuaternion,
  quaternionFromValue,
  sampleTrack,
  sampleTracks,
  sampleTransform,
  slerpQuaternion,
  timeOfFrame,
  vectorFromValue,
} from "../../src/effect/FXEffectSampling.Internal";

const keys = (...pairs: [number, number | number[]][]): FXKeyframe[] =>
  pairs.map(([time, value]) => ({ time, value }));

describe("frameOfTime / timeOfFrame", () => {
  it("rounds time to the nearest frame on the fps grid", () => {
    expect(frameOfTime(0.5, 30)).toBe(15);
    expect(frameOfTime(0.51, 30)).toBe(15);
    expect(frameOfTime(0.52, 30)).toBe(16);
  });

  it("converts a frame index back to seconds", () => {
    expect(timeOfFrame(15, 30)).toBeCloseTo(0.5, 12);
  });

  it("returns 0 for a non-positive fps (a degenerate spec)", () => {
    expect(frameOfTime(2, 0)).toBe(0);
    expect(timeOfFrame(2, 0)).toBe(0);
  });
});

describe("keyframeSegment", () => {
  it("returns undefined with no keys", () => {
    expect(keyframeSegment([], 1)).toBeUndefined();
  });

  it("holds the only key for a single-key track", () => {
    const single = keys([2, 5]);
    expect(keyframeSegment(single, 0)).toEqual({ a: single[0], b: single[0], u: 0 });
    expect(keyframeSegment(single, 10)).toEqual({ a: single[0], b: single[0], u: 0 });
  });

  it("holds before the first key and after the last key", () => {
    const k = keys([1, 0], [2, 10], [3, 20]);
    expect(keyframeSegment(k, 0)).toEqual({ a: k[0], b: k[0], u: 0 });
    expect(keyframeSegment(k, 5)).toEqual({ a: k[2], b: k[2], u: 0 });
  });

  it("straddles the surrounding keys and reports the fraction between", () => {
    const k = keys([0, 0], [1, 10], [2, 20]);
    expect(keyframeSegment(k, 0.5)).toEqual({ a: k[0], b: k[1], u: 0.5 });
    expect(keyframeSegment(k, 1.75)).toEqual({ a: k[1], b: k[2], u: 0.75 });
  });
});

describe("sampleTrack / sampleTracks", () => {
  it("returns undefined for an empty track", () => {
    const track: FXTrack = { name: "x", keys: [] };
    expect(sampleTrack(track, 1)).toBeUndefined();
  });

  it("interpolates a scalar track linearly", () => {
    const track: FXTrack = { name: "x", keys: keys([0, 0], [1, 10]) };
    expect(sampleTrack(track, 0.5)).toBeCloseTo(5, 12);
  });

  it("interpolates a vector track component-wise", () => {
    const track: FXTrack = { name: "c", keys: keys([0, [0, 10, 100]], [1, [10, 20, 200]]) };
    expect(sampleTrack(track, 0.5)).toEqual([5, 15, 150]);
  });

  it("collapses to the common width when the two keys mix scalar and vector", () => {
    const track: FXTrack = { name: "m", keys: keys([0, 2], [1, [4, 6]]) };
    // scalar 2 becomes [2]; width = min(1, 2) = 1
    expect(sampleTrack(track, 0.5)).toEqual([3]);
  });

  it("skips empty tracks and keys the rest by name", () => {
    const tracks: FXTrack[] = [
      { name: "a", keys: keys([0, 1], [1, 3]) },
      { name: "b", keys: [] },
    ];
    const values = sampleTracks(tracks, 0.5);
    expect(values.get("a")).toBeCloseTo(2, 12);
    expect(values.has("b")).toBe(false);
  });
});

describe("vectorFromValue / quaternionFromValue", () => {
  it("splats a scalar to a vec3", () => {
    expect(vectorFromValue(4)).toEqual([4, 4, 4]);
  });

  it("pads a short vector with zeros", () => {
    expect(vectorFromValue([5])).toEqual([5, 0, 0]);
  });

  it("falls back to identity for a malformed quaternion", () => {
    expect(quaternionFromValue(1)).toEqual([0, 0, 0, 1]);
    expect(quaternionFromValue([0, 0, 0])).toEqual([0, 0, 0, 1]);
  });

  it("reads a well-formed quaternion", () => {
    expect(quaternionFromValue([0, 0, 1, 0])).toEqual([0, 0, 1, 0]);
  });
});

describe("normalizeQuaternion", () => {
  it("returns identity for a zero quaternion", () => {
    expect(normalizeQuaternion([0, 0, 0, 0])).toEqual([0, 0, 0, 1]);
  });

  it("scales to unit length", () => {
    const n = normalizeQuaternion([0, 0, 0, 2]);
    expect(n).toEqual([0, 0, 0, 1]);
    const m = normalizeQuaternion([1, 1, 1, 1]);
    expect(Math.hypot(...m)).toBeCloseTo(1, 12);
  });
});

describe("slerpQuaternion", () => {
  const identity: FXQuat = [0, 0, 0, 1];
  const halfPi = Math.SQRT1_2;
  const rotZ90: FXQuat = [0, 0, halfPi, halfPi];

  it("returns the endpoints at u = 0 and u = 1", () => {
    const at0 = slerpQuaternion(identity, rotZ90, 0);
    const at1 = slerpQuaternion(identity, rotZ90, 1);
    expect(at0[3]).toBeCloseTo(1, 6);
    expect(at1[2]).toBeCloseTo(halfPi, 6);
    expect(at1[3]).toBeCloseTo(halfPi, 6);
  });

  it("blends along the shortest arc (90deg about Z halves to 45deg)", () => {
    const mid = slerpQuaternion(identity, rotZ90, 0.5);
    expect(mid[2]).toBeCloseTo(Math.sin(Math.PI / 8), 6);
    expect(mid[3]).toBeCloseTo(Math.cos(Math.PI / 8), 6);
    expect(Math.hypot(...mid)).toBeCloseTo(1, 6);
  });

  it("takes the linear branch for nearly parallel quaternions and stays normalized", () => {
    const almost: FXQuat = [0, 0, 0.001, Math.sqrt(1 - 0.001 * 0.001)];
    const mid = slerpQuaternion(identity, almost, 0.5);
    expect(Math.hypot(...mid)).toBeCloseTo(1, 9);
  });

  it("flips a negative-dot pair so opposite-sign but equal rotations blend to themselves", () => {
    const flipped: FXQuat = [0, 0, 0, -1];
    const mid = slerpQuaternion(identity, flipped, 0.5);
    expect(Math.abs(mid[3])).toBeCloseTo(1, 6);
  });
});

describe("sampleTransform", () => {
  const base: FXTransform = {
    position: [1, 2, 3],
    rotation: [0, 0, 0, 1],
    scale: [4, 5, 6],
  };

  it("holds the base transform when there are no tracks", () => {
    expect(sampleTransform(base, [], 1)).toEqual(base);
  });

  it("holds a channel whose track has no keys", () => {
    const tracks: FXTransformTrack[] = [{ channel: "position", keys: [] }];
    expect(sampleTransform(base, tracks, 1).position).toEqual(base.position);
  });

  it("samples the channels that have keys and holds the rest at base", () => {
    const tracks: FXTransformTrack[] = [
      { channel: "position", keys: keys([0, [0, 0, 0]], [1, [10, 20, 30]]) },
      { channel: "scale", keys: keys([0, [2, 2, 2]], [1, [4, 4, 4]]) },
    ];
    const result = sampleTransform(base, tracks, 0.5);
    expect(result.position).toEqual([5, 10, 15]);
    expect(result.scale).toEqual([3, 3, 3]);
    expect(result.rotation).toEqual(base.rotation); // no rotation track -> held at base
  });

  it("slerps a rotation channel that has keys", () => {
    const halfPi = Math.SQRT1_2;
    const tracks: FXTransformTrack[] = [
      {
        channel: "rotation",
        keys: keys([0, [0, 0, 0, 1]], [1, [0, 0, halfPi, halfPi]]),
      },
    ];
    const result = sampleTransform(base, tracks, 0.5);
    expect(result.rotation[2]).toBeCloseTo(Math.sin(Math.PI / 8), 6);
    expect(result.rotation[3]).toBeCloseTo(Math.cos(Math.PI / 8), 6);
    expect(result.position).toEqual(base.position); // no position track -> held at base
  });
});

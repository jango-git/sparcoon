import { describe, expect, it } from "vitest";
import {
  FXObjectMotionTracker,
  type FXObjectPose,
  type FXObjectQuat,
  type FXObjectVec3,
} from "../../src/emitter/FXObjectMotion.Internal";

const IDENTITY_QUAT: FXObjectQuat = [0, 0, 0, 1];

/** A unit quaternion for a rotation of `angle` radians about `axis` (need not be normalized). */
function axisAngleQuat(axis: FXObjectVec3, angle: number): FXObjectQuat {
  const length = Math.hypot(axis[0], axis[1], axis[2]);
  const [ax, ay, az] = [axis[0] / length, axis[1] / length, axis[2] / length];
  const s = Math.sin(angle / 2);
  return [ax * s, ay * s, az * s, Math.cos(angle / 2)];
}

/** Hamilton product `a * b` (applies `b` first, then `a`) - mirrors the module under test. */
function multiplyQuat(a: FXObjectQuat, b: FXObjectQuat): FXObjectQuat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function pose(position: FXObjectVec3, quaternion: FXObjectQuat = IDENTITY_QUAT): FXObjectPose {
  return { position, quaternion };
}

describe("FXObjectMotionTracker", () => {
  it("reports zero motion on the first sample (no baseline yet)", () => {
    const tracker = new FXObjectMotionTracker();
    const motion = tracker.sample(pose([1, 2, 3]), 1);
    expect(motion.velocity).toEqual([0, 0, 0]);
    expect(motion.angularVelocity).toEqual([0, 0, 0]);
  });

  it("reports zero motion between two identical poses", () => {
    const tracker = new FXObjectMotionTracker();
    tracker.sample(pose([5, 5, 5], axisAngleQuat([0, 1, 0], 1)), 1);
    const motion = tracker.sample(pose([5, 5, 5], axisAngleQuat([0, 1, 0], 1)), 1);
    expect(motion.velocity).toEqual([0, 0, 0]);
    expect(motion.angularVelocity).toEqual([0, 0, 0]);
  });

  it("derives linear velocity as (delta position) / dt, per second, for pure translation", () => {
    const tracker = new FXObjectMotionTracker();
    tracker.sample(pose([0, 0, 0]), 1);
    const motion = tracker.sample(pose([2, 0, -4]), 0.5);
    expect(motion.velocity[0]).toBeCloseTo(4, 6); // 2 units in 0.5s -> 4 units/s
    expect(motion.velocity[1]).toBeCloseTo(0, 6);
    expect(motion.velocity[2]).toBeCloseTo(-8, 6);
    expect(motion.angularVelocity).toEqual([0, 0, 0]);
  });

  it("derives angular velocity (axis * rad/s) for pure rotation about one axis", () => {
    const tracker = new FXObjectMotionTracker();
    tracker.sample(pose([0, 0, 0], IDENTITY_QUAT), 1);
    const angle = 0.2;
    const motion = tracker.sample(pose([0, 0, 0], axisAngleQuat([0, 0, 1], angle)), 0.1);
    expect(motion.velocity).toEqual([0, 0, 0]);
    expect(motion.angularVelocity[0]).toBeCloseTo(0, 6);
    expect(motion.angularVelocity[1]).toBeCloseTo(0, 6);
    expect(motion.angularVelocity[2]).toBeCloseTo(angle / 0.1, 4); // rad/s about +Z
  });

  it("composes translation and rotation independently", () => {
    const tracker = new FXObjectMotionTracker();
    tracker.sample(pose([0, 0, 0], IDENTITY_QUAT), 1);
    const angle = 0.3;
    const motion = tracker.sample(pose([1, 0, 0], axisAngleQuat([1, 0, 0], angle)), 1);
    expect(motion.velocity).toEqual([1, 0, 0]);
    expect(motion.angularVelocity[0]).toBeCloseTo(angle, 6);
    expect(motion.angularVelocity[1]).toBeCloseTo(0, 6);
    expect(motion.angularVelocity[2]).toBeCloseTo(0, 6);
  });

  it("reports zero motion for a non-positive dt, without producing NaN/Infinity", () => {
    const tracker = new FXObjectMotionTracker();
    tracker.sample(pose([0, 0, 0]), 1);
    const zeroDt = tracker.sample(pose([10, 10, 10], axisAngleQuat([0, 1, 0], 1)), 0);
    expect(zeroDt.velocity).toEqual([0, 0, 0]);
    expect(zeroDt.angularVelocity).toEqual([0, 0, 0]);
    const negativeDt = tracker.sample(pose([20, 20, 20]), -1);
    expect(negativeDt.velocity).toEqual([0, 0, 0]);
    expect(negativeDt.angularVelocity).toEqual([0, 0, 0]);
  });

  it("does not report a teleport spike on the tick right after a zero-dt (paused) frame", () => {
    const tracker = new FXObjectMotionTracker();
    tracker.sample(pose([0, 0, 0]), 1);
    // Paused frame: the object is teleported while dt is 0 (must not leak into next tick's diff).
    tracker.sample(pose([100, 0, 0]), 0);
    const resumed = tracker.sample(pose([101, 0, 0]), 1);
    expect(resumed.velocity[0]).toBeCloseTo(1, 6);
  });

  it("reports zero motion right after reset(), instead of diffing against the pre-reset baseline", () => {
    const tracker = new FXObjectMotionTracker();
    tracker.sample(pose([0, 0, 0]), 1);
    tracker.reset();
    const motion = tracker.sample(pose([50, 50, 50], axisAngleQuat([0, 1, 0], 2)), 1);
    expect(motion.velocity).toEqual([0, 0, 0]);
    expect(motion.angularVelocity).toEqual([0, 0, 0]);
    // The reset call re-establishes a baseline: the next sample diffs normally again.
    const next = tracker.sample(pose([51, 50, 50], axisAngleQuat([0, 1, 0], 2)), 1);
    expect(next.velocity).toEqual([1, 0, 0]);
  });

  it("takes the shortest path across the quaternion double-cover (q and -q are the same rotation)", () => {
    const tracker = new FXObjectMotionTracker();
    const base = axisAngleQuat([0, 1, 0], 0.7);
    const negatedBase: FXObjectQuat = [-base[0], -base[1], -base[2], -base[3]];
    const smallAngle = 0.02;
    const smallRotation = axisAngleQuat([0, 0, 1], smallAngle);
    // `current` is a small further rotation composed onto the *unnegated* base; feeding the
    // *negated* representation as the previous baseline forces the raw quaternion delta to
    // land with w < 0 - without the shortest-path guard this would read as an angle near
    // 2*pi instead of the small rotation that actually happened.
    tracker.sample(pose([0, 0, 0], negatedBase), 1);
    const motion = tracker.sample(pose([0, 0, 0], multiplyQuat(smallRotation, base)), 1);
    const magnitude = Math.hypot(...motion.angularVelocity);
    expect(magnitude).toBeCloseTo(smallAngle, 4);
    expect(magnitude).toBeLessThan(Math.PI);
  });

  it("reports zero angular velocity for a rotation below the axis-degeneracy threshold", () => {
    const tracker = new FXObjectMotionTracker();
    tracker.sample(pose([0, 0, 0], IDENTITY_QUAT), 1);
    const motion = tracker.sample(pose([0, 0, 0], axisAngleQuat([0, 1, 0], 1e-9)), 1);
    expect(motion.angularVelocity).toEqual([0, 0, 0]);
  });
});

/**
 * Pure world-space motion tracking shared by {@link FXEmitter} and `FXEffect`'s VFX-mesh
 * driving: given an object's current world position/quaternion (from a decomposed
 * `matrixWorld`) and the real per-frame `dt`, derives its linear and angular velocity - both
 * already normalized to units/radians per second, never a raw "delta this frame". Three-free
 * (like `FXEffectSampling.Internal`) so the math unit-tests as plain arithmetic.
 */

export type FXObjectVec3 = readonly [number, number, number];
/** A rotation quaternion in `[x, y, z, w]` order (three's component order). */
export type FXObjectQuat = readonly [number, number, number, number];

/** An object's world-space pose at one instant: position + rotation: scale is not tracked. */
export interface FXObjectPose {
  readonly position: FXObjectVec3;
  readonly quaternion: FXObjectQuat;
}

/** World-space linear + angular velocity, both already per-second. */
export interface FXObjectMotion {
  readonly velocity: FXObjectVec3;
  readonly angularVelocity: FXObjectVec3;
}

const ZERO_VEC3: FXObjectVec3 = [0, 0, 0];
const ZERO_MOTION: FXObjectMotion = { velocity: ZERO_VEC3, angularVelocity: ZERO_VEC3 };

/** Below this rotation angle (radians) the axis is numerically undefined - report no spin. */
const MIN_ANGLE = 1e-6;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Hamilton product `a * b` (applies `b`'s rotation first, then `a`'s - three's convention). */
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

/** Inverse of a *unit* quaternion (conjugate) - `Matrix4.decompose` always yields one. */
function invertUnitQuat(q: FXObjectQuat): FXObjectQuat {
  return [-q[0], -q[1], -q[2], q[3]];
}

/**
 * World-space angular velocity (axis * rad/s) for the rotation from `previous` to `current`.
 * Composed in world order (`current * previous^-1`: undo `previous`, then apply `current`), so
 * it reads directly in world axes - matching the linear `velocity` this module also derives.
 */
function angularVelocityBetween(
  current: FXObjectQuat,
  previous: FXObjectQuat,
  deltaTime: number,
): FXObjectVec3 {
  const delta = multiplyQuat(current, invertUnitQuat(previous));
  // `q` and `-q` represent the same rotation; without this flip a small rotation can land on
  // the "long way around" (w < 0), reporting an angle near 2*pi instead of near 0.
  const w = delta[3] < 0 ? -delta[3] : delta[3];
  const sign = delta[3] < 0 ? -1 : 1;
  const angle = 2 * Math.acos(clamp(w, -1, 1));
  if (angle < MIN_ANGLE) {
    return ZERO_VEC3;
  }
  const x = delta[0] * sign;
  const y = delta[1] * sign;
  const z = delta[2] * sign;
  const axisLength = Math.hypot(x, y, z);
  if (axisLength < MIN_ANGLE) {
    return ZERO_VEC3;
  }
  const rate = angle / deltaTime;
  return [(x / axisLength) * rate, (y / axisLength) * rate, (z / axisLength) * rate];
}

/** `current`'s world velocity/angular velocity relative to `previous`, `deltaTime` seconds apart. */
function diffPose(
  current: FXObjectPose,
  previous: FXObjectPose,
  deltaTime: number,
): FXObjectMotion {
  const velocity: FXObjectVec3 = [
    (current.position[0] - previous.position[0]) / deltaTime,
    (current.position[1] - previous.position[1]) / deltaTime,
    (current.position[2] - previous.position[2]) / deltaTime,
  ];
  const angularVelocity = angularVelocityBetween(
    current.quaternion,
    previous.quaternion,
    deltaTime,
  );
  return { velocity, angularVelocity };
}

/**
 * Tracks one object's pose across ticks to derive its world velocity/angular velocity. The
 * first `sample()` call (and the one right after `reset()`) has no prior pose to diff against,
 * so it reports zero motion and just records the baseline - a restarted effect never reports a
 * teleport spike from wherever the object was last posed.
 */
export class FXObjectMotionTracker {
  private previous: FXObjectPose | undefined;

  /** The motion arriving at `pose` over the last `deltaTime` seconds; `deltaTime <= 0` (paused) reports zero. */
  public sample(pose: FXObjectPose, deltaTime: number): FXObjectMotion {
    const previous = this.previous;
    // Always record the latest pose, even on a zero/negative-deltaTime or first call, so a paused
    // frame's teleport is not mistaken for a spike on the next real tick.
    this.previous = pose;
    if (previous === undefined || deltaTime <= 0) {
      return ZERO_MOTION;
    }
    return diffPose(pose, previous, deltaTime);
  }

  /** Drops the stored baseline, so the next `sample()` reports zero motion instead of a restart spike. */
  public reset(): void {
    this.previous = undefined;
  }
}

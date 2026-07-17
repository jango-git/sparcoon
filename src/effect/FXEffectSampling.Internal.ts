import type {
  FXKeyframe,
  FXQuat,
  FXTrack,
  FXTransform,
  FXTransformTrack,
  FXVec3,
} from "./FXEffectSpec.js";

/**
 * Pure keyframe/transform sampling math for {@link FXEffect}'s timeline drive: hold-before-first,
 * hold-after-last, linear interpolation between (slerp for rotation). No side effects, no `three`
 * dependency. Every export here also backs the editor's own track/transform sampling: the editor
 * used to hand-duplicate this exact math under different type names, and now imports it from here
 * (this stays an `.Internal.ts` module, outside the public `sparcoon` package surface) so the two
 * can never drift apart.
 */

const IDENTITY_QUAT: FXQuat = [0, 0, 0, 1];

export function frameOfTime(time: number, fps: number): number {
  return fps > 0 ? Math.round(time * fps) : 0;
}

export function timeOfFrame(frame: number, fps: number): number {
  return fps > 0 ? frame / fps : 0;
}

/** The bounding keys straddling `time` and the fraction between (held at the ends). */
export function keyframeSegment(
  keys: readonly FXKeyframe[],
  time: number,
): { readonly a: FXKeyframe; readonly b: FXKeyframe; readonly u: number } | undefined {
  if (keys.length === 0) {
    return undefined;
  }
  const first = keys[0];
  if (time <= first.time || keys.length === 1) {
    return { a: first, b: first, u: 0 };
  }
  const last = keys[keys.length - 1];
  if (time >= last.time) {
    return { a: last, b: last, u: 0 };
  }
  let a = first;
  let b = last;
  for (let i = 1; i < keys.length; i += 1) {
    const key = keys[i];
    if (key.time >= time) {
      a = keys[i - 1];
      b = key;
      break;
    }
  }
  const span = b.time - a.time;
  return { a, b, u: span > 0 ? (time - a.time) / span : 0 };
}

function lerpValue(
  a: number | readonly number[],
  b: number | readonly number[],
  u: number,
): number | number[] {
  if (typeof a === "number" && typeof b === "number") {
    return a + (b - a) * u;
  }
  const aArray = typeof a === "number" ? [a] : a;
  const bArray = typeof b === "number" ? [b] : b;
  const width = Math.min(aArray.length, bArray.length);
  const output: number[] = [];
  for (let i = 0; i < width; i += 1) {
    output.push(aArray[i] + (bArray[i] - aArray[i]) * u);
  }
  return output;
}

export function sampleTrack(track: FXTrack, time: number): number | number[] | undefined {
  const segment = keyframeSegment(track.keys, time);
  if (segment === undefined) {
    return undefined;
  }
  return lerpValue(segment.a.value, segment.b.value, segment.u);
}

export function sampleTracks(
  tracks: readonly FXTrack[],
  time: number,
): Map<string, number | number[]> {
  const values = new Map<string, number | number[]>();
  for (const track of tracks) {
    const value = sampleTrack(track, time);
    if (value !== undefined) {
      values.set(track.name, value);
    }
  }
  return values;
}

/** A keyframe value read as a vec3 (missing components default to 0). */
export function vectorFromValue(value: number | readonly number[]): FXVec3 {
  if (typeof value === "number") {
    return [value, value, value];
  }
  return [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0];
}

/** A keyframe value read as a quaternion, falling back to identity for a malformed value. */
export function quaternionFromValue(value: number | readonly number[]): FXQuat {
  if (typeof value === "number" || value.length < 4) {
    return IDENTITY_QUAT;
  }
  return [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0, value[3] ?? 1];
}

/** Renormalizes a quaternion (a componentwise-lerped or hand-edited one drifts off the unit sphere). */
export function normalizeQuaternion(quaternion: FXQuat): FXQuat {
  const length = Math.hypot(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
  if (length === 0) {
    return IDENTITY_QUAT;
  }
  return [
    quaternion[0] / length,
    quaternion[1] / length,
    quaternion[2] / length,
    quaternion[3] / length,
  ];
}

/** Spherical-linear blend of two quaternions at `u in [0, 1]` (shortest arc). */
export function slerpQuaternion(a: FXQuat, b: FXQuat, u: number): FXQuat {
  let ax = a[0];
  let ay = a[1];
  let az = a[2];
  let aw = a[3];
  const bx = b[0];
  const by = b[1];
  const bz = b[2];
  const bw = b[3];
  let dot = ax * bx + ay * by + az * bz + aw * bw;
  if (dot < 0) {
    ax = -ax;
    ay = -ay;
    az = -az;
    aw = -aw;
    dot = -dot;
  }
  if (dot > 0.9995) {
    return normalizeQuaternion([
      ax + (bx - ax) * u,
      ay + (by - ay) * u,
      az + (bz - az) * u,
      aw + (bw - aw) * u,
    ]);
  }
  const theta0 = Math.acos(dot);
  const theta = theta0 * u;
  const sinTheta0 = Math.sin(theta0);
  const s0 = Math.cos(theta) - (dot * Math.sin(theta)) / sinTheta0;
  const s1 = Math.sin(theta) / sinTheta0;
  return [ax * s0 + bx * s1, ay * s0 + by * s1, az * s0 + bz * s1, aw * s0 + bw * s1];
}

function sampleVectorChannel(
  track: FXTransformTrack | undefined,
  time: number,
): FXVec3 | undefined {
  const segment = track === undefined ? undefined : keyframeSegment(track.keys, time);
  if (segment === undefined) {
    return undefined;
  }
  const a = vectorFromValue(segment.a.value);
  const b = vectorFromValue(segment.b.value);
  return [
    a[0] + (b[0] - a[0]) * segment.u,
    a[1] + (b[1] - a[1]) * segment.u,
    a[2] + (b[2] - a[2]) * segment.u,
  ];
}

function sampleQuaternionChannel(
  track: FXTransformTrack | undefined,
  time: number,
): FXQuat | undefined {
  const segment = track === undefined ? undefined : keyframeSegment(track.keys, time);
  if (segment === undefined) {
    return undefined;
  }
  return slerpQuaternion(
    quaternionFromValue(segment.a.value),
    quaternionFromValue(segment.b.value),
    segment.u,
  );
}

function transformChannel(
  tracks: readonly FXTransformTrack[],
  name: "position" | "rotation" | "scale",
): FXTransformTrack | undefined {
  return tracks.find((track) => track.channel === name);
}

/**
 * The effective transform at time `time`: each channel with keyframes is sampled from its track, and
 * any channel without keys holds the entity's authored `base` value.
 */
export function sampleTransform(
  base: FXTransform,
  tracks: readonly FXTransformTrack[],
  time: number,
): FXTransform {
  return {
    position: sampleVectorChannel(transformChannel(tracks, "position"), time) ?? base.position,
    rotation: sampleQuaternionChannel(transformChannel(tracks, "rotation"), time) ?? base.rotation,
    scale: sampleVectorChannel(transformChannel(tracks, "scale"), time) ?? base.scale,
  };
}

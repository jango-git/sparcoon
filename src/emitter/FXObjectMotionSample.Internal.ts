import type { Object3D } from "three";
import { Quaternion, Vector3 } from "three";

import type { FXObjectMotion, FXObjectMotionTracker } from "./FXObjectMotion.Internal.js";

// One sample's decomposition, read back before the sample returns.
const position = new Vector3();
const quaternion = new Quaternion();
const scale = new Vector3();

/**
 * @internal `object`'s world-space motion over the last `deltaTime` seconds, by `tracker`: its
 * world matrix brought up to date (its parents' included) and decomposed into the pose the
 * tracker diffs against the previous one.
 */
export function sampleObjectMotion(
  tracker: FXObjectMotionTracker,
  object: Object3D,
  deltaTime: number,
): FXObjectMotion {
  object.updateWorldMatrix(true, false);
  object.matrixWorld.decompose(position, quaternion, scale);
  return tracker.sample(
    {
      position: [position.x, position.y, position.z],
      quaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
    },
    deltaTime,
  );
}

import type { Object3D } from "three";

import type { FXObjectMotionTracker } from "../emitter/FXObjectMotion.Internal.js";
import { sampleObjectMotion } from "../emitter/FXObjectMotionSample.Internal.js";
import type { FXDrawInputs } from "./FXDrawInputs.js";

/** {@link FXDrawInputs} a ticking owner fills in place each tick, allocating nothing. */
export type FXDrawFrame = { -readonly [K in keyof FXDrawInputs]: FXDrawInputs[K] };

/** A fresh {@link FXDrawFrame}: the clock at 0, the identity pose, at rest. */
export function createDrawFrame(): FXDrawFrame {
  return {
    time: 0,
    deltaTime: 0,
    modelMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    objectVelocity: [0, 0, 0],
    objectAngularVelocity: [0, 0, 0],
    seed: 0,
  };
}

/**
 * Fills `frame` with this tick's draw inputs for `object`, a single drawn object posed by its own
 * `matrixWorld`: the clock, the pose and the motion `tracker` samples from it, and its `seed`.
 * Returns `frame`.
 */
export function fillObjectDrawFrame(
  frame: FXDrawFrame,
  tracker: FXObjectMotionTracker,
  object: Object3D,
  time: number,
  deltaTime: number,
  seed: number,
): FXDrawFrame {
  const motion = sampleObjectMotion(tracker, object, deltaTime);
  frame.time = time;
  frame.deltaTime = deltaTime;
  frame.modelMatrix = object.matrixWorld.elements;
  frame.objectVelocity = motion.velocity;
  frame.objectAngularVelocity = motion.angularVelocity;
  frame.seed = seed;
  return frame;
}

// The seed the next drawn object built takes (see FXDrawInputs.seed).
let nextSeed = 0;

/** A seed of its own for a drawn object being built: every object built takes the next one. */
export function nextObjectSeed(): number {
  const seed = nextSeed;
  nextSeed += 1;
  return seed;
}

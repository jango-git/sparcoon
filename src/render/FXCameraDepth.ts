import type { Camera, Texture } from "three";

// By camera, not by world or effect: the same effect is drawn by every camera that sees it, each
// against its own view of the scene.
const cameraDepths = new WeakMap<Camera, Texture>();

/**
 * Gives `camera` the depth of the opaque scene it sees, which a graph's Depth Fade (soft particles,
 * an intersection glow) fades against; `undefined` takes it away. A camera without one draws those
 * graphs hard - the fade is 1 - so leave it unset where depth is unsupported or not wanted.
 *
 * `depth` holds the window depth in its red channel - a `DepthTexture`, or a resolved copy of one -
 * laid out like the frame the camera draws into: rendered through the same viewport, at any
 * resolution. The host renders it (a depth pre-pass, or a copy of the depth buffer after the opaque
 * pass) and keeps it current, e.g. across a resize; effects never need rebinding. A camera drawing
 * into the target that owns `depth` - its own pre-pass - draws those graphs hard too, since
 * sampling the depth being written is a feedback loop.
 *
 * Not supported: a logarithmic or reversed depth buffer, and one camera drawing two different views
 * in a frame (give each view its own camera).
 * @throws When `depth` is a shadow-comparison texture (`compareFunction` set), which a plain
 * sampler cannot read.
 */
export function fxSetCameraDepth(camera: Camera, depth: Texture | undefined): void {
  if (depth === undefined) {
    cameraDepths.delete(camera);
    return;
  }
  const { compareFunction } = depth as { compareFunction?: unknown };
  if (compareFunction !== undefined && compareFunction !== null) {
    throw new Error(
      "fxSetCameraDepth: the depth texture has a compareFunction (a shadow-map texture), " +
        "which a plain sampler cannot read - leave it unset",
    );
  }
  cameraDepths.set(camera, depth);
}

/** @internal The depth `camera` was given, if any. */
export function cameraDepthOf(camera: Camera): Texture | undefined {
  return cameraDepths.get(camera);
}

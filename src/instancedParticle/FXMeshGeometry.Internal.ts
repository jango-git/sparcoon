import type { BufferGeometry, InstancedBufferGeometry, InterleavedBufferAttribute } from "three";
import type { FXPackedAttribute } from "../render/FXAttributePacking.js";
import type { FXInterleavedGLAttribute } from "./FXTransformFeedbackParticle.js";

/**
 * @internal What the instanced meshes of this package share in putting their geometry together:
 * the base primitive they borrow, and the packed views they bind their per-particle (or per-point)
 * state through - the two particle meshes and the two trail histories alike.
 */

/**
 * Borrows `base`'s position/uv/normal and index onto `geometry`, so the geometry-agnostic vertex
 * epilogue transforms real mesh vertices. `base` is caller-owned (a primitive or a custom mesh
 * asset, possibly shared across emitters) - never disposed through `geometry`.
 */
export function attachBaseGeometry(geometry: InstancedBufferGeometry, base: BufferGeometry): void {
  const baseIndex = base.getIndex();
  if (baseIndex !== null) {
    geometry.setIndex(baseIndex);
  }
  geometry.setAttribute("position", base.getAttribute("position"));
  geometry.setAttribute("uv", base.getAttribute("uv"));
  geometry.setAttribute("normal", base.getAttribute("normal"));
}

/**
 * Lets go of what {@link attachBaseGeometry} borrowed - before another base is attached, and
 * before `geometry` is disposed, whose GPU-buffer cascade must touch only the buffers it owns.
 */
export function detachBaseGeometry(geometry: InstancedBufferGeometry): void {
  geometry.deleteAttribute("position");
  geometry.deleteAttribute("uv");
  geometry.deleteAttribute("normal");
  geometry.setIndex(null);
}

/** An attribute three binds over one of our buffers: interleaved over a CPU array, or over a raw
 *  `WebGLBuffer` ({@link FXInterleavedGLAttribute}). */
export type FXMountableAttribute = InterleavedBufferAttribute | FXInterleavedGLAttribute;

/**
 * Sets one attribute per packed view onto `geometry` - `name(view)`, made by `makeView(view)` -
 * the one mounting loop the trail histories and the particle meshes share, so what is bound is
 * always exactly the views the layout lists (and the material declares).
 * `InstancedBufferGeometry.setAttribute` is typed only for three's own attribute classes, though
 * its renderer takes {@link FXInterleavedGLAttribute} too: a narrow escape hatch for a gap in
 * three's typings, not in its behavior.
 */
export function mountPacked(
  geometry: InstancedBufferGeometry,
  packed: readonly FXPackedAttribute[],
  name: (view: FXPackedAttribute) => string,
  makeView: (view: FXPackedAttribute) => FXMountableAttribute,
): void {
  for (const view of packed) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (geometry as any).setAttribute(name(view), makeView(view));
  }
}

/**
 * Replaces a particle mesh's views - `previous`, each bound as `a_<view.name>` - with
 * `next`'s, made by `makeView`. Every previous one goes first: a name may mean another offset in
 * the new views, and there may be fewer. Shared by both particle meshes, whose views follow their
 * render's reads (`particleLayout`).
 */
export function remountParticleViews(
  geometry: InstancedBufferGeometry,
  previous: readonly FXPackedAttribute[],
  next: readonly FXPackedAttribute[],
  makeView: (view: FXPackedAttribute) => FXMountableAttribute,
): void {
  for (const view of previous) {
    geometry.deleteAttribute(particleViewAttribute(view));
  }
  mountPacked(geometry, next, particleViewAttribute, makeView);
}

function particleViewAttribute(view: FXPackedAttribute): string {
  return `a_${view.name}`;
}

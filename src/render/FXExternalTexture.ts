import type { Texture } from "three";

/**
 * A window into a texture: where an external texture slot's UV square lands in it. The runtime
 * knows nothing about atlases - this is plain sampling geometry, applied after the graph's `wrap`
 * (so `repeat`/`mirror`/`border` tile and mask the window, never the whole texture). Building one
 * from a packer's sprite frame is {@link fxAtlasRegion}'s job, or the app's own.
 *
 * Costs only where it is bound: a slot given a plain `Texture` samples it directly (no extra
 * instruction, no extra uniform); a slot given a region gets its own program variant.
 */
export interface FXTextureRegion {
  readonly texture: Texture;
  /**
   * Row-major 2x3 affine from the slot's UV to the texture's, `[a, b, c, d, e, f]`:
   * `u' = a*u + b*v + c`, `v' = d*u + e*v + f` (V up, as in GL). A rotated sprite is an affine too.
   */
  readonly uvTransform: readonly [number, number, number, number, number, number];
  /**
   * `[minU, minV, maxU, maxV]` in the slot's UV: the sample is transparent outside it (a trimmed
   * sprite's cut-away margins). Absent = no mask, and no mask cost.
   */
  readonly uvBounds?: readonly [number, number, number, number];
}

/**
 * What an external texture slot binds: a whole texture, or a {@link FXTextureRegion} of one.
 *
 * The kind is fixed when the slot is built (`fromArtifacts`, `applyRenderArtifact`, ...), since a
 * region is its own program: a later value edit may pass a whole `Texture` to a region slot (it then
 * samples all of it) or an unmasked region to a masked one, but a region to a whole-texture slot - or
 * `uvBounds` to an unmasked one - throws. Bind a region from the start to swap regions later.
 */
export type FXExternalTexture = Texture | FXTextureRegion;

/** A uniform value as `applyValues` takes it: scalar/vector, or an external texture. */
export type FXUniformValue = number | readonly number[] | FXExternalTexture;

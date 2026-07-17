/**
 * Render options carried in `FXRenderArtifact.options`. Runtime-owned so the artifact contract has no
 * editor dependency; the editor's graph material adapters import the same types.
 */

/**
 * How a particle fragment's alpha is composited into the framebuffer:
 * - `blending` - alpha blending (transparent, no depth write). The only mode that honors the
 *   `additivity` output slot: 0 = normal "over", 1 = additive, blended continuously via the
 *   premultiplied-alpha channel (a single `NormalBlending`, no separate additive blend mode).
 * - `alphaHash` - stochastic alpha hashing (opaque, depth-writing, dithered discard).
 * - `alphaTest` - hard alpha cutout (opaque, depth-writing).
 * - `opaque` - fully opaque (alpha forced to 1).
 *
 * The `alphaThreshold` output slot (hard discard cutoff, default 0.0075) applies in every mode except
 * `opaque`; `additivity` applies only in `blending`.
 */
export type FXRenderMode = "blending" | "alphaHash" | "alphaTest" | "opaque";

/** Unlit (flat albedo `ShaderMaterial`) particle material options. */
export interface FXGraphUnlitMaterialOptions {
  /** @defaultValue `"blending"` */
  renderMode?: FXRenderMode;
}

/** Lambert (lit `ShaderMaterial`, `lights`/`fog` from Three) particle material options. */
export interface FXGraphLambertMaterialOptions {
  /** @defaultValue `"blending"` */
  renderMode?: FXRenderMode;
}

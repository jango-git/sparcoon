/**
 * The mesh-surface sampling table both sides read: the runtime builds it from an app-supplied
 * `BufferGeometry`, and the editor's random-mesh-point node reads it in the behavior kernel - as a
 * `Float32Array` on the CPU and as an RGBA32F texture on the GPU, texel by texel, with the same
 * offsets. Dependency-free, so the editor imports it too.
 *
 * Texel 0 is the header, `(triangleCount, 0, 0, 0)`. Triangle `t` takes the
 * {@link FX_SURFACE_TEXELS_PER_TRIANGLE} texels from `FX_SURFACE_HEADER_TEXELS + t * 6`:
 * its three vertices, then their three normals. Column `t` of the alias table rides in the `w` of
 * the first two: the probability of keeping `t`, and the triangle chosen otherwise.
 */

/** Floats per texel. */
export const FX_SURFACE_TEXEL_FLOATS = 4;
/** Texels before the first triangle. */
export const FX_SURFACE_HEADER_TEXELS = 1;
/** Texels per triangle. */
export const FX_SURFACE_TEXELS_PER_TRIANGLE = 6;
/** Texel offsets within a triangle: vertex `a` (its `w` the alias probability), `b` (its `w` the
 *  alias), `c`, then the normals at `a`, `b`, `c`. */
export const FX_SURFACE_VERTEX_A = 0;
export const FX_SURFACE_VERTEX_B = 1;
export const FX_SURFACE_VERTEX_C = 2;
export const FX_SURFACE_NORMAL_A = 3;
export const FX_SURFACE_NORMAL_B = 4;
export const FX_SURFACE_NORMAL_C = 5;

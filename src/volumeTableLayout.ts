/**
 * The volume table the JS behavior kernel reads in place of a 3D texture - the runtime builds it from
 * an app-supplied R8 `Data3DTexture`, and the editor's SDF node reads it texel by texel. The GPU
 * kernel samples the texture itself. Dependency-free, so the editor imports it too.
 *
 * The header is `(width, height, depth)`. Texel `(x, y, z)` follows at
 * `FX_VOLUME_HEADER_FLOATS + x + width * (y + height * z)`, as its byte over 255 - the value the
 * GPU's sampler returns for it.
 */

/** Floats before the first texel. */
export const FX_VOLUME_HEADER_FLOATS = 3;

/**
 * The mesh-surface sampling table both sides read: the runtime builds it from an app-supplied
 * `BufferGeometry`, and the editor's random-mesh-point nodes read it in the behavior kernel - as a
 * `Float32Array` on the CPU and as an RGBA32F texture on the GPU, texel by texel, with the same
 * offsets. Dependency-free, so the editor imports it too.
 *
 * Texel 0 is the header, `(triangleCount, 0, 0, 0)`. Triangle `t` takes the texels from
 * `FX_SURFACE_HEADER_TEXELS + t * texelsPerTriangle`: its three vertices, then their three normals,
 * and in the table of a skinned mesh their three `skinIndex` and three `skinWeight` values after
 * those. Column `t` of the alias table rides in the `w` of the first two: the probability of
 * keeping `t`, and the triangle chosen otherwise.
 *
 * A surface sampled on an object of the scene, a mesh or a skinned mesh, has more inputs, named
 * after its table's (see {@link fxObjectInputNames}): the object entries, `FX_OBJECT_ENTRIES`
 * vec4s - the columns of the object's frame, those of its frame at the previous pose, the three
 * columns of the frame's normal matrix, and the state, `x` 1 once the object holds a pose, `y` 1
 * over the time from the previous pose to this one (0 while the object holds still or there is no
 * previous pose to move from). A mesh's frame is its `matrixWorld`, so a point is `frame * vertex`.
 * A skinned mesh's frame is its `bindMatrix`, and its point is skinned as three skins a vertex,
 * without the `bindMatrixInverse` three's shader cancels the model matrix with: `bones * frame *
 * vertex`, in the world. Its bone matrices are an input too, 4 texels (columns) per bone - three's
 * `boneTexture` on the GPU and `skeleton.boneMatrices` on the CPU - and those of its previous pose,
 * laid out the same.
 */

/** Floats per texel. */
export const FX_SURFACE_TEXEL_FLOATS = 4;
/** Texels before the first triangle. */
export const FX_SURFACE_HEADER_TEXELS = 1;
/** Texel offsets within a triangle: vertex `a` (its `w` the alias probability), `b` (its `w` the
 *  alias), `c`, then the normals at `a`, `b`, `c`. */
export const FX_SURFACE_VERTEX_A = 0;
export const FX_SURFACE_VERTEX_B = 1;
export const FX_SURFACE_VERTEX_C = 2;
export const FX_SURFACE_NORMAL_A = 3;
export const FX_SURFACE_NORMAL_B = 4;
export const FX_SURFACE_NORMAL_C = 5;
/** Texel offsets of a skinned mesh's triangle: the four bone indices at `a`, `b`, `c`, then their
 *  four weights. */
export const FX_SURFACE_SKIN_INDEX_A = 6;
export const FX_SURFACE_SKIN_INDEX_B = 7;
export const FX_SURFACE_SKIN_INDEX_C = 8;
export const FX_SURFACE_SKIN_WEIGHT_A = 9;
export const FX_SURFACE_SKIN_WEIGHT_B = 10;
export const FX_SURFACE_SKIN_WEIGHT_C = 11;

/** Texels per triangle. */
export const FX_SURFACE_TEXELS_PER_TRIANGLE = FX_SURFACE_NORMAL_C + 1;
/** Texels per triangle of a skinned mesh's table. */
export const FX_SKINNED_SURFACE_TEXELS_PER_TRIANGLE = FX_SURFACE_SKIN_WEIGHT_C + 1;

/** Texels (matrix columns) per bone. */
export const FX_BONE_TEXELS = 4;
/** Object entry offsets: the four columns of the frame, those of the previous pose's frame, the
 *  three columns of the frame's normal matrix (`xyz`), and the state. */
export const FX_OBJECT_FRAME = 0;
export const FX_OBJECT_PREVIOUS_FRAME = 4;
export const FX_OBJECT_NORMAL_FRAME = 8;
export const FX_OBJECT_STATE = 11;
/** Object entries (vec4s). */
export const FX_OBJECT_ENTRIES = 12;

/** The names of an object surface's entries, bone matrices and previous bone matrices, after the
 *  name its table is read under: a binding of the JS kernel, a uniform of the GPU program
 *  (`vec4[FX_OBJECT_ENTRIES]`, `sampler2D` and `sampler2D`). */
export function fxObjectInputNames(table: string): {
  readonly entries: string;
  readonly bones: string;
  readonly previousBones: string;
} {
  return {
    entries: `${table}_object`,
    bones: `${table}_bones`,
    previousBones: `${table}_previousBones`,
  };
}

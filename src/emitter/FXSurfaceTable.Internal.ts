import type {
  BufferAttribute,
  BufferGeometry,
  InterleavedBufferAttribute,
  Mesh,
  SkinnedMesh,
} from "three";

import {
  FX_SKINNED_SURFACE_TEXELS_PER_TRIANGLE,
  FX_SURFACE_HEADER_TEXELS,
  FX_SURFACE_NORMAL_A,
  FX_SURFACE_SKIN_INDEX_A,
  FX_SURFACE_SKIN_WEIGHT_A,
  FX_SURFACE_TEXEL_FLOATS,
  FX_SURFACE_TEXELS_PER_TRIANGLE,
  FX_SURFACE_VERTEX_A,
  FX_SURFACE_VERTEX_B,
  FX_SURFACE_VERTEX_C,
} from "../surfaceTableLayout.js";

/**
 * @internal A geometry's surface sampling table (see `surfaceTableLayout.ts`): what a
 * random-mesh-point node reads to draw a point uniformly by area. `texels` is its length in texels.
 */
export interface FXSurfaceTable {
  readonly data: Float32Array;
  readonly texels: number;
}

type FXVertexAttribute = BufferAttribute | InterleavedBufferAttribute;

/** @internal The surface table of an object of the scene, with the object that places it. */
export interface FXObjectSurface<M extends Mesh = Mesh> {
  readonly table: FXSurfaceTable;
  readonly mesh: M;
}

interface FXSurfaceTableEntry {
  readonly versions: string;
  readonly table: FXSurfaceTable;
}

/** A kind of surface table: whether it holds the skin, the attributes it reads beyond the
 *  positions, and the texels of a triangle. */
interface FXSurfaceTableKind {
  readonly skin: boolean;
  readonly attributes: readonly string[];
  readonly stride: number;
  /** The tables built so far, by geometry: shared by every emitter sampling one, and rebuilt when
   *  the geometry's attributes were updated since. */
  readonly tables: WeakMap<BufferGeometry, FXSurfaceTableEntry>;
}

const PLAIN: FXSurfaceTableKind = {
  skin: false,
  attributes: ["normal"],
  stride: FX_SURFACE_TEXELS_PER_TRIANGLE,
  tables: new WeakMap(),
};
const SKINNED: FXSurfaceTableKind = {
  skin: true,
  attributes: ["normal", "skinIndex", "skinWeight"],
  stride: FX_SKINNED_SURFACE_TEXELS_PER_TRIANGLE,
  tables: new WeakMap(),
};

/**
 * @internal The surface table of `geometry`, the asset `name`.
 * @throws When it has no positions or no area.
 */
export function meshSurfaceOf(geometry: BufferGeometry, name: string): FXSurfaceTable {
  return surfaceTableOf(geometry, name, PLAIN);
}

/**
 * @internal The surface of the mesh `mesh`, the asset `name`, placed by its world matrix.
 * @throws When it is a skinned mesh, which three draws where its bones put it, not where its world
 *   matrix does (see `skinnedSurfaceOf`), or its geometry cannot be read (see `meshSurfaceOf`).
 */
export function objectSurfaceOf(mesh: Mesh, name: string): FXObjectSurface {
  if ((mesh as Partial<SkinnedMesh>).isSkinnedMesh === true) {
    throw new Error(
      `FXEmitter.fromArtifacts: mesh "${name}" is a skinned mesh, which the effect samples as a mesh without a skin`,
    );
  }
  return { table: surfaceTableOf(mesh.geometry, name, PLAIN), mesh };
}

/**
 * @internal The surface of the skinned mesh `mesh`, the asset `name`, posed by its skeleton.
 * @throws When it is no skinned mesh or has no skeleton bones, or its geometry cannot be read (see
 *   `meshSurfaceOf`) or has no `skinIndex` and `skinWeight`.
 */
export function skinnedSurfaceOf(mesh: Mesh, name: string): FXObjectSurface<SkinnedMesh> {
  const skinned = mesh as Partial<SkinnedMesh>;

  if (
    skinned.isSkinnedMesh !== true ||
    skinned.skeleton === undefined ||
    skinned.skeleton.bones.length === 0
  ) {
    throw new Error(
      `FXEmitter.fromArtifacts: mesh "${name}" is no skinned mesh with skeleton bones`,
    );
  }
  return { table: surfaceTableOf(mesh.geometry, name, SKINNED), mesh: mesh as SkinnedMesh };
}

function surfaceTableOf(
  geometry: BufferGeometry,
  name: string,
  kind: FXSurfaceTableKind,
): FXSurfaceTable {
  const versions = [
    versionOf(geometry.getIndex()),
    ...["position", ...kind.attributes].map((attribute) =>
      versionOf(geometry.getAttribute(attribute)),
    ),
  ].join(",");
  const known = kind.tables.get(geometry);
  if (known?.versions === versions) {
    return known.table;
  }
  const table = buildSurfaceTable(geometry, name, kind);
  kind.tables.set(geometry, { versions, table });
  return table;
}

function versionOf(attribute: FXVertexAttribute | null | undefined): number {
  if (attribute === null || attribute === undefined) {
    return -1;
  }
  return "isInterleavedBufferAttribute" in attribute ? attribute.data.version : attribute.version;
}

/**
 * Every triangle of `geometry` (indexed or not), its vertices and normals, and the alias table of
 * their areas - without a `normal` attribute, each triangle's own normal at all three vertices.
 * A skinned table adds each vertex's `skinIndex` and `skinWeight`. The areas are those of the
 * geometry as it is, unposed.
 */
function buildSurfaceTable(
  geometry: BufferGeometry,
  name: string,
  kind: FXSurfaceTableKind,
): FXSurfaceTable {
  const fail = (reason: string): never => {
    throw new Error(`FXEmitter.fromArtifacts: geometry "${name}" ${reason}`);
  };
  const position = geometry.getAttribute("position") as FXVertexAttribute | undefined;
  if (position === undefined) {
    return fail("has no position attribute to sample");
  }
  const normal = geometry.getAttribute("normal") as FXVertexAttribute | undefined;
  const skin = kind.skin ? skinAttributesOf(geometry) : undefined;
  if (kind.skin && skin === undefined) {
    return fail("has no skinIndex and skinWeight attributes to pose its surface");
  }
  const index = geometry.getIndex();
  const triangles = Math.floor((index === null ? position.count : index.count) / 3);
  if (triangles === 0) {
    return fail("has no triangle to sample");
  }

  const stride = kind.stride;
  const floatAt = (triangle: number, offset: number): number =>
    (FX_SURFACE_HEADER_TEXELS + triangle * stride + offset) * FX_SURFACE_TEXEL_FLOATS;
  const texels = FX_SURFACE_HEADER_TEXELS + triangles * stride;
  const data = new Float32Array(texels * FX_SURFACE_TEXEL_FLOATS);
  data[0] = triangles;
  const areas = new Float64Array(triangles);
  let totalArea = 0;
  const vertices = [0, 0, 0];

  for (let triangle = 0; triangle < triangles; triangle += 1) {
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = triangle * 3 + corner;
      vertices[corner] = index === null ? vertex : index.getX(vertex);
      const at = floatAt(triangle, FX_SURFACE_VERTEX_A + corner);
      data[at] = position.getX(vertices[corner]);
      data[at + 1] = position.getY(vertices[corner]);
      data[at + 2] = position.getZ(vertices[corner]);
    }
    const a = floatAt(triangle, FX_SURFACE_VERTEX_A);
    const b = floatAt(triangle, FX_SURFACE_VERTEX_B);
    const c = floatAt(triangle, FX_SURFACE_VERTEX_C);
    // The edges from a; their cross product is twice the area along the face normal.
    const e1x = data[b] - data[a];
    const e1y = data[b + 1] - data[a + 1];
    const e1z = data[b + 2] - data[a + 2];
    const e2x = data[c] - data[a];
    const e2y = data[c + 1] - data[a + 1];
    const e2z = data[c + 2] - data[a + 2];
    const cx = e1y * e2z - e1z * e2y;
    const cy = e1z * e2x - e1x * e2z;
    const cz = e1x * e2y - e1y * e2x;
    const doubleArea = Math.sqrt(cx * cx + cy * cy + cz * cz);
    areas[triangle] = doubleArea;
    totalArea += doubleArea;

    for (let corner = 0; corner < 3; corner += 1) {
      const at = floatAt(triangle, FX_SURFACE_NORMAL_A + corner);
      if (normal !== undefined) {
        data[at] = normal.getX(vertices[corner]);
        data[at + 1] = normal.getY(vertices[corner]);
        data[at + 2] = normal.getZ(vertices[corner]);
      } else if (doubleArea > 0) {
        data[at] = cx / doubleArea;
        data[at + 1] = cy / doubleArea;
        data[at + 2] = cz / doubleArea;
      } else {
        data[at + 1] = 1;
      }
      if (skin !== undefined) {
        const vertex = vertices[corner];
        writeVector4(data, floatAt(triangle, FX_SURFACE_SKIN_INDEX_A + corner), skin.index, vertex);
        writeVector4(
          data,
          floatAt(triangle, FX_SURFACE_SKIN_WEIGHT_A + corner),
          skin.weight,
          vertex,
        );
      }
    }
  }
  if (!(totalArea > 0)) {
    return fail("has no area to sample");
  }
  writeAliasTable(data, areas, totalArea, floatAt);
  return { data, texels };
}

function skinAttributesOf(
  geometry: BufferGeometry,
): { readonly index: FXVertexAttribute; readonly weight: FXVertexAttribute } | undefined {
  const index = geometry.getAttribute("skinIndex") as FXVertexAttribute | undefined;
  const weight = geometry.getAttribute("skinWeight") as FXVertexAttribute | undefined;
  return index === undefined || weight === undefined ? undefined : { index, weight };
}

function writeVector4(
  data: Float32Array,
  at: number,
  attribute: FXVertexAttribute,
  vertex: number,
): void {
  data[at] = attribute.getX(vertex);
  data[at + 1] = attribute.getY(vertex);
  data[at + 2] = attribute.getZ(vertex);
  data[at + 3] = attribute.getW(vertex);
}

/**
 * Vose's alias method over `areas`: column `t` keeps triangle `t` with its probability and hands
 * the rest of its share to its alias, so a uniform column plus one coin picks a triangle with
 * probability proportional to its area.
 */
function writeAliasTable(
  data: Float32Array,
  areas: Float64Array,
  totalArea: number,
  floatAt: (triangle: number, offset: number) => number,
): void {
  const count = areas.length;
  // Each column's share, scaled so the mean is 1.
  const shares = new Float64Array(count);
  const small = new Int32Array(count);
  const large = new Int32Array(count);
  let smallCount = 0;
  let largeCount = 0;
  for (let i = 0; i < count; i += 1) {
    shares[i] = (areas[i] * count) / totalArea;
    if (shares[i] < 1) {
      small[smallCount++] = i;
    } else {
      large[largeCount++] = i;
    }
  }
  // The alias pair rides in the `w` of the column's first two texels.
  const probabilityAt = (column: number): number => floatAt(column, FX_SURFACE_VERTEX_A) + 3;
  const aliasAt = (column: number): number => floatAt(column, FX_SURFACE_VERTEX_B) + 3;
  while (smallCount > 0 && largeCount > 0) {
    const lacking = small[--smallCount];
    const giving = large[--largeCount];
    data[probabilityAt(lacking)] = shares[lacking];
    data[aliasAt(lacking)] = giving;
    shares[giving] -= 1 - shares[lacking];
    if (shares[giving] < 1) {
      small[smallCount++] = giving;
    } else {
      large[largeCount++] = giving;
    }
  }
  // What is left holds a whole column, up to rounding.
  for (let i = 0; i < largeCount; i += 1) {
    data[probabilityAt(large[i])] = 1;
    data[aliasAt(large[i])] = large[i];
  }
  for (let i = 0; i < smallCount; i += 1) {
    data[probabilityAt(small[i])] = 1;
    data[aliasAt(small[i])] = small[i];
  }
}

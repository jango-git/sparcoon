import type { BufferAttribute, BufferGeometry, InterleavedBufferAttribute } from "three";

import {
  FX_SURFACE_HEADER_TEXELS,
  FX_SURFACE_NORMAL_A,
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

interface FXSurfaceTableEntry {
  readonly versions: string;
  readonly table: FXSurfaceTable;
}

// Built once per geometry and shared by every emitter sampling it, rebuilt when the geometry's
// attributes were updated since.
const tables = new WeakMap<BufferGeometry, FXSurfaceTableEntry>();

/**
 * @internal The tables of `surfaces` (a kernel's `meshSurfaces`) by binding, each of the geometry
 * it names in `geometries`.
 * @throws When a named geometry is missing, has no positions, or has no area.
 */
export function surfaceTablesOf(
  surfaces: Readonly<Record<string, string>> | undefined,
  geometries: Readonly<Record<string, BufferGeometry>>,
): Record<string, FXSurfaceTable> {
  const result: Record<string, FXSurfaceTable> = {};
  for (const binding in surfaces) {
    const name = surfaces[binding];
    const geometry = geometries[name] as BufferGeometry | undefined;
    if (geometry === undefined) {
      throw new Error(
        `FXEmitter.fromArtifacts: no geometry "${name}" for the mesh surface it samples`,
      );
    }
    result[binding] = surfaceTableOf(geometry, name);
  }
  return result;
}

function surfaceTableOf(geometry: BufferGeometry, name: string): FXSurfaceTable {
  const versions = versionsOf(geometry);
  const known = tables.get(geometry);
  if (known?.versions === versions) {
    return known.table;
  }
  const table = buildSurfaceTable(geometry, name);
  tables.set(geometry, { versions, table });
  return table;
}

function versionOf(attribute: FXVertexAttribute | null | undefined): number {
  if (attribute === null || attribute === undefined) {
    return -1;
  }
  return "isInterleavedBufferAttribute" in attribute ? attribute.data.version : attribute.version;
}

function versionsOf(geometry: BufferGeometry): string {
  return [
    versionOf(geometry.getIndex()),
    versionOf(geometry.getAttribute("position")),
    versionOf(geometry.getAttribute("normal")),
  ].join(",");
}

/** Every triangle of `geometry` (indexed or not), its vertices and normals, and the alias table of
 *  their areas - without a `normal` attribute, each triangle's own normal at all three vertices. */
function buildSurfaceTable(geometry: BufferGeometry, name: string): FXSurfaceTable {
  const fail = (reason: string): never => {
    throw new Error(`FXEmitter.fromArtifacts: geometry "${name}" ${reason}`);
  };
  const position = geometry.getAttribute("position") as FXVertexAttribute | undefined;
  if (position === undefined) {
    return fail("has no position attribute to sample");
  }
  const normal = geometry.getAttribute("normal") as FXVertexAttribute | undefined;
  const index = geometry.getIndex();
  const triangles = Math.floor((index === null ? position.count : index.count) / 3);
  if (triangles === 0) {
    return fail("has no triangle to sample");
  }

  const texels = FX_SURFACE_HEADER_TEXELS + triangles * FX_SURFACE_TEXELS_PER_TRIANGLE;
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
    }
  }
  if (!(totalArea > 0)) {
    return fail("has no area to sample");
  }
  writeAliasTable(data, areas, totalArea);
  return { data, texels };
}

/** Where texel `offset` of triangle `triangle` starts in the table's floats. */
function floatAt(triangle: number, offset: number): number {
  return (
    (FX_SURFACE_HEADER_TEXELS + triangle * FX_SURFACE_TEXELS_PER_TRIANGLE + offset) *
    FX_SURFACE_TEXEL_FLOATS
  );
}

/**
 * Vose's alias method over `areas`: column `t` keeps triangle `t` with its probability and hands
 * the rest of its share to its alias, so a uniform column plus one coin picks a triangle with
 * probability proportional to its area.
 */
function writeAliasTable(data: Float32Array, areas: Float64Array, totalArea: number): void {
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

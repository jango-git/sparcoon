import { BufferAttribute, BufferGeometry } from "three";
import { describe, expect, it } from "vitest";

import { kernelResourcesOf } from "../../src/emitter/FXKernelResources.Internal";
import { meshSurfaceOf } from "../../src/emitter/FXSurfaceTable.Internal";
import {
  FX_SURFACE_HEADER_TEXELS,
  FX_SURFACE_NORMAL_A,
  FX_SURFACE_TEXEL_FLOATS,
  FX_SURFACE_TEXELS_PER_TRIANGLE,
  FX_SURFACE_VERTEX_A,
  FX_SURFACE_VERTEX_B,
} from "../../src/surfaceTableLayout";

function triangles(positions: number[], index?: number[], normals?: number[]): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  if (normals !== undefined) {
    geometry.setAttribute("normal", new BufferAttribute(new Float32Array(normals), 3));
  }
  if (index !== undefined) {
    geometry.setIndex(index);
  }
  return geometry;
}

function texel(data: Float32Array, triangle: number, offset: number): number[] {
  const at =
    (FX_SURFACE_HEADER_TEXELS + triangle * FX_SURFACE_TEXELS_PER_TRIANGLE + offset) *
    FX_SURFACE_TEXEL_FLOATS;
  return [...data.subarray(at, at + FX_SURFACE_TEXEL_FLOATS)];
}

/** The chance the alias table picks each triangle: a uniform column, then its coin. */
function pickChances(data: Float32Array): number[] {
  const count = data[0];
  const chances = new Array<number>(count).fill(0);
  for (let column = 0; column < count; column += 1) {
    const probability = texel(data, column, FX_SURFACE_VERTEX_A)[3];
    const alias = texel(data, column, FX_SURFACE_VERTEX_B)[3];
    chances[column] += probability / count;
    chances[alias] += (1 - probability) / count;
  }
  return chances;
}

// Areas 1, 2, 3 and 2 (right triangles with legs 1x2, 2x2, 2x3, 1x4).
const FOUR = triangles([
  0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 0, 1, 0, 0,
  0, 4, 0,
]);

describe("meshSurfaceOf", () => {
  it("picks each triangle in proportion to its area", () => {
    const { data } = meshSurfaceOf(FOUR, "four");
    expect(data[0]).toBe(4);
    const chances = pickChances(data);
    [1 / 8, 2 / 8, 3 / 8, 2 / 8].forEach((expected, i) => {
      expect(chances[i]).toBeCloseTo(expected, 6);
    });
  });

  it("reads an indexed geometry's vertices and normals", () => {
    const geometry = triangles(
      [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0],
      [0, 1, 2, 2, 1, 3],
      [0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 0],
    );
    const { data, texels } = meshSurfaceOf(geometry, "quad");
    expect(texels).toBe(FX_SURFACE_HEADER_TEXELS + 2 * FX_SURFACE_TEXELS_PER_TRIANGLE);
    expect(texel(data, 1, FX_SURFACE_VERTEX_A).slice(0, 3)).toEqual([0, 1, 0]);
    expect(texel(data, 1, FX_SURFACE_NORMAL_A + 2).slice(0, 3)).toEqual([1, 0, 0]);
  });

  it("gives a geometry without normals each triangle's own", () => {
    const { data } = meshSurfaceOf(FOUR, "four");
    for (let corner = 0; corner < 3; corner += 1) {
      expect(texel(data, 0, FX_SURFACE_NORMAL_A + corner).slice(0, 3)).toEqual([0, 0, 1]);
    }
  });

  it("builds a geometry's table once, and anew after its positions change", () => {
    const geometry = triangles([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const first = meshSurfaceOf(geometry, "g");
    expect(meshSurfaceOf(geometry, "g")).toBe(first);
    geometry.getAttribute("position").needsUpdate = true;
    expect(meshSurfaceOf(geometry, "g")).not.toBe(first);
  });

  it("requires the geometry, and an area on it", () => {
    expect(() =>
      kernelResourcesOf(
        { meshSurfaces: { b: "missing" } },
        { geometries: {}, meshes: {}, volumes: {} },
      ),
    ).toThrow(/no geometry "missing"/);
    const flat = triangles([0, 0, 0, 1, 0, 0, 2, 0, 0]);
    expect(() => meshSurfaceOf(flat, "flat")).toThrow(/no area/);
  });
});

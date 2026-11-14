import {
  BoxGeometry,
  BufferGeometry,
  Float32BufferAttribute,
  PlaneGeometry,
  SphereGeometry,
} from "three";

import type { FXGeometryPrimitive, FXGeometrySource } from "../artifact/FXArtifact.js";

/**
 * @internal Base (non-instanced) mesh a {@link FXInstancedParticle} instances once per particle.
 * Carries standard `position`/`uv`/`normal` + index so the geometry-agnostic vertex epilogue can
 * transform real mesh vertices. `"plane"` is the unit XY quad (+Z normal) used for billboards, and
 * `"octagon"` the same quad with its corners cut (see {@link buildOctagonGeometry}).
 * The result is transient - the caller copies its attributes and discards it.
 */
export function buildPrimitiveGeometry(primitive: FXGeometryPrimitive): BufferGeometry {
  switch (primitive) {
    case "plane":
      return new PlaneGeometry(1, 1);
    case "octagon":
      return buildOctagonGeometry();
    case "box":
      return new BoxGeometry(1, 1, 1);
    case "sphere":
      return new SphereGeometry(0.5, 24, 16);
  }
}

/** Where the octagon's edges meet the quad's: `tan(pi / 8) / 2` either side of each side's middle. */
const OCTAGON_HALF_SIDE = 0.5 * Math.tan(Math.PI / 8);

/**
 * The regular octagon inscribed in the unit XY quad, `2 * (sqrt(2) - 1)` (83%) of its area. Its uv
 * is the quad's at the same point, so a texture maps onto it as onto `"plane"`, less the corners.
 * The inner square and the four corner triangles have the shortest inner edges of any split, so
 * the fewest pixels along them are shaded twice.
 */
function buildOctagonGeometry(): BufferGeometry {
  const s = OCTAGON_HALF_SIDE;
  // Counter-clockwise seen from +Z, from the right side's lower end.
  const corners = [0.5, -s, 0.5, s, s, 0.5, -s, 0.5, -0.5, s, -0.5, -s, -s, -0.5, s, -0.5];
  const position: number[] = [];
  const uv: number[] = [];
  const normal: number[] = [];
  for (let i = 0; i < corners.length; i += 2) {
    position.push(corners[i], corners[i + 1], 0);
    uv.push(corners[i] + 0.5, corners[i + 1] + 0.5);
    normal.push(0, 0, 1);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(position, 3));
  geometry.setAttribute("normal", new Float32BufferAttribute(normal, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uv, 2));
  geometry.setIndex([1, 3, 5, 1, 5, 7, 1, 2, 3, 3, 4, 5, 5, 6, 7, 7, 0, 1]);
  return geometry;
}

/**
 * Resolves an artifact's {@link FXGeometrySource} to a concrete `BufferGeometry`: a
 * built-in primitive is built fresh; a `"custom"` slot is looked up by name in `customGeometries`
 * (app-supplied, e.g. from the exported module's `assets` or the editor's own live content
 * library) - falling back to the `"plane"` primitive when the name is unbound, the same graceful
 * degradation an unbound external texture slot gets.
 */
export function resolveGeometrySource(
  source: FXGeometrySource | undefined,
  customGeometries: Readonly<Record<string, BufferGeometry>>,
): BufferGeometry {
  if (source === undefined || source.type === "primitive") {
    return buildPrimitiveGeometry(source?.primitive ?? "plane");
  }
  return customGeometries[source.external] ?? buildPrimitiveGeometry("plane");
}

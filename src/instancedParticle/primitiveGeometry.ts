import type { BufferGeometry } from "three";
import { BoxGeometry, PlaneGeometry, SphereGeometry } from "three";
import type { FXGeometryPrimitive, FXGeometrySource } from "../artifact/FXArtifact.js";

/**
 * @internal Base (non-instanced) mesh a {@link FXInstancedParticle} instances once per particle.
 * Carries standard `position`/`uv`/`normal` + index so the geometry-agnostic vertex epilogue can
 * transform real mesh vertices. `"plane"` is the unit XY quad (+Z normal) used for billboards.
 * The result is transient - the caller copies its attributes and discards it.
 */
export function buildPrimitiveGeometry(primitive: FXGeometryPrimitive): BufferGeometry {
  switch (primitive) {
    case "plane":
      return new PlaneGeometry(1, 1);
    case "box":
      return new BoxGeometry(1, 1, 1);
    case "sphere":
      return new SphereGeometry(0.5, 24, 16);
  }
}

/**
 * @internal Resolves an artifact's {@link FXGeometrySource} to a concrete `BufferGeometry`: a
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

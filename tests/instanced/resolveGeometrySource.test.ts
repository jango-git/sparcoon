import { describe, expect, it } from "vitest";
import { BoxGeometry, BufferGeometry, PlaneGeometry } from "three";
import { resolveGeometrySource } from "../../src/instancedParticle/primitiveGeometry";

describe("resolveGeometrySource", () => {
  it("builds the plane primitive when the source is absent", () => {
    const geometry = resolveGeometrySource(undefined, {});
    expect(geometry).toBeInstanceOf(PlaneGeometry);
  });

  it("builds the named built-in primitive", () => {
    const geometry = resolveGeometrySource({ type: "primitive", primitive: "box" }, {});
    expect(geometry).toBeInstanceOf(BoxGeometry);
  });

  it("returns the app-supplied geometry for a bound custom slot", () => {
    const custom = new BufferGeometry();
    const geometry = resolveGeometrySource(
      { type: "custom", external: "myMesh" },
      { myMesh: custom },
    );
    expect(geometry).toBe(custom);
  });

  it("falls back to the plane primitive for an unbound custom slot", () => {
    const geometry = resolveGeometrySource({ type: "custom", external: "missing" }, {});
    expect(geometry).toBeInstanceOf(PlaneGeometry);
  });
});

import { BoxGeometry, BufferGeometry, PlaneGeometry, SphereGeometry } from "three";
import { describe, expect, it } from "vitest";

import { resolveGeometrySource } from "../../src/instancedParticle/primitiveGeometry";

describe("resolveGeometrySource", () => {
  it("builds the plane primitive when the source is absent", () => {
    const geometry = resolveGeometrySource(undefined, {});
    expect(geometry).toBeInstanceOf(PlaneGeometry);
  });

  it.each([
    { primitive: "plane", type: PlaneGeometry },
    { primitive: "box", type: BoxGeometry },
    { primitive: "sphere", type: SphereGeometry },
  ] as const)("builds the named built-in $primitive primitive", ({ primitive, type }) => {
    const geometry = resolveGeometrySource({ type: "primitive", primitive }, {});
    expect(geometry).toBeInstanceOf(type);
  });

  it("builds the octagon as the unit quad less its corners, mapped like the plane", () => {
    const geometry = resolveGeometrySource({ type: "primitive", primitive: "octagon" }, {});
    const position = geometry.getAttribute("position");
    const uv = geometry.getAttribute("uv");
    const normal = geometry.getAttribute("normal");
    expect(position.count).toBe(8);
    for (let i = 0; i < position.count; i++) {
      expect(Math.max(Math.abs(position.getX(i)), Math.abs(position.getY(i)))).toBeCloseTo(0.5);
      expect(position.getZ(i)).toBe(0);
      expect(uv.getX(i)).toBeCloseTo(position.getX(i) + 0.5);
      expect(uv.getY(i)).toBeCloseTo(position.getY(i) + 0.5);
      expect([normal.getX(i), normal.getY(i), normal.getZ(i)]).toEqual([0, 0, 1]);
    }
    const index = geometry.getIndex()!;
    expect(index.count).toBe(18);
    let area = 0;
    for (let t = 0; t < index.count; t += 3) {
      const [a, b, c] = [index.getX(t), index.getX(t + 1), index.getX(t + 2)];
      // Positive: every triangle faces +Z, as the plane's do.
      const cross =
        (position.getX(b) - position.getX(a)) * (position.getY(c) - position.getY(a)) -
        (position.getY(b) - position.getY(a)) * (position.getX(c) - position.getX(a));
      expect(cross).toBeGreaterThan(0);
      area += cross / 2;
    }
    expect(area).toBeCloseTo(2 * (Math.SQRT2 - 1));
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

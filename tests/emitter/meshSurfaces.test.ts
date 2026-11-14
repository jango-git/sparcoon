import { BufferAttribute, BufferGeometry } from "three";
import { describe, expect, it } from "vitest";

import type { FXBehaviorArtifact } from "../../src/artifact/FXArtifact";
import { FXEmitter } from "../../src/emitter/FXEmitter";
import { behaviorArtifact, unlitArtifact } from "../helpers/artifacts";
import { landBirths } from "../helpers/internals";

function rock(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
  );
  return geometry;
}

/** A behavior sampling the surface `rock` through binding `s`, recording what its spawn reads. */
function sampling(seen: unknown[]): FXBehaviorArtifact {
  const base = behaviorArtifact();
  return {
    ...base,
    meshSurfaces: { s: "rock" },
    spawn(slots, start, count, bindings, emitter, inherited): void {
      seen.push(bindings["s"]?.value);
      base.spawn?.(slots, start, count, bindings, emitter, inherited);
    },
  };
}

describe("FXEmitter mesh surfaces", () => {
  it("hands the behavior the table of the geometry its surface names", () => {
    const seen: unknown[] = [];
    const emitter = FXEmitter.fromArtifacts(unlitArtifact(), sampling(seen), {
      geometries: { rock: rock() },
    });
    try {
      emitter.burst(1);
      landBirths(emitter);
      const table = seen[0] as Float32Array;
      expect(table).toBeInstanceOf(Float32Array);
      expect(table[0]).toBe(1);
    } finally {
      emitter.destroy();
    }
  });

  it("keeps the table through a value scrub of the same name", () => {
    const seen: unknown[] = [];
    const emitter = FXEmitter.fromArtifacts(unlitArtifact(), sampling(seen), {
      geometries: { rock: rock() },
    });
    try {
      emitter.applyValues({ bindings: { s: 7 } });
      emitter.burst(1);
      landBirths(emitter);
      expect(seen[0]).toBeInstanceOf(Float32Array);
    } finally {
      emitter.destroy();
    }
  });

  it("requires the geometry", () => {
    expect(() => FXEmitter.fromArtifacts(unlitArtifact(), sampling([]))).toThrow(
      /no geometry "rock"/,
    );
  });
});

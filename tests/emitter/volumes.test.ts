import { Data3DTexture, RedFormat } from "three";
import { describe, expect, it } from "vitest";

import type { FXBehaviorArtifact } from "../../src/artifact/FXArtifact";
import { FXEmitter } from "../../src/emitter/FXEmitter";
import { behaviorArtifact, unlitArtifact } from "../helpers/artifacts";
import { landBirths } from "../helpers/internals";

function field(): Data3DTexture {
  const texture = new Data3DTexture(new Uint8Array([0, 255]), 2, 1, 1);
  texture.format = RedFormat;
  return texture;
}

/** A behavior sampling the volume `field` through binding `v`, recording what its spawn reads. */
function sampling(seen: unknown[]): FXBehaviorArtifact {
  const base = behaviorArtifact();
  return {
    ...base,
    volumes: { v: "field" },
    spawn(slots, start, count, bindings, emitter, inherited): void {
      seen.push(bindings["v"]?.value);
      base.spawn?.(slots, start, count, bindings, emitter, inherited);
    },
  };
}

describe("FXEmitter volumes", () => {
  it("hands the behavior the table of the 3D texture its volume names", () => {
    const seen: unknown[] = [];
    const emitter = FXEmitter.fromArtifacts(sampling(seen), {
      particles: unlitArtifact(),
      volumes: { field: field() },
    });
    try {
      emitter.burst(1);
      landBirths(emitter);
      expect([...(seen[0] as Float32Array)]).toEqual([2, 1, 1, 0, 1]);
    } finally {
      emitter.destroy();
    }
  });

  it("keeps the table through a value scrub of the same name", () => {
    const seen: unknown[] = [];
    const emitter = FXEmitter.fromArtifacts(sampling(seen), {
      particles: unlitArtifact(),
      volumes: { field: field() },
    });
    try {
      emitter.applyValues({ bindings: { v: 7 } });
      emitter.burst(1);
      landBirths(emitter);
      expect(seen[0]).toBeInstanceOf(Float32Array);
    } finally {
      emitter.destroy();
    }
  });

  it("requires the 3D texture", () => {
    expect(() => FXEmitter.fromArtifacts(sampling([]), { particles: unlitArtifact() })).toThrow(
      /no 3D texture "field"/,
    );
  });
});

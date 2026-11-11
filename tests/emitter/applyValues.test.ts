import { describe, expect, it } from "vitest";
import { FXEmitter } from "../../src/emitter/FXEmitter";
import type { FXBehaviorArtifact } from "../../src/artifact/FXArtifact";
import {
  FX_CORE_LIFECYCLE,
  FX_CORE_POSITION,
  FX_LIFETIME,
  FX_POSITION_Y,
} from "../../src/coreLayout";
import { unlitArtifact } from "../helpers/artifacts";
import { landBirths, particlesOf, tickEmitter } from "../helpers/internals";
import { fieldBehavior, fieldOf } from "../helpers/slots";

// The render-uniform half of applyValues is FXArtifactMaterial.applyUniformValues
// (render/materialContract.test.ts); the trail's share of it, trail.test.ts.

/**
 * A behavior artifact with a live `gravity` binding: spawn seeds `lifetime`, and update
 * accumulates `gravity` into each particle's `position.y`. Scrubbing the binding must be
 * read on the next tick.
 */
function gravityBehavior(gravity: number): FXBehaviorArtifact {
  return fieldBehavior({
    buffers: [
      { name: FX_CORE_POSITION, stride: 3 },
      { name: FX_CORE_LIFECYCLE, stride: 3 },
    ],
    bindings: { b_gravity$0: { value: gravity } },
    spawn(fields, start, count): void {
      const lifecycle = fields[FX_CORE_LIFECYCLE];
      for (let i = start; i < start + count; i++) {
        lifecycle[i * 3 + FX_LIFETIME] = 1000;
      }
    },
    update(fields, count, dt, bindings): void {
      const position = fields[FX_CORE_POSITION];
      const g = bindings["b_gravity$0"].value as number;
      for (let i = 0; i < count; i++) {
        position[i * 3 + FX_POSITION_Y] += g * dt;
      }
    },
  });
}

describe("FXEmitter.applyValues - behavior bindings", () => {
  it("scrubs a binding value that the next update tick reads", () => {
    const emitter = FXEmitter.fromArtifacts(unlitArtifact(), gravityBehavior(-1));
    try {
      emitter.burst(1);
      landBirths(emitter);
      const posY = (): number => fieldOf(particlesOf(emitter), FX_CORE_POSITION)[FX_POSITION_Y];

      tickEmitter(emitter, 1); // gravity -1 -> y = -1
      expect(posY()).toBeCloseTo(-1, 6);

      emitter.applyValues({ bindings: { b_gravity$0: 10 } });
      tickEmitter(emitter, 1); // gravity now +10 -> y = -1 + 10 = 9
      expect(posY()).toBeCloseTo(9, 6);
    } finally {
      emitter.destroy();
    }
  });

  it("ignores an unknown binding name", () => {
    const emitter = FXEmitter.fromArtifacts(unlitArtifact(), gravityBehavior(-1));
    try {
      emitter.applyValues({ bindings: { nope$9: 42 } });
      // The real binding is untouched.
      emitter.burst(1);
      landBirths(emitter);
      tickEmitter(emitter, 1);
      expect(fieldOf(particlesOf(emitter), FX_CORE_POSITION)[FX_POSITION_Y]).toBeCloseTo(-1, 6);
    } finally {
      emitter.destroy();
    }
  });
});

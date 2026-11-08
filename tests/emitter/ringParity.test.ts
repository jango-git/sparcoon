import { afterEach, describe, expect, it, vi } from "vitest";
import type { FXBehaviorArtifact, FXKernelBuffers } from "../../src/artifact/FXArtifact";
import { FXEmitter } from "../../src/emitter/FXEmitter";
import {
  FX_AGE,
  FX_CORE_LIFECYCLE,
  FX_CORE_POSITION,
  FX_ID,
  FX_POSITION_X,
} from "../../src/coreLayout";
import type { FXInstancedParticle } from "../../src/instancedParticle/FXInstancedParticle";
import { behaviorArtifact, unlitArtifact } from "../helpers/artifacts";

/**
 * The JS backend kept step-for-step with the GPU backend's fused transform-feedback pass: one
 * fixed ring, the update runs over slots that existed before the tick and reads their age as of
 * the previous tick, and a particle born in a tick is seeded but not updated until the next.
 */

function tickEmitter(emitter: FXEmitter, dt: number): void {
  (emitter as unknown as { tick(deltaTime: number): void }).tick(dt);
}

/** Each update moves a live particle +1 along x and records the ages it read. */
function steppingBehavior(agesSeen: number[], lifetime = 10): FXBehaviorArtifact {
  return behaviorArtifact({
    lifetime,
    updateWrittenBuffers: [FX_CORE_POSITION],
    update(buffers: FXKernelBuffers, count: number): void {
      const position = buffers[FX_CORE_POSITION];
      const lifecycle = buffers[FX_CORE_LIFECYCLE];
      for (let i = 0; i < count; i++) {
        if (lifecycle[i * 3 + FX_AGE] >= lifecycle[i * 3 + 1]) {
          continue; // dead slot - its state is never shown, so not recorded here
        }
        agesSeen.push(lifecycle[i * 3 + FX_AGE]);
        position[i * 3 + FX_POSITION_X] += 1;
      }
    },
  });
}

function positionX(emitter: FXEmitter, slot: number): number {
  const mesh = (
    emitter as unknown as { mesh: { propertyBuffers: Record<string, { array: Float32Array }> } }
  ).mesh;
  return mesh.propertyBuffers[FX_CORE_POSITION].array[slot * 3 + FX_POSITION_X];
}

describe("JS backend tick order matches the GPU fused pass", () => {
  it("does not update a particle in the tick it is born in", () => {
    const agesSeen: number[] = [];
    const emitter = FXEmitter.fromArtifacts(unlitArtifact(), steppingBehavior(agesSeen));
    try {
      // Born inside the tick (a delayed burst expiring) - seeded, not stepped.
      emitter.burst(1, { delay: 0.01 });
      tickEmitter(emitter, 0.1);
      expect(emitter.particleCount).toBe(1);
      expect(positionX(emitter, 0)).toBe(0);
      expect(agesSeen).toEqual([]);

      // Stepped from the next tick on.
      tickEmitter(emitter, 0.1);
      expect(positionX(emitter, 0)).toBe(1);
    } finally {
      emitter.destroy();
    }
  });

  it("lets the update read the age as of the previous tick, then ages the particle", () => {
    const agesSeen: number[] = [];
    const emitter = FXEmitter.fromArtifacts(unlitArtifact(), steppingBehavior(agesSeen));
    try {
      emitter.burst(1);
      tickEmitter(emitter, 0.25);
      tickEmitter(emitter, 0.25);
      expect(agesSeen).toEqual([0, 0.25]);
    } finally {
      emitter.destroy();
    }
  });
});

describe("fixed ring capacity", () => {
  it("defaults to 256 particles and never grows", () => {
    const emitter = FXEmitter.fromArtifacts(unlitArtifact(), behaviorArtifact({ lifetime: 10 }));
    try {
      expect(emitter.particleCapacity).toBe(256);
      emitter.burst(300);
      expect(emitter.particleCapacity).toBe(256);
      expect(emitter.particleCount).toBe(256);
      expect(emitter.particleOverflowCount).toBe(44);
    } finally {
      emitter.destroy();
    }
  });

  it("reports overwritten live particles once the ring is full", () => {
    const emitter = FXEmitter.fromArtifacts(unlitArtifact(), behaviorArtifact({ lifetime: 10 }), {
      expectedCapacity: 4,
    });
    try {
      emitter.burst(4);
      expect(emitter.particleOverflowCount).toBe(0);
      emitter.burst(2);
      expect(emitter.particleCount).toBe(4);
      expect(emitter.particleOverflowCount).toBe(2);
    } finally {
      emitter.destroy();
    }
  });

  it("reuses dead slots without counting them as overflow", () => {
    const emitter = FXEmitter.fromArtifacts(unlitArtifact(), behaviorArtifact({ lifetime: 1 }), {
      expectedCapacity: 4,
    });
    try {
      emitter.burst(4);
      tickEmitter(emitter, 2); // all four die
      expect(emitter.particleCount).toBe(0);
      emitter.burst(4);
      expect(emitter.particleCount).toBe(4);
      expect(emitter.particleOverflowCount).toBe(0);
    } finally {
      emitter.destroy();
    }
  });

  it("clears every particle and rewinds the ring on reset()", () => {
    const agesSeen: number[] = [];
    const emitter = FXEmitter.fromArtifacts(unlitArtifact(), steppingBehavior(agesSeen), {
      expectedCapacity: 4,
    });
    try {
      emitter.burst(3);
      emitter.reset();
      expect(emitter.particleCount).toBe(0);
      tickEmitter(emitter, 0.1);
      expect(agesSeen).toEqual([]); // nothing left alive to update
      emitter.burst(1);
      expect(positionX(emitter, 0)).toBe(0);
    } finally {
      emitter.destroy();
    }
  });
});

function particlesOf(emitter: FXEmitter): FXInstancedParticle {
  return (emitter as unknown as { mesh: FXInstancedParticle }).mesh;
}

describe("an idle JS emitter (nothing alive)", () => {
  /** A behavior counting its update calls. */
  function countingBehavior(lifetime: number): { behavior: FXBehaviorArtifact; updates: number[] } {
    const updates: number[] = [];
    const behavior = behaviorArtifact({
      lifetime,
      updateWrittenBuffers: [FX_CORE_POSITION],
      update(_buffers: FXKernelBuffers, count: number): void {
        updates.push(count);
      },
    });
    return { behavior, updates };
  }

  it("skips the update, the aging and the uploads once the last particle died", () => {
    const { behavior, updates } = countingBehavior(0.1);
    const emitter = FXEmitter.fromArtifacts(unlitArtifact(), behavior, { expectedCapacity: 1000 });
    try {
      emitter.burst(1000);
      tickEmitter(emitter, 1); // updated, then aged past its lifetime
      expect(updates).toEqual([1000]);
      expect(emitter.particleCount).toBe(0);

      const mesh = particlesOf(emitter);
      const lifecycle = mesh.propertyBuffers[FX_CORE_LIFECYCLE];
      const ages = Array.from(lifecycle.array);
      const version = lifecycle.version;
      for (let i = 0; i < 5; i++) {
        tickEmitter(emitter, 1);
      }
      expect(updates).toEqual([1000]);
      expect(Array.from(lifecycle.array)).toEqual(ages); // every slot stays dead as it was
      expect(lifecycle.version).toBe(version); // nothing re-uploaded
      // The drawn range is kept (a trail relies on it), but no instance is drawn.
      expect(mesh.instanceCount).toBe(1000);
      expect((mesh.geometry as unknown as { instanceCount: number }).instanceCount).toBe(0);

      // A birth wakes it: drawn again, and updated from the next tick on (dead slots included).
      emitter.burst(1);
      expect((mesh.geometry as unknown as { instanceCount: number }).instanceCount).toBe(1000);
      tickEmitter(emitter, 0.01);
      expect(updates).toEqual([1000, 1000]);
      expect(emitter.particleCount).toBe(1);
    } finally {
      emitter.destroy();
    }
  });
});

describe("particle ids", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function idOf(emitter: FXEmitter, slot: number): number {
    return particlesOf(emitter).propertyBuffers[FX_CORE_LIFECYCLE].array[slot * 3 + FX_ID];
  }

  it("takes one id per birth asked for, seeded or not, as the GPU kernel numbers them", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const emitter = FXEmitter.fromArtifacts(unlitArtifact(), behaviorArtifact({ lifetime: 10 }), {
      expectedCapacity: 4,
    });
    try {
      emitter.burst(3); // slots 0..2: ids 0..2, cursor 3
      emitter.burst(6); // seeds slots 3, 0, 1, 2 with ids 3..6; ids 7 and 8 are spent
      expect([0, 1, 2, 3].map((slot) => idOf(emitter, slot))).toEqual([4, 5, 6, 3]);
      emitter.burst(1); // cursor (3 + 6) % 4 = 1
      expect(idOf(emitter, 1)).toBe(9);
    } finally {
      emitter.destroy();
    }
  });
});

describe("ring overflow warning", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns once per emitter, on the first overflow, in a development build", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const emitter = FXEmitter.fromArtifacts(unlitArtifact(), behaviorArtifact({ lifetime: 10 }), {
      expectedCapacity: 2,
    });
    try {
      emitter.burst(2);
      expect(warn).not.toHaveBeenCalled();
      emitter.burst(1);
      emitter.burst(5);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/capacity \(2\)/);
    } finally {
      emitter.destroy();
    }
  });
});

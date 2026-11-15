import type { InterleavedBufferAttribute, ShaderMaterial } from "three";
import { PerspectiveCamera } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FXParticleKernelArtifact } from "../../src/artifact/FXArtifact";
import { FX_CORE_LIFECYCLE, FX_CORE_POSITION, FX_PARTICLE_ID_RANGE } from "../../src/coreLayout";
import { FXEmitter } from "../../src/emitter/FXEmitter";
import { fxStripRenderBudget } from "../../src/render/FXRenderBudget";
import type { FXRibbonOptions } from "../../src/ribbon/FXRibbon";
import { behaviorArtifact, renderForBothTargets, unlitArtifact } from "../helpers/artifacts";
import { effectSpec, emitterSpec, TestEffect } from "../helpers/effectSpecs";
import { particlesOf, ribbonOf, tickEmitter } from "../helpers/internals";
import { callsNamed, mockRenderer } from "../helpers/mockWebGL";
import { behaviorSlot } from "../helpers/slots";

/** Each update moves every particle +1 along x. */
function movingBehavior(lifetime = 10): ReturnType<typeof behaviorArtifact> {
  return behaviorArtifact({
    lifetime,
    update(fields, count): void {
      const position = fields[FX_CORE_POSITION];
      for (let i = 0; i < count; i++) {
        position[i * 3] += 1;
      }
    },
  });
}

function ribbonOptions(over: Partial<FXRibbonOptions> = {}): FXRibbonOptions {
  return { render: unlitArtifact(), ...over };
}

function cpuEmitter(
  ribbon: FXRibbonOptions = ribbonOptions(),
  capacity = 4,
  behavior = movingBehavior(),
): FXEmitter {
  return FXEmitter.fromArtifacts(behavior, {
    particles: unlitArtifact(),
    expectedCapacity: capacity,
    ribbon,
  });
}

/** Point `slot` of `emitter`'s CPU ribbon: its position x, id tag, tangent x and u. */
function point(
  emitter: FXEmitter,
  slot: number,
): { x: number; tag: number; tangentX: number; u: number } {
  const { array, stride } = ribbonOf(emitter).points;
  if (array === undefined || stride === undefined) {
    throw new Error("point: not a cpu ribbon");
  }
  const base = slot * stride;
  return { x: array[base], tag: array[base + 3], tangentX: array[base + 4], u: array[base + 7] };
}

function segments(emitter: FXEmitter): number {
  return (ribbonOf(emitter).mesh.geometry as unknown as { instanceCount: number }).instanceCount;
}

const KERNEL: FXParticleKernelArtifact = {
  vertexSource: "",
  fragmentSource: "",
  buffers: [
    { name: FX_CORE_POSITION, stride: 3 },
    { name: FX_CORE_LIFECYCLE, stride: 3 },
  ],
  transformFeedbackVaryings: ["out_position", "out_lifecycle"],
  bindings: {},
};

describe("ribbon - JS backend", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("draws a segment from every drawn slot to the next, both read from one buffer", () => {
    const emitter = cpuEmitter(ribbonOptions(), 3);
    try {
      expect(emitter.hasStrip("ribbon")).toBe(true);
      const { mesh } = ribbonOf(emitter);
      expect(mesh.parent).toBe(emitter);
      expect(segments(emitter)).toBe(0);
      emitter.burst(2);
      tickEmitter(emitter, 0.1);
      expect(segments(emitter)).toBe(2);
      const attributes = mesh.geometry.attributes as unknown as Record<
        string,
        InterleavedBufferAttribute
      >;
      const a = attributes["a_tA_trailPoint"];
      const b = attributes["a_tB_trailPoint"];
      expect(a.data).toBe(b.data);
      // The end point is the next one, a whole point further on.
      expect(b.offset - a.offset).toBe(a.data.stride);
      // Every slot plus the copy of the first after the last.
      expect(a.data.count).toBe(4);
      expect(Object.keys(attributes).sort()).toEqual([
        "a_tA_trailPoint",
        "a_tA_trailTangent",
        "a_tB_trailPoint",
        "a_tB_trailTangent",
        "position",
      ]);
    } finally {
      emitter.destroy();
    }
  });

  it("joins each particle to the one born before it, by id", () => {
    const emitter = cpuEmitter();
    try {
      emitter.burst(1);
      tickEmitter(emitter, 0.1);
      emitter.burst(1);
      tickEmitter(emitter, 0.1);
      // Slot 0 was born first and moved once since; slot 1 is newborn.
      expect(point(emitter, 0)).toMatchObject({ x: 1, tag: 1, tangentX: 0 });
      expect(point(emitter, 1)).toMatchObject({ x: 0, tag: 2, tangentX: -1 });
      // Never claimed: dead, and no joint.
      expect(point(emitter, 2)).toMatchObject({ tag: 0, tangentX: 0 });
    } finally {
      emitter.destroy();
    }
  });

  it("puts each point's age over its lifetime in u, or one repeat per `particles` when tiled", () => {
    const stretched = cpuEmitter(ribbonOptions(), 4, movingBehavior(2));
    const tiled = cpuEmitter(
      ribbonOptions({ uv: { mode: "tile", particles: 2 } }),
      4,
      movingBehavior(2),
    );
    try {
      for (const emitter of [stretched, tiled]) {
        emitter.burst(3);
        tickEmitter(emitter, 0.5);
        tickEmitter(emitter, 0.5);
      }
      // Born at the end of the first tick, so aged by the second alone.
      expect(point(stretched, 0).u).toBeCloseTo(0.25);
      // Ids 0, 1, 2: (2 - id % 2) / 2.
      expect([0, 1, 2].map((slot) => point(tiled, slot).u)).toEqual([1, 0.5, 1]);
    } finally {
      stretched.destroy();
      tiled.destroy();
    }
  });

  it("lays the ring out oldest first once it has gone round, and joins across its end", () => {
    const emitter = cpuEmitter(ribbonOptions(), 2);
    try {
      emitter.burst(2);
      tickEmitter(emitter, 0.1);
      // Ids 2 and 3 overwrite slots 0 and 1, then id 4 overwrites slot 0: the oldest is slot 1
      // (id 3), followed by slot 0 (id 4).
      emitter.burst(2);
      tickEmitter(emitter, 0.1);
      emitter.burst(1);
      tickEmitter(emitter, 0.1);
      expect(point(emitter, 0).tag).toBe(4);
      expect(point(emitter, 1).tag).toBe(5);
      expect(point(emitter, 1).tangentX).toBe(-1);
      // No head: the segment from the newest ends at a dead point.
      expect(point(emitter, 2).tag).toBe(0);
      expect(segments(emitter)).toBe(2);
    } finally {
      emitter.destroy();
    }
  });

  it("ends at the particle a birth would seed now while a play emits from the emitter's pose", () => {
    const emitter = cpuEmitter(ribbonOptions({ head: true }));
    try {
      emitter.play(10);
      tickEmitter(emitter, 0.1);
      tickEmitter(emitter, 0.1);
      // Ids 0 and 1, then the head with the next id, born now.
      expect([0, 1, 2].map((index) => point(emitter, index).tag)).toEqual([1, 2, 3]);
      expect(point(emitter, 2).u).toBe(0);
      expect(segments(emitter)).toBe(2);
      // The head claims no slot and takes no id.
      expect(emitter.particleCount).toBe(2);
      expect(
        (emitter as unknown as { driver: { nextParticleId: number } }).driver.nextParticleId,
      ).toBe(2);
    } finally {
      emitter.destroy();
    }
  });

  it("draws no head without the option, without a play from the pose, or once the play stops", () => {
    const off = cpuEmitter();
    const bursts = cpuEmitter(ribbonOptions({ head: true }));
    const stopped = cpuEmitter(ribbonOptions({ head: true }));
    try {
      off.play(10);
      tickEmitter(off, 0.1);
      bursts.burst(1);
      tickEmitter(bursts, 0.1);
      stopped.play(10);
      tickEmitter(stopped, 0.1);
      expect(point(stopped, 1).tag).toBe(2);
      stopped.stop();
      tickEmitter(stopped, 0.1);
      for (const emitter of [off, bursts, stopped]) {
        expect(point(emitter, 1).tag).toBe(0);
      }
    } finally {
      off.destroy();
      bursts.destroy();
      stopped.destroy();
    }
  });

  it("seeds the head by the behavior's spawn on a simulated tick only", () => {
    const emitter = cpuEmitter(ribbonOptions({ head: true }));
    try {
      emitter.play(10);
      const simulation = (emitter as unknown as { driver: { simulation: { spawn(): void } } })
        .driver.simulation;
      const spawn = vi.spyOn(simulation, "spawn");
      tickEmitter(emitter, 0.1);
      // The play's birth, then the head.
      expect(spawn).toHaveBeenCalledTimes(2);
      tickEmitter(emitter, 0);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(point(emitter, 1).tag).toBe(2);
    } finally {
      emitter.destroy();
    }
  });

  it("rejects a head that is not a boolean", () => {
    expect(() => cpuEmitter(ribbonOptions({ head: "yes" as unknown as boolean }))).toThrow(
      /ribbon\.head: expected a boolean/,
    );
  });

  it("joins across the last id and the first", () => {
    const emitter = cpuEmitter();
    try {
      (emitter as unknown as { driver: { nextParticleId: number } }).driver.nextParticleId =
        FX_PARTICLE_ID_RANGE - 1;
      emitter.burst(1);
      tickEmitter(emitter, 0.1);
      emitter.burst(1);
      tickEmitter(emitter, 0.1);
      expect(point(emitter, 0).tag).toBe(FX_PARTICLE_ID_RANGE);
      expect(point(emitter, 1)).toMatchObject({ tag: 1, tangentX: -1 });
    } finally {
      emitter.destroy();
    }
  });

  it("draws nothing while no particle is alive, and nothing after reset", () => {
    const emitter = cpuEmitter(ribbonOptions(), 4, movingBehavior(0.05));
    try {
      emitter.burst(2);
      tickEmitter(emitter, 0.1);
      expect(segments(emitter)).toBe(2);
      tickEmitter(emitter, 0.1);
      expect(segments(emitter)).toBe(0);
      emitter.burst(2);
      tickEmitter(emitter, 0.01);
      expect(segments(emitter)).toBeGreaterThan(0);
      emitter.reset();
      expect(segments(emitter)).toBe(0);
    } finally {
      emitter.destroy();
    }
  });

  it("shows a burst landed on a paused tick", () => {
    const emitter = cpuEmitter();
    try {
      emitter.burst(2);
      tickEmitter(emitter, 0);
      expect(segments(emitter)).toBe(2);
    } finally {
      emitter.destroy();
    }
  });

  it("does not hold the emitter from settling once its particles are gone", () => {
    const emitter = FXEmitter.fromArtifacts(movingBehavior(0.1), {
      expectedCapacity: 4,
      maxLifetime: 0.1,
      ribbon: ribbonOptions(),
    });
    try {
      emitter.burst(2);
      for (let i = 0; i < 5; i++) {
        tickEmitter(emitter, 0.1);
      }
      expect(emitter.isSettled).toBe(true);
    } finally {
      emitter.destroy();
    }
  });

  it("budgets exactly the attributes a JS-driven ribbon mounts", () => {
    const render = unlitArtifact({ outputs: { albedo: "vec4(PARTICLE_AGE / PARTICLE_LIFETIME)" } });
    const emitter = cpuEmitter(ribbonOptions({ render }));
    try {
      const mounted = Object.keys(ribbonOf(emitter).mesh.geometry.attributes);
      expect(fxStripRenderBudget("ribbon", render, behaviorSlot()).attributes).toBe(mounted.length);
    } finally {
      emitter.destroy();
    }
  });

  it("replaces or removes the ribbon in place, keeping the particles", () => {
    const emitter = cpuEmitter();
    try {
      emitter.burst(2);
      tickEmitter(emitter, 0.1);
      const before = ribbonOf(emitter).mesh;
      emitter.applyStripArtifact("ribbon", ribbonOptions({ uv: { mode: "tile", particles: 4 } }));
      expect(ribbonOf(emitter).mesh).not.toBe(before);
      expect(before.parent).toBeNull();
      expect(emitter.particleCount).toBe(2);
      emitter.applyStripArtifact("ribbon", undefined);
      expect(emitter.hasStrip("ribbon")).toBe(false);
      expect(emitter.particleCount).toBe(2);
    } finally {
      emitter.destroy();
    }
  });

  it("rejects a tile that is not a whole number of particles", () => {
    expect(() => cpuEmitter(ribbonOptions({ uv: { mode: "tile", particles: 0.5 } }))).toThrow(
      /uv\.particles/,
    );
  });

  it("cannot be combined with sorting", () => {
    const camera = new PerspectiveCamera();
    expect(() =>
      FXEmitter.fromArtifacts(movingBehavior(), {
        particles: unlitArtifact(),
        ribbon: ribbonOptions(),
        camera,
        sort: {},
      }),
    ).toThrow(/with a ribbon cannot sort/);
    const sorted = FXEmitter.fromArtifacts(movingBehavior(), {
      particles: unlitArtifact(),
      camera,
      sort: {},
    });
    try {
      expect(() => {
        sorted.applyStripArtifact("ribbon", ribbonOptions());
      }).toThrow(/sorts cannot have a ribbon/);
    } finally {
      sorted.destroy();
    }
  });
});

describe("ribbon - GPU backend", () => {
  it("copies the ring oldest first, from the slot the next birth takes", () => {
    const { renderer, gl } = mockRenderer();
    const emitter = FXEmitter.fromArtifacts(behaviorArtifact(), {
      particles: unlitArtifact(),
      gpuKernel: KERNEL,
      renderer,
      expectedCapacity: 4,
      ribbon: ribbonOptions(),
    });
    try {
      const slotBytes = 6 * 4;
      expect(callsNamed(gl, "bufferData").map((call) => call.args[1])).toContain(6 * slotBytes);
      emitter.burst(1);
      gl.calls.length = 0;
      tickEmitter(emitter, 0.1);
      const copies = callsNamed(gl, "copyBufferSubData").map((call) => call.args.slice(2));
      // [source offset, target offset, bytes]: slots 1-3 (never claimed, dead), then slot 0.
      expect(copies).toEqual([
        [slotBytes, slotBytes, 3 * slotBytes],
        [0, 4 * slotBytes, slotBytes],
      ]);
      expect(segments(emitter)).toBe(4);
      emitter.reset();
      expect(segments(emitter)).toBe(0);
    } finally {
      emitter.destroy();
    }
  });

  it("seeds the head by a pass of its own outside the ring, taking no id", () => {
    const { renderer, gl } = mockRenderer();
    const emitter = FXEmitter.fromArtifacts(behaviorArtifact(), {
      particles: unlitArtifact(),
      gpuKernel: KERNEL,
      renderer,
      expectedCapacity: 4,
      ribbon: ribbonOptions({ head: true }),
    });
    try {
      const slotBytes = 6 * 4;
      emitter.play(10);
      gl.calls.length = 0;
      tickEmitter(emitter, 0.1);
      // The tick's pass over the ring, then the head's over vertex 0 alone.
      expect(callsNamed(gl, "drawArrays").map((call) => call.args.slice(1))).toEqual([
        [0, 4],
        [0, 1],
      ]);
      expect(gl.uniforms.get("u_fxSpawnRangeStart")).toBe(0);
      expect(gl.uniforms.get("u_fxSpawnRangeCount")).toBe(1);
      expect(gl.uniforms.get("u_fxSpawnIdBase")).toBe(1);
      const copies = callsNamed(gl, "copyBufferSubData").map((call) => call.args.slice(2));
      expect(copies.at(-1)).toEqual([0, 5 * slotBytes, slotBytes]);
      tickEmitter(emitter, 0.1);
      // One more birth: the head did not take an id.
      expect(gl.uniforms.get("u_fxSpawnIdBase")).toBe(2);
    } finally {
      emitter.destroy();
    }
  });

  it("sets the head point back to dead once, when the play stops", () => {
    const { renderer, gl } = mockRenderer();
    const emitter = FXEmitter.fromArtifacts(behaviorArtifact(), {
      particles: unlitArtifact(),
      gpuKernel: KERNEL,
      renderer,
      expectedCapacity: 4,
      ribbon: ribbonOptions({ head: true }),
    });
    try {
      const slotBytes = 6 * 4;
      emitter.play(10);
      tickEmitter(emitter, 0.1);
      emitter.stop();
      gl.calls.length = 0;
      tickEmitter(emitter, 0.1);
      expect(callsNamed(gl, "bufferSubData").map((call) => call.args[1])).toEqual([5 * slotBytes]);
      expect(callsNamed(gl, "drawArrays")).toHaveLength(1);
      gl.calls.length = 0;
      tickEmitter(emitter, 0.1);
      expect(callsNamed(gl, "bufferSubData")).toHaveLength(0);
    } finally {
      emitter.destroy();
    }
  });

  it("budgets exactly the attributes a GPU-driven ribbon mounts", () => {
    const { renderer } = mockRenderer();
    const render = unlitArtifact();
    const emitter = FXEmitter.fromArtifacts(behaviorArtifact(), {
      particles: unlitArtifact(),
      gpuKernel: KERNEL,
      renderer,
      expectedCapacity: 4,
      ribbon: ribbonOptions({ render }),
    });
    try {
      const mounted = Object.keys(ribbonOf(emitter).mesh.geometry.attributes);
      // The quad, and the position and lifecycle at the segment's start, end and the point before.
      expect(mounted).toHaveLength(7);
      expect(
        fxStripRenderBudget("ribbon", render, KERNEL.buffers, { backend: "gpu" }).attributes,
      ).toBe(mounted.length);
    } finally {
      emitter.destroy();
    }
  });

  it("links by id and works u out from the id or the age in the shader", () => {
    const { renderer } = mockRenderer();
    const emitter = FXEmitter.fromArtifacts(behaviorArtifact(), {
      gpuKernel: KERNEL,
      renderer,
      ribbon: ribbonOptions({ uv: { mode: "tile", particles: 3 } }),
    });
    try {
      const material = ribbonOf(emitter).mesh.material as ShaderMaterial;
      expect(material.vertexShader).toContain(
        "fxRibbonFollows(a_tA_lifecycle.z, a_tB_lifecycle.z)",
      );
      expect(material.vertexShader).toContain("float fxRibbonU(vec3 lifecycle)");
      expect(material.uniforms["u_ribbonTile"].value).toBe(3);
    } finally {
      emitter.destroy();
    }
  });
});

describe("an emitter that draws no particles", () => {
  it("simulates them on a hidden mesh, and draws its ribbon", () => {
    const emitter = FXEmitter.fromArtifacts(movingBehavior(), {
      expectedCapacity: 4,
      castShadow: true,
      ribbon: ribbonOptions(),
    });
    try {
      expect(emitter.drawsParticles).toBe(false);
      const mesh = particlesOf(emitter);
      expect(mesh.visible).toBe(false);
      expect(mesh.castShadow).toBe(false);
      expect(mesh.customDepthMaterial).toBeUndefined();
      emitter.burst(3);
      tickEmitter(emitter, 0.1);
      expect(emitter.particleCount).toBe(3);
      expect(segments(emitter)).toBe(3);
    } finally {
      emitter.destroy();
    }
  });

  it("starts and stops drawing them in place", () => {
    const emitter = FXEmitter.fromArtifacts(movingBehavior(), { expectedCapacity: 4 });
    try {
      emitter.burst(2);
      tickEmitter(emitter, 0.1);
      emitter.applyRenderArtifact(unlitArtifact(), { castShadow: true });
      expect(emitter.drawsParticles).toBe(true);
      expect(particlesOf(emitter).visible).toBe(true);
      expect(particlesOf(emitter).castShadow).toBe(true);
      expect(emitter.particleCount).toBe(2);
      emitter.applyRenderArtifact(undefined);
      expect(emitter.drawsParticles).toBe(false);
      expect(particlesOf(emitter).visible).toBe(false);
      expect(particlesOf(emitter).castShadow).toBe(false);
      expect(emitter.particleCount).toBe(2);
    } finally {
      emitter.destroy();
    }
  });

  it("cannot sort", () => {
    const camera = new PerspectiveCamera();
    expect(() => FXEmitter.fromArtifacts(movingBehavior(), { camera, sort: {} })).toThrow(
      /draws no particles cannot sort/,
    );
    const sorted = FXEmitter.fromArtifacts(movingBehavior(), {
      particles: unlitArtifact(),
      camera,
      sort: {},
    });
    try {
      expect(() => {
        sorted.applyRenderArtifact(undefined);
      }).toThrow(/sorts draws its particles/);
      expect(sorted.drawsParticles).toBe(true);
    } finally {
      sorted.destroy();
    }
  });
});

describe("ribbon in an effect", () => {
  it("builds a ribbon, and an emitter without a render draws no particles", () => {
    const effect = new TestEffect(
      effectSpec({
        emitters: [
          emitterSpec("Streak", {
            render: undefined,
            ribbon: {
              render: renderForBothTargets(unlitArtifact()),
              uv: { mode: "tile", particles: 2 },
            },
          }),
        ],
      }),
    );
    try {
      const emitter = effect.getEmitter("Streak");
      expect(emitter?.hasStrip("ribbon")).toBe(true);
      expect(emitter?.drawsParticles).toBe(false);
    } finally {
      effect.dispose();
    }
  });

  it("does not sort an emitter that draws no particles, and says why in a development build", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const effect = new TestEffect(
      effectSpec({ emitters: [emitterSpec("Streak", { render: undefined, sortInterval: 1 })] }),
      { camera: new PerspectiveCamera() },
    );
    try {
      expect(effect.getEmitter("Streak")?.sort).toBeUndefined();
      expect(String(warn.mock.calls[0][0])).toMatch(/draws no particles and has a sortInterval/);
    } finally {
      effect.dispose();
      warn.mockRestore();
    }
  });
});

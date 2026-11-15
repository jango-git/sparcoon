import {
  DepthTexture,
  PerspectiveCamera,
  type ShaderMaterial,
  type Texture,
  WebGLRenderTarget,
} from "three";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  FXBufferLayout,
  FXInheritLayout,
  FXParticleKernelArtifact,
} from "../../src/artifact/FXArtifact";
import {
  FX_TRANSFORM_FEEDBACK_BIRTH_AGE_COUNT_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SCENE_DEPTH_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SPAWN_ID_BASE_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_COUNT_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_START_UNIFORM,
} from "../../src/behaviorTransformFeedbackLayout";
import { FXCameraView } from "../../src/emitter/FXCameraView.Internal";
import { FXEmitter } from "../../src/emitter/FXEmitter";
import { fxSetCameraDepth } from "../../src/render/FXCameraDepth";
import { FXWorld } from "../../src/world/FXWorld";
import { behaviorArtifact, unlitArtifact } from "../helpers/artifacts";
import { effectSpec, emitterSpec, TestEffect } from "../helpers/effectSpecs";
import { gpuParticlesOf, isGPUDriven } from "../helpers/internals";
import {
  callsNamed,
  type MockGL,
  type MockGLOptions,
  type MockRenderer,
  mockRenderer,
} from "../helpers/mockWebGL";

// FXEmitter.fromArtifacts's driver-selection rule end to end: a GPU kernel + renderer picks the
// transform-feedback driver; a GPU kernel that fails to set up (a real driver-level failure,
// simulated by the mock context) falls back to the mandatory JS artifact in place, never a hard
// error.

function kernel(
  buffers: readonly FXBufferLayout[] = [
    { name: "position", stride: 3 },
    { name: "lifecycle", stride: 3 },
  ],
  bindings: FXParticleKernelArtifact["bindings"] = {},
): FXParticleKernelArtifact {
  // The program declares each binding at the type its value has.
  const declarations = Object.entries(bindings).map(([name, slot]) => {
    const value = slot.value;
    const type =
      typeof value === "number"
        ? "float"
        : value.length === 16
          ? "mat4"
          : `vec${String(value.length)}`;
    return `uniform ${type} ${name};\n`;
  });
  return {
    vertexSource: `#version 300 es\n${declarations.join("")}void main(){}`,
    fragmentSource: "#version 300 es\nvoid main(){}",
    buffers,
    transformFeedbackVaryings: buffers.map((buffer) => `out_${buffer.name}`),
    bindings,
  };
}

const worlds: FXWorld[] = [];

afterEach(() => {
  for (const world of worlds.splice(0)) {
    world.dispose();
  }
  vi.restoreAllMocks();
});

/** An emitter built with `gpuKernel` on a mock renderer, in a world of its own. */
function newWorld(): FXWorld {
  const world = new FXWorld();
  worlds.push(world);
  return world;
}

function emitterOn(
  mock: MockRenderer,
  options: {
    gpuKernel?: FXParticleKernelArtifact;
    capacity?: number;
    inherit?: FXInheritLayout;
  } = {},
  world: FXWorld = newWorld(),
): { emitter: FXEmitter; world: FXWorld } {
  const emitter = FXEmitter.fromArtifacts(
    behaviorArtifact({
      lifetime: 5,
      ...(options.inherit === undefined ? {} : { inherit: options.inherit }),
    }),
    {
      particles: unlitArtifact(),
      gpuKernel: options.gpuKernel ?? kernel(),
      renderer: mock.renderer,
      expectedCapacity: options.capacity ?? 16,
    },
    world,
  );
  return { emitter, world };
}

/** A GPU-driven emitter in a world of its own, on a mock GL whose pass calls can be inspected. */
function gpuEmitter(capacity: number): { emitter: FXEmitter; world: FXWorld; gl: MockGL } {
  const mock = mockRenderer();
  const { emitter, world } = emitterOn(mock, { capacity });
  expect(isGPUDriven(emitter)).toBe(true);
  return { emitter, world, gl: mock.gl };
}

/** The `[first, count]` of each recorded draw. */
function draws(gl: MockGL): unknown[][] {
  return callsNamed(gl, "drawArrays").map((call) => call.args.slice(1));
}

describe("FXEmitter GPU (transform-feedback) driver selection", () => {
  it("picks the GPU driver when a gpuKernel + renderer are both given and construction succeeds", () => {
    const { emitter } = gpuEmitter(64);
    expect(gpuParticlesOf(emitter).capacity).toBe(64);
    expect(emitter.particleCapacity).toBe(64);
    // Slot occupancy is GPU-resident: overflow is unknowable, not zero.
    expect(emitter.particleOverflowCount).toBeUndefined();
    // No CPU-visible live count for a GPU-driven emitter - capacity is reported instead of an
    // exact tally.
    expect(emitter.particleCount).toBe(64);
  });

  it("builds the JS driver for a gpuKernel given without a renderer", () => {
    const emitter = FXEmitter.fromArtifacts(behaviorArtifact({ lifetime: 5 }), {
      particles: unlitArtifact(),
      gpuKernel: kernel(),
    });
    try {
      expect(isGPUDriven(emitter)).toBe(false);
    } finally {
      emitter.destroy();
    }
  });

  it.each<{ failure: string; options: MockGLOptions; reason: RegExp }>([
    { failure: "link", options: { failLink: true }, reason: /failed to link: mock link failure/ },
    {
      failure: "compile",
      options: { failCompile: true },
      reason: /failed to compile: mock compile failure/,
    },
  ])(
    "falls back to the JS driver in place, leaking no GPU buffer, when the program fails to $failure",
    ({ options, reason }) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const mock = mockRenderer(options);
      const { emitter } = emitterOn(mock, { capacity: 8 });
      expect(isGPUDriven(emitter)).toBe(false);
      // The JS mesh starts empty (nothing spawned yet), unlike a GPU mesh's always-full ring.
      expect(emitter.particleCount).toBe(0);
      expect(mock.gl.liveBuffers.size).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[1])).toMatch(reason);
    },
  );

  it("falls back to the JS driver when the kernel writes more than the GPU's transform feedback captures", () => {
    // Past the limit WebGL fails nothing visible - the program links without its outputs and every
    // pass silently writes nothing - so the holder refuses it up front.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const mock = mockRenderer({ maxFeedbackComponents: 8 });
    const { emitter } = emitterOn(mock, {
      capacity: 8,
      gpuKernel: kernel([
        { name: "position", stride: 3 },
        { name: "lifecycle", stride: 3 },
        { name: "a", stride: 1 },
        { name: "b", stride: 1 },
        { name: "c", stride: 1 },
      ]),
    });
    expect(isGPUDriven(emitter)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[1])).toMatch(/9 components per particle.*at most 8/);
    // Refused before any particle buffer was allocated.
    expect(mock.gl.liveBuffers.size).toBe(0);
  });

  it("builds its buffer set from the GPU kernel artifact alone, and ticks with it", () => {
    // FXGPUEmitterDriver is self-sufficient from its own artifact, never derived from the JS
    // behavior artifact's slot: the JS artifact here declares no attribute at all.
    // A driver keys a non-core buffer as `fx_<name>` while the kernel names it raw ("velocity"),
    // so the first real tick is where a missed translation would throw.
    const mock = mockRenderer();
    const { emitter, world } = emitterOn(mock, {
      gpuKernel: kernel([
        { name: "position", stride: 3 },
        { name: "lifecycle", stride: 3 },
        { name: "velocity", stride: 3 },
      ]),
    });
    expect(isGPUDriven(emitter)).toBe(true);
    // The kernel's slot holds the velocity, but the render reads only the core: two views.
    const mesh = gpuParticlesOf(emitter);
    expect(mesh.slot.fields.map((field) => field.name)).toContain("fx_velocity");
    expect(Object.keys(mesh.geometry.attributes).filter((name) => name.startsWith("a_"))).toEqual([
      "a_pack0",
      "a_pack1",
    ]);
    emitter.burst(1);
    world.update(1 / 60);
    world.update(1 / 60);
    expect(draws(mock.gl)).toEqual([
      [0, 16],
      [0, 16],
    ]);
  });
});

describe("three state reset after GPU passes", () => {
  it("resets each renderer once per world update, however many GPU emitters ticked", () => {
    const mock = mockRenderer();
    const first = emitterOn(mock, {});
    const second = emitterOn(mock, {}, first.world);
    first.emitter.burst(1);
    second.emitter.burst(1);
    first.world.update(1 / 60);
    expect(draws(mock.gl)).toHaveLength(2);
    expect(callsNamed(mock.gl, "resetState")).toHaveLength(1);
  });

  it("resets before the world hands out deaths, and after a throw mid-tick", () => {
    const mock = mockRenderer();
    const { emitter, world } = emitterOn(mock, {});
    const resetsSeen: number[] = [];
    let fail = false;
    world.registerObject({
      onWorldTick: () => {
        if (fail) {
          throw new Error("host failure");
        }
      },
      afterWorldTick: () => resetsSeen.push(callsNamed(mock.gl, "resetState").length),
      destroy: () => undefined,
    });
    emitter.burst(1);
    world.update(1 / 60);
    expect(resetsSeen).toEqual([1]);

    fail = true;
    expect(() => {
      world.update(1 / 60);
    }).toThrow("host failure");
    expect(callsNamed(mock.gl, "resetState")).toHaveLength(2);
  });

  it("prewarm() resets once at its end, outside any world update", () => {
    const { emitter, gl } = gpuEmitter(8);
    emitter.burst(1);
    emitter.prewarm(0.1);
    expect(draws(gl).length).toBeGreaterThan(1);
    expect(callsNamed(gl, "resetState")).toHaveLength(1);
  });
});

describe("FXEmitter GPU spawn passes", () => {
  it("seeds an undelayed burst at the tick's pose in that tick's own pass, not at the call", () => {
    const { emitter, world, gl } = gpuEmitter(32);
    emitter.burst(5);
    expect(draws(gl)).toEqual([]); // due, not seeded at the call

    world.update(1 / 60);
    // One full-ring pass whose birth range carries the burst - no pass of its own, no copy.
    expect(draws(gl)).toEqual([[0, 32]]);
    expect(callsNamed(gl, "copyBufferSubData")).toHaveLength(0);
    expect(gl.uniforms.get(FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_START_UNIFORM)).toBe(0);
    expect(gl.uniforms.get(FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_COUNT_UNIFORM)).toBe(5);

    // Seeded: the next tick's pass is update-only.
    world.update(1 / 60);
    expect(gl.uniforms.get(FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_COUNT_UNIFORM)).toBe(0);
  });

  it("spawns two bursts of one frame from two poses when the emitter moves between them", () => {
    const { emitter, world, gl } = gpuEmitter(32);
    emitter.position.set(1, 0, 0);
    emitter.burst(4);
    emitter.position.set(-1, 0, 0);
    emitter.burst(4);
    world.update(1 / 60);

    // The tick's pass at the tick's pose (-1) carries the second burst; the first, posed
    // elsewhere (+1), gets a pass of its own after it - the translation column of each pass.
    const translations = callsNamed(gl, "uniformMatrix4fv").map(
      (call) => (call.args[2] as readonly number[])[12],
    );
    expect(translations).toEqual([-1, 1]);
    // Consecutive slots, no overlap: the tick's births first, then the others.
    expect(draws(gl)).toEqual([
      [0, 32],
      [4, 4],
    ]);
    expect(gl.uniforms.get(FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_START_UNIFORM)).toBe(4);
  });

  it("hands the tick's pass the defaults to inherit, and a pass at an origin the origin's values", () => {
    const mock = mockRenderer();
    const { emitter, world } = emitterOn(mock, { inherit: { stride: 2, defaults: [5, 6] } });
    // Copied at the call, as WebGL does: the holder reuses one array for every pass.
    const uploads: number[][] = [];
    const context = mock.gl.context as unknown as Record<string, unknown>;
    const upload = context.uniform4fv as (location: unknown, value: Float32Array) => void;
    context.uniform4fv = (location: unknown, value: Float32Array): void => {
      uploads.push([...value]);
      upload(location, value);
    };
    emitter.burst(1);
    emitter.burst(1, { origin: { position: [1, 0, 0], inherited: [1, 2] } });
    world.update(1 / 60);
    expect(uploads).toEqual([
      [5, 6, 0, 0],
      [1, 2, 0, 0],
    ]);
  });

  it("hands the tick's pass the births spread over it as the tail of its spawn range", () => {
    const { emitter, world, gl } = gpuEmitter(32);
    emitter.play(8);
    world.update(0.25); // The play's first emitting tick: born at its end.
    emitter.burst(1);
    gl.calls.length = 0;
    world.update(0.25);

    // The burst, then the play's 2 births, 0.125 s apart.
    expect(gl.uniforms.get(FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_COUNT_UNIFORM)).toBe(3);
    expect(gl.uniforms.get(FX_TRANSFORM_FEEDBACK_BIRTH_AGE_COUNT_UNIFORM)).toBe(2);
    expect(callsNamed(gl, "uniform2f").map((call) => call.args.slice(1))).toEqual([
      [0.125, -0.125],
    ]);
  });

  it("draws a birth of its own pass that wraps past the end of the ring as two segments", () => {
    const { emitter, world, gl } = gpuEmitter(8);
    emitter.burst(6);
    world.update(1 / 60);
    gl.calls.length = 0;
    emitter.burst(5, { origin: { position: [0, 2, 0] } }); // slots 6, 7, then 0, 1, 2.
    world.update(1 / 60);

    expect(draws(gl)).toEqual([
      [0, 8],
      [6, 2],
      [0, 3],
    ]);
    const slotBytes = 6 * 4;
    expect(callsNamed(gl, "copyBufferSubData").map((call) => call.args.slice(2))).toEqual([
      [6 * slotBytes, 6 * slotBytes, 2 * slotBytes],
      [0, 0, 3 * slotBytes],
    ]);
  });

  it("caps a birth of its own pass larger than the ring at one full ring", () => {
    const { emitter, world, gl } = gpuEmitter(8);
    emitter.burst(20, { origin: { position: [0, 0, 0] } });
    world.update(1 / 60);
    const drawn = draws(gl)
      .slice(1) // after the tick's own full-ring pass
      .reduce((total, draw) => total + (draw[1] as number), 0);
    expect(drawn).toBe(8);
    expect(gl.uniforms.get(FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_COUNT_UNIFORM)).toBe(8);
  });

  it("spends one particle id per birth asked for, like the JS backend, in a pass of its own or not", () => {
    const { emitter, world, gl } = gpuEmitter(4);
    const origin = { position: [0, 1, 0] };
    emitter.burst(3); // the tick's pass: ids 0..2
    world.update(1 / 60);
    expect(gl.uniforms.get(FX_TRANSFORM_FEEDBACK_SPAWN_ID_BASE_UNIFORM)).toBe(0);
    // Passes of their own: larger than the ring (seeds 4 slots, spends ids 3..8), then one more.
    emitter.burst(6, { origin });
    emitter.burst(1, { origin });
    world.update(1 / 60);
    expect(gl.uniforms.get(FX_TRANSFORM_FEEDBACK_SPAWN_ID_BASE_UNIFORM)).toBe(9);
    emitter.burst(6, { delay: 0.001 }); // inside the next tick's pass
    world.update(1 / 60);
    expect(gl.uniforms.get(FX_TRANSFORM_FEEDBACK_SPAWN_ID_BASE_UNIFORM)).toBe(10);
    emitter.burst(1);
    world.update(1 / 60);
    expect(gl.uniforms.get(FX_TRANSFORM_FEEDBACK_SPAWN_ID_BASE_UNIFORM)).toBe(16);
  });

  it("gathers spawns inside a tick (delayed bursts, plays) into that tick's own pass", () => {
    const { emitter, world, gl } = gpuEmitter(32);
    emitter.burst(3, { delay: 0.01 });
    emitter.play(120);
    world.update(1 / 60); // the delayed burst expires (3) and the play emits 2.

    // No spawn pass of their own: one full-ring pass whose birth range carries all of them.
    expect(draws(gl)).toEqual([[0, 32]]);
    expect(gl.uniforms.get(FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_START_UNIFORM)).toBe(0);
    expect(gl.uniforms.get(FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_COUNT_UNIFORM)).toBe(5);

    // The next tick's range starts right after them.
    world.update(1 / 60);
    expect(gl.uniforms.get(FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_START_UNIFORM)).toBe(5);
  });

  it("reset() kills every live particle at once: both halves zeroed, nothing drawn", () => {
    const { emitter, world, gl } = gpuEmitter(32);
    const drawn = (): number =>
      (gpuParticlesOf(emitter).geometry as unknown as { instanceCount: number }).instanceCount;
    emitter.burst(5);
    world.update(1 / 60);
    expect(drawn()).toBe(32);

    gl.calls.length = 0;
    emitter.reset();
    expect(callsNamed(gl, "bufferData")).toHaveLength(2);
    expect(drawn()).toBe(0);
  });

  it("skips its ticks while reset and not spawned since, and resumes with the next birth", () => {
    const { emitter, world, gl } = gpuEmitter(32);
    world.update(1 / 60);
    expect(draws(gl)).toEqual([]);

    emitter.burst(1, { delay: 0.02 });
    world.update(1 / 60); // the delay counts down
    world.update(1 / 60); // the burst lands
    world.update(1 / 60);
    expect(draws(gl)).toHaveLength(3);

    emitter.reset();
    gl.calls.length = 0;
    world.update(1 / 60);
    expect(draws(gl)).toEqual([]);
  });

  it("reset() rewinds the spawn cursor, so the next burst starts at slot 0 again", () => {
    const { emitter, world, gl } = gpuEmitter(32);
    emitter.burst(5);
    world.update(1 / 60);
    emitter.burst(3); // due, dropped by the reset
    emitter.reset();
    emitter.burst(2);
    world.update(1 / 60);
    expect(gl.uniforms.get(FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_START_UNIFORM)).toBe(0);
    expect(gl.uniforms.get(FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_COUNT_UNIFORM)).toBe(2);
  });
});

describe("FXEmitter GPU driver", () => {
  it("uploads each kernel binding every pass, and applyValues retargets it for the next", () => {
    const mock = mockRenderer();
    const gravity = kernel(undefined, { b_gravity$0: { value: -2 } });
    const { emitter, world } = emitterOn(mock, { gpuKernel: gravity });
    emitter.burst(1);
    world.update(1 / 60);
    expect(mock.gl.uniforms.get("b_gravity$0")).toBe(-2);

    emitter.applyValues({ bindings: { b_gravity$0: 5, b_unknown$1: 1 } });
    world.update(1 / 60);
    expect(mock.gl.uniforms.get("b_gravity$0")).toBe(5);
    expect(gravity.bindings["b_gravity$0"].value).toBe(-2); // the artifact keeps its initial value
    expect(mock.gl.uniforms.has("b_unknown$1")).toBe(false);
  });

  it("computes its draw uniforms each pass from the pass's timestep, pose and its own bindings", () => {
    const mock = mockRenderer();
    const drawn: FXParticleKernelArtifact = {
      ...kernel(undefined, {
        b_param_k: { value: 2 },
        u_updateDraw_0: { value: 0 },
        u_spawnDraw_1: { value: 0 },
      }),
      compute: (inputs, uniforms) => {
        uniforms["u_updateDraw_0"]!.value =
          inputs.deltaTime * (uniforms["b_param_k"]!.value as number);
        uniforms["u_spawnDraw_1"]!.value = inputs.worldMatrix[12]!;
      },
    };
    const { emitter, world } = emitterOn(mock, { gpuKernel: drawn });
    emitter.position.set(3, 0, 0);
    emitter.burst(1);
    world.update(0.5);
    expect(mock.gl.uniforms.get("u_updateDraw_0")).toBeCloseTo(1, 6);
    expect(mock.gl.uniforms.get("u_spawnDraw_1")).toBe(3);
    emitter.applyValues({ bindings: { b_param_k: 4 } });
    world.update(0.25);
    expect(mock.gl.uniforms.get("u_updateDraw_0")).toBeCloseTo(1, 6);
    expect(drawn.bindings["b_param_k"]?.value).toBe(2); // the artifact's own, never written
  });

  it("uploads a vector draw uniform by the type its program declares it as", () => {
    const mock = mockRenderer();
    const drawn: FXParticleKernelArtifact = {
      ...kernel(undefined, { _0: { value: [0, 0, 0] } }),
      compute: (inputs, uniforms) => {
        const value = uniforms["_0"]!.value as number[];
        value[0] = 7;
        value[1] = inputs.deltaTime;
      },
    };
    const { emitter, world } = emitterOn(mock, { gpuKernel: drawn });
    emitter.burst(1);
    world.update(0.5);
    const uploaded = callsNamed(mock.gl, "uniform3fv").map((call) => call.args[1]);
    expect(uploaded).toContainEqual([7, 0.5, 0]);
  });

  it("refuses to report births and deaths: its particles' state never leaves the GPU", () => {
    const { emitter } = gpuEmitter(8);
    expect(emitter.reportsParticleEvents).toBe(false);
    expect(() => emitter.onParticleEvent("death", () => undefined)).toThrow(/GPU-driven/);
    expect(() => emitter.onParticleEvent("birth", () => undefined)).toThrow(/GPU-driven/);
  });

  it("builds a reaction source on the CPU in an effect, whatever its GPU kernel", () => {
    const world = new FXWorld();
    worlds.push(world);
    const withKernel = { behavior: behaviorArtifact({ lifetime: 1 }), gpuBehavior: kernel() };
    const effect = new TestEffect(
      effectSpec({
        duration: 1,
        emitters: [
          emitterSpec("shell", withKernel),
          emitterSpec("sparks", {
            ...withKernel,
            reactions: [{ source: 0, kind: "burst", count: 2 }],
          }),
        ],
      }),
      { world, renderer: mockRenderer().renderer },
    );
    expect(isGPUDriven(effect.getEmitter("shell")!)).toBe(false);
    expect(isGPUDriven(effect.getEmitter("sparks")!)).toBe(true);
  });

  it("builds a birth-reaction source on the CPU too", () => {
    const world = new FXWorld();
    worlds.push(world);
    const withKernel = { behavior: behaviorArtifact({ lifetime: 1 }), gpuBehavior: kernel() };
    const effect = new TestEffect(
      effectSpec({
        duration: 1,
        emitters: [
          emitterSpec("shell", withKernel),
          emitterSpec("sparks", {
            ...withKernel,
            reactions: [{ source: 0, on: "birth", kind: "burst", count: 2 }],
          }),
        ],
      }),
      { world, renderer: mockRenderer().renderer },
    );
    expect(isGPUDriven(effect.getEmitter("shell")!)).toBe(false);
    expect(isGPUDriven(effect.getEmitter("sparks")!)).toBe(true);
  });

  it("applyRenderArtifact swaps the material in place without touching the GPU kernel or buffers", () => {
    // The driver re-derives its layout from the kernel's own buffers (never a JS behavior
    // artifact's), so a render reading an attribute the kernel does not write
    // applies too, adding no attribute; the simulation is left in place.
    const mock = mockRenderer();
    const { emitter, world } = emitterOn(mock);
    expect(isGPUDriven(emitter)).toBe(true);
    emitter.burst(4);
    const mesh = gpuParticlesOf(emitter);
    const materialBefore = mesh.material;
    const attributesBefore = Object.keys(mesh.geometry.attributes).sort();

    emitter.applyRenderArtifact(
      unlitArtifact({ attributeReads: [{ name: "glow", components: 1 }] }),
    );

    expect(mesh.material).not.toBe(materialBefore);
    expect(Object.keys(mesh.geometry.attributes).sort()).toEqual(attributesBefore);
    // Still the same mesh instance, same fixed capacity - nothing about the driver was rebuilt.
    expect(gpuParticlesOf(emitter)).toBe(mesh);
    expect(emitter.particleCapacity).toBe(16);
    world.update(1 / 60);
    expect(mock.gl.uniforms.get(FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_COUNT_UNIFORM)).toBe(4);
  });
});

describe("FXEmitter GPU driver depth sort", () => {
  function sortedEmitter(
    options: MockGLOptions = {},
    capacity = 8,
  ): { emitter: FXEmitter; world: FXWorld; mock: MockRenderer } {
    const mock = mockRenderer(options);
    const world = newWorld();
    const emitter = FXEmitter.fromArtifacts(
      behaviorArtifact({ lifetime: 5 }),
      {
        particles: unlitArtifact(),
        gpuKernel: kernel(),
        renderer: mock.renderer,
        expectedCapacity: capacity,
        camera: new PerspectiveCamera(),
        sort: { fraction: 0.5 },
      },
      world,
    );
    return { emitter, world, mock };
  }

  function vertexShaderOf(emitter: FXEmitter): string {
    return (gpuParticlesOf(emitter).material as ShaderMaterial).vertexShader;
  }

  it("reads attributes and allocates nothing for sorting when built without sort", () => {
    const { emitter, gl } = gpuEmitter(8);
    expect(vertexShaderOf(emitter)).toMatch(/^attribute vec3 a_pack0;$/m);
    expect(vertexShaderOf(emitter)).not.toMatch(/fxParticleSlots/);
    expect(gl.liveTextures.size).toBe(0);
    expect(gl.liveFramebuffers.size).toBe(0);
  });

  it("draws its slots from textures, in the order the textures hold, binding no attribute of them", () => {
    const { emitter, mock } = sortedEmitter();
    expect(isGPUDriven(emitter)).toBe(true);
    const shader = vertexShaderOf(emitter);
    expect(shader).toMatch(/uniform highp usampler2D fxParticleOrder;/);
    expect(shader).not.toMatch(/^attribute vec3 a_pack0;$/m);
    expect(shader).toMatch(/int fxSlotStart = 6 \* int\(texelFetch\(fxParticleOrder/);
    expect(Object.keys(gpuParticlesOf(emitter).geometry.attributes)).not.toContain("a_pack0");
    // The order is a permutation from the start: the slots in turn.
    const upload = callsNamed(mock.gl, "texSubImage2D").find(
      (call) => call.args[6] === mock.gl.context.RED_INTEGER,
    );
    expect(Array.from(upload?.args[8] as Uint32Array)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    const uniforms = (gpuParticlesOf(emitter).material as ShaderMaterial).uniforms;
    const slots = uniforms["fxParticleSlots"].value as Texture;
    const created = mock.renderer.properties.get(slots) as Record<string, unknown>;
    expect(mock.gl.liveTextures.has(created["__webglTexture"])).toBe(true);
  });

  it("copies the slots after every tick that wrote them and ranks on the frames its fraction picks", () => {
    const { emitter, world, mock } = sortedEmitter();
    const gl = mock.gl;
    const slotsCopies = (): number =>
      callsNamed(gl, "texSubImage2D").filter((call) => call.args[6] === gl.context.RED).length;
    // Every pass draws points: the transform-feedback ones, and the ranks.
    const ranks = (): number =>
      callsNamed(gl, "drawArrays").length - callsNamed(gl, "beginTransformFeedback").length;

    emitter.burst(1);
    world.update(1 / 60);
    expect(slotsCopies()).toBe(1);
    expect(ranks()).toBe(0);
    const unpackBound = callsNamed(gl, "bindBuffer").filter(
      (call) => call.args[0] === gl.context.PIXEL_UNPACK_BUFFER,
    );
    expect(unpackBound.map((call) => call.args[1])).toEqual([
      gpuParticlesOf(emitter).readBuffer(),
      null,
    ]);

    world.update(1 / 60);
    expect(slotsCopies()).toBe(2);
    expect(ranks()).toBe(1);
    expect(gl.uniforms.get("u_capacity")).toBe(8);

    // Paused: no pass wrote the slots, so nothing is copied.
    world.update(0);
    expect(slotsCopies()).toBe(2);
  });

  it("splits a copy into whole rows and the last partial one", () => {
    // 6 floats a slot, 3 slots: 18 floats in rows of 8.
    const { emitter, world, mock } = sortedEmitter({ maxTextureSize: 8 }, 3);
    expect(isGPUDriven(emitter)).toBe(true);
    emitter.burst(1);
    world.update(1 / 60);
    const copies = callsNamed(mock.gl, "texSubImage2D")
      .filter((call) => call.args[6] === mock.gl.context.RED)
      .map((call) => [call.args[3], call.args[4], call.args[5], call.args[8]]);
    expect(copies).toEqual([
      [0, 8, 2, 0],
      [2, 2, 1, 16 * 4],
    ]);
  });

  it("falls back to the JS driver, leaking no texture, when the order cannot be drawn into", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { emitter, mock } = sortedEmitter({ incompleteFramebuffer: true });
    expect(isGPUDriven(emitter)).toBe(false);
    expect(mock.gl.liveTextures.size).toBe(0);
    expect(mock.gl.liveFramebuffers.size).toBe(0);
    expect(mock.gl.liveBuffers.size).toBe(0);
  });
});

describe("FXEmitter GPU driver scene depth", () => {
  function depthKernel(): FXParticleKernelArtifact {
    const base = kernel();
    return {
      ...base,
      vertexSource: `#version 300 es\nuniform highp sampler2D ${FX_TRANSFORM_FEEDBACK_SCENE_DEPTH_UNIFORM};\nvoid main(){}`,
      sceneDepth: true,
    };
  }

  it("reads the depth with the camera as it stood after the tick before", () => {
    const mock = mockRenderer();
    const world = newWorld();
    const camera = new PerspectiveCamera();
    const target = new WebGLRenderTarget(8, 8, { depthTexture: new DepthTexture(8, 8) });
    mock.renderer.properties.get(target.depthTexture)["__webglTexture"] = {};
    fxSetCameraDepth(camera, target.depthTexture);
    const emitter = FXEmitter.fromArtifacts(
      behaviorArtifact({ lifetime: 5 }),
      { gpuKernel: depthKernel(), renderer: mock.renderer, camera },
      world,
    );
    expect(isGPUDriven(emitter)).toBe(true);
    const viewAt = (x: number): FXCameraView => {
      camera.position.set(x, 0, 0);
      const view = new FXCameraView();
      view.capture(camera);
      return view;
    };
    const first = viewAt(1);
    const second = viewAt(2);
    const passMatrices = (): unknown[] => {
      mock.gl.calls.length = 0;
      world.update(1 / 60);
      return callsNamed(mock.gl, "uniformMatrix4fv").map((call) => call.args[2]);
    };
    emitter.play(10);
    camera.position.set(1, 0, 0);
    passMatrices();
    camera.position.set(2, 0, 0);
    const matrices = passMatrices();
    expect(matrices).toContainEqual(first.viewProjection.elements);
    expect(matrices).not.toContainEqual(second.viewProjection.elements);
  });

  it("needs a camera for a GPU kernel reading the scene depth, not for its JS twin", () => {
    const mock = mockRenderer();
    const world = newWorld();
    expect(() =>
      FXEmitter.fromArtifacts(
        behaviorArtifact({ lifetime: 5 }),
        { gpuKernel: depthKernel(), renderer: mock.renderer },
        world,
      ),
    ).toThrow(/an emitter that reads the scene depth needs a camera/);
    const cpu = FXEmitter.fromArtifacts(
      behaviorArtifact({ lifetime: 5 }),
      { gpuKernel: depthKernel() },
      world,
    );
    expect(isGPUDriven(cpu)).toBe(false);
    cpu.destroy();
  });
});

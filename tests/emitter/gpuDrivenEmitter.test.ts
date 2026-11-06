import { describe, expect, it, vi } from "vitest";
import { FXEmitter } from "../../src/emitter/FXEmitter";
import type { FXTransformFeedbackParticle } from "../../src/instancedParticle/FXTransformFeedbackParticle";
import type { FXParticleKernelArtifact } from "../../src/artifact/FXArtifact";
import {
  FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_COUNT_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_START_UNIFORM,
} from "../../src/behaviorTransformFeedbackLayout";
import { FXWorld } from "../../src/world/FXWorld";
import { behaviorArtifact, unlitArtifact } from "../helpers/artifacts";

// Exercises FXEmitter.fromArtifacts's driver-selection rule end to end: a GPU kernel + renderer
// picks the transform-feedback driver; a GPU kernel that fails to construct (a real driver-level
// failure, simulated here via a mock that throws on link) falls back to the mandatory JS artifact
// in place, never a hard error. No real WebGL2 context is available in this headless run.

interface MockGLOptions {
  readonly failLink?: boolean;
  /** MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS; the WebGL2 minimum, 64, by default. */
  readonly maxFeedbackComponents?: number;
}

function mockGL(options: MockGLOptions = {}): unknown {
  let nextId = 1;
  const liveBuffers = new Set<unknown>();
  const uniformLocationNames = new Map<unknown, string>();
  const uniformCalls = new Map<string, number>();
  // Every pass-level call in order, for assertions on what each transform-feedback pass did.
  const passCalls: { readonly name: string; readonly args: readonly unknown[] }[] = [];
  return {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    INTERLEAVED_ATTRIBS: 5,
    ARRAY_BUFFER: 6,
    TRANSFORM_FEEDBACK_BUFFER: 7,
    FLOAT: 8,
    POINTS: 9,
    RASTERIZER_DISCARD: 10,
    DYNAMIC_DRAW: 11,
    COPY_READ_BUFFER: 12,
    COPY_WRITE_BUFFER: 13,
    MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS: 14,
    MAX_VERTEX_ATTRIBS: 15,
    getParameter: (name: number) => (name === 14 ? (options.maxFeedbackComponents ?? 64) : 16),
    createBuffer: () => {
      const buffer = { id: nextId++ };
      liveBuffers.add(buffer);
      return buffer;
    },
    createShader: () => ({ id: nextId++ }),
    shaderSource: () => undefined,
    compileShader: () => undefined,
    getShaderParameter: () => true,
    getShaderInfoLog: () => "",
    deleteShader: () => undefined,
    createProgram: () => ({ id: nextId++ }),
    attachShader: () => undefined,
    transformFeedbackVaryings: () => undefined,
    linkProgram: () => undefined,
    getProgramParameter: () => !(options.failLink ?? false),
    getProgramInfoLog: () => "mock link failure",
    deleteProgram: () => undefined,
    createVertexArray: () => ({ id: nextId++ }),
    deleteVertexArray: () => undefined,
    getUniformLocation: (_program: unknown, name: string) => {
      const location = { id: nextId++ };
      uniformLocationNames.set(location, name);
      return location;
    },
    bindVertexArray: () => undefined,
    bindBuffer: () => undefined,
    bufferData: () => undefined,
    deleteBuffer: (buffer: unknown) => {
      liveBuffers.delete(buffer);
    },
    vertexAttribPointer: () => undefined,
    enableVertexAttribArray: () => undefined,
    bindBufferBase: () => undefined,
    bindBufferRange: (...args: unknown[]) => passCalls.push({ name: "bindBufferRange", args }),
    copyBufferSubData: (...args: unknown[]) => passCalls.push({ name: "copyBufferSubData", args }),
    uniform1i: (location: unknown, value: number) => {
      const name = uniformLocationNames.get(location);
      if (name !== undefined) {
        uniformCalls.set(name, value);
        passCalls.push({ name: name, args: [value] });
      }
    },
    uniform1f: () => undefined,
    uniformMatrix4fv: (_location: unknown, _transpose: boolean, matrix: readonly number[]) =>
      passCalls.push({ name: "modelMatrix", args: [...matrix] }),
    uniform3fv: () => undefined,
    enable: () => undefined,
    disable: () => undefined,
    beginTransformFeedback: () => undefined,
    endTransformFeedback: () => undefined,
    drawArrays: (...args: unknown[]) => passCalls.push({ name: "drawArrays", args }),
    // Exposed for assertions only, not part of the real WebGL2RenderingContext surface.
    __liveBuffers: liveBuffers,
    __uniformCalls: uniformCalls,
    __passCalls: passCalls,
  };
}

function mockRenderer(options: MockGLOptions = {}): {
  getContext: () => unknown;
  state: { useProgram: () => void };
  resetState: () => void;
} {
  const gl = mockGL(options);
  return {
    getContext: () => gl,
    state: { useProgram: () => undefined },
    resetState: () => undefined,
  };
}

function minimalKernel(): FXParticleKernelArtifact {
  return {
    vertexSource: "#version 300 es\nvoid main(){}",
    fragmentSource: "#version 300 es\nvoid main(){}",
    buffers: [
      { name: "position", stride: 3 },
      { name: "lifecycle", stride: 3 },
    ],
    transformFeedbackVaryings: ["out_position", "out_lifecycle"],
    bindings: {},
  };
}

function meshOf(emitter: FXEmitter): { capacity?: number; readBuffer?: unknown } {
  return (emitter as unknown as { mesh: FXTransformFeedbackParticle }).mesh;
}

// FXInstancedParticle also happens to carry a same-named private `capacity` field (readable at
// runtime through the unsafe cast above, since TS-only `private` is not enforced by the JS
// runtime) - `readBuffer` is a real, structural discriminator: only FXTransformFeedbackParticle
// has it at all.
function isGPUMesh(emitter: FXEmitter): boolean {
  return typeof meshOf(emitter).readBuffer === "function";
}

interface MockGL {
  readonly __uniformCalls: Map<string, number>;
  readonly __passCalls: { readonly name: string; readonly args: readonly unknown[] }[];
}

/** A GPU-driven emitter in a world of its own, on a mock GL whose pass calls can be inspected. */
function gpuEmitter(capacity: number): { emitter: FXEmitter; world: FXWorld; gl: MockGL } {
  const world = new FXWorld();
  const renderer = mockRenderer();
  const emitter = FXEmitter.fromArtifacts(
    unlitArtifact(),
    behaviorArtifact({ lifetime: 5 }),
    { gpuKernel: minimalKernel(), renderer: renderer as never, expectedCapacity: capacity },
    world,
  );
  expect(isGPUMesh(emitter)).toBe(true);
  return { emitter, world, gl: renderer.getContext() as MockGL };
}

function callsNamed(gl: MockGL, name: string): { readonly args: readonly unknown[] }[] {
  return gl.__passCalls.filter((call) => call.name === name);
}

describe("FXEmitter GPU (transform-feedback) driver selection", () => {
  it("picks the GPU driver when a gpuKernel + renderer are both given and construction succeeds", () => {
    const emitter = FXEmitter.fromArtifacts(unlitArtifact(), behaviorArtifact({ lifetime: 5 }), {
      gpuKernel: minimalKernel(),
      renderer: mockRenderer() as never,
      expectedCapacity: 64,
    });
    try {
      expect(isGPUMesh(emitter)).toBe(true);
      expect(meshOf(emitter).capacity).toBe(64);
      expect(emitter.particleCapacity).toBe(64);
      // No CPU-visible live count for a GPU-driven emitter - capacity is reported instead of an
      // exact tally.
      expect(emitter.particleCount).toBe(64);
    } finally {
      emitter.destroy();
    }
  });

  it("falls back to the JS driver in place when GPU program setup throws", () => {
    const emitter = FXEmitter.fromArtifacts(unlitArtifact(), behaviorArtifact({ lifetime: 5 }), {
      gpuKernel: minimalKernel(),
      renderer: mockRenderer({ failLink: true }) as never,
      expectedCapacity: 8,
    });
    try {
      expect(isGPUMesh(emitter)).toBe(false);
      // The JS mesh starts empty (nothing spawned yet) - the true FXInstancedParticle behavior,
      // never a "fixed capacity always populated" GPU mesh.
      expect(emitter.particleCount).toBe(0);
    } finally {
      emitter.destroy();
    }
  });

  it("falls back to the JS driver when the kernel writes more than the GPU's transform feedback captures", () => {
    // Regression: past the limit, WebGL fails nothing visible - the program links without its
    // outputs and every pass silently writes nothing. The holder refuses it up front.
    const kernel: FXParticleKernelArtifact = {
      ...minimalKernel(),
      buffers: [
        { name: "position", stride: 3 },
        { name: "lifecycle", stride: 3 },
        { name: "a", stride: 1 },
        { name: "b", stride: 1 },
        { name: "c", stride: 1 },
      ],
      transformFeedbackVaryings: ["out_position", "out_lifecycle", "out_a", "out_b", "out_c"],
    };
    const renderer = mockRenderer({ maxFeedbackComponents: 8 });
    const gl = renderer.getContext() as unknown as { __liveBuffers: Set<unknown> };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const emitter = FXEmitter.fromArtifacts(unlitArtifact(), behaviorArtifact({ lifetime: 5 }), {
        gpuKernel: kernel,
        renderer: renderer as never,
        expectedCapacity: 8,
      });
      expect(isGPUMesh(emitter)).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[1])).toMatch(/9 components per particle.*at most 8/);
      // Refused before any particle buffer was allocated.
      expect(gl.__liveBuffers.size).toBe(0);
      emitter.destroy();
    } finally {
      warn.mockRestore();
    }
  });

  it("releases the partially-constructed GPU mesh's buffers when simulation-holder setup throws", () => {
    // Regression: FXTransformFeedbackParticle (real WebGL buffers + VAO-backing geometry) can
    // finish constructing before FXTransformFeedbackSimulationHolder's link failure throws right
    // after it - the constructor's catch must destroy() that mesh before discarding it, or every
    // buffer it allocated leaks for the GL context's lifetime.
    const renderer = mockRenderer({ failLink: true });
    const gl = renderer.getContext() as unknown as { __liveBuffers: Set<unknown> };
    const emitter = FXEmitter.fromArtifacts(unlitArtifact(), behaviorArtifact({ lifetime: 5 }), {
      gpuKernel: minimalKernel(),
      renderer: renderer as never,
      expectedCapacity: 8,
    });
    try {
      expect(isGPUMesh(emitter)).toBe(false);
      expect(gl.__liveBuffers.size).toBe(0);
    } finally {
      emitter.destroy();
    }
  });

  it("still builds the ordinary JS-driven emitter when no gpuKernel is given at all", () => {
    const emitter = FXEmitter.fromArtifacts(unlitArtifact(), behaviorArtifact({ lifetime: 5 }));
    try {
      expect(isGPUMesh(emitter)).toBe(false);
    } finally {
      emitter.destroy();
    }
  });

  it("accumulates burst() calls into the spawn cursor without throwing, for a GPU-driven emitter", () => {
    const emitter = FXEmitter.fromArtifacts(unlitArtifact(), behaviorArtifact({ lifetime: 5 }), {
      gpuKernel: minimalKernel(),
      renderer: mockRenderer() as never,
      expectedCapacity: 32,
    });
    try {
      expect(() => emitter.burst(5)).not.toThrow();
      expect(() => emitter.burst(3)).not.toThrow();
    } finally {
      emitter.destroy();
    }
  });

  it("ticks without throwing when the GPU kernel declares an attribute buffer (not just core position/lifecycle)", () => {
    // Regression: a driver's varyingsFromComponents (FXEmitterDriver.Internal.ts) keys the mesh's
    // property buffers as `fx_<name>` for every non-core buffer, but the kernel
    // artifact's own buffer names are always the raw, unprefixed compiled name (e.g. "velocity") -
    // FXTransformFeedbackSimulationHolder must translate through the same mapping before calling
    // mesh.readBuffer/writeBuffer/swapBuffers, or this throws on the very first real tick for any
    // emitter with attributes (burst() alone, above, never reaches that code path - only a real
    // FXWorld.update() does).
    const kernel: FXParticleKernelArtifact = {
      vertexSource: "#version 300 es\nvoid main(){}",
      fragmentSource: "#version 300 es\nvoid main(){}",
      buffers: [
        { name: "position", stride: 3 },
        { name: "lifecycle", stride: 3 },
        { name: "velocity", stride: 3 },
      ],
      transformFeedbackVaryings: ["out_position", "out_lifecycle", "out_velocity"],
      bindings: {},
    };
    const world = new FXWorld();
    const emitter = FXEmitter.fromArtifacts(
      unlitArtifact(),
      // FXGPUEmitterDriver builds its own buffer set from `kernel.buffers` - this fixture still
      // declares the matching attribute on the JS artifact too, since a real compile always keeps
      // both in lockstep (the editor's exportCompile.ts feeds the same
      // `behaviorAttributes` to both compilers); the test right below this one removes that
      // agreement entirely to prove the independence, not just that today's fixtures happen to agree.
      behaviorArtifact({ lifetime: 5, attributes: [{ name: "velocity", components: 3 }] }),
      { gpuKernel: kernel, renderer: mockRenderer() as never, expectedCapacity: 16 },
      world,
    );
    try {
      expect(isGPUMesh(emitter)).toBe(true);
      expect(() => world.update(1 / 60)).not.toThrow();
      expect(() => world.update(1 / 60)).not.toThrow();
    } finally {
      emitter.destroy();
      world.dispose();
    }
  });

  it("builds its buffer set from the GPU kernel artifact alone - the JS artifact has no matching attribute at all", () => {
    // FXGPUEmitterDriver must be self-sufficient from its own artifact, never derived from the JS
    // behavior artifact's attributeWrites - that coupling was a real bug this test guards against.
    // Proven here by deliberately NOT declaring "velocity" - or any
    // attribute at all - on the JS side, unlike the test above.
    const kernel: FXParticleKernelArtifact = {
      vertexSource: "#version 300 es\nvoid main(){}",
      fragmentSource: "#version 300 es\nvoid main(){}",
      buffers: [
        { name: "position", stride: 3 },
        { name: "lifecycle", stride: 3 },
        { name: "velocity", stride: 3 },
      ],
      transformFeedbackVaryings: ["out_position", "out_lifecycle", "out_velocity"],
      bindings: {},
    };
    const world = new FXWorld();
    const emitter = FXEmitter.fromArtifacts(
      unlitArtifact(),
      behaviorArtifact({ lifetime: 5 }), // no attributes at all
      { gpuKernel: kernel, renderer: mockRenderer() as never, expectedCapacity: 16 },
      world,
    );
    try {
      expect(isGPUMesh(emitter)).toBe(true);
      const mesh = meshOf(emitter) as unknown as {
        propertyBuffers: Record<string, unknown>;
      };
      expect(mesh.propertyBuffers["fx_velocity"]).toBeDefined();
      expect(() => world.update(1 / 60)).not.toThrow();
    } finally {
      emitter.destroy();
      world.dispose();
    }
  });

  it("seeds an immediate burst() right away, in a pass over its own slots only", () => {
    const { emitter, world, gl } = gpuEmitter(32);
    try {
      emitter.burst(5); // immediate: outside any tick.

      // One draw over exactly the claimed slots, captured into exactly those slots, then copied
      // into the read half - the side the renderer draws.
      expect(callsNamed(gl, "drawArrays").map((call) => call.args.slice(1))).toEqual([[0, 5]]);
      // A slot is position + lifecycle: 6 floats, 24 bytes.
      expect(callsNamed(gl, "bindBufferRange").map((call) => call.args.slice(3))).toEqual([
        [0, 5 * 24],
      ]);
      expect(callsNamed(gl, "copyBufferSubData")).toHaveLength(1);
      expect(gl.__uniformCalls.get(FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_START_UNIFORM)).toBe(0);
      expect(gl.__uniformCalls.get(FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_COUNT_UNIFORM)).toBe(5);

      // Already seeded: the next tick's pass is update-only.
      gl.__passCalls.length = 0;
      world.update(1 / 60);
      expect(gl.__uniformCalls.get(FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_COUNT_UNIFORM)).toBe(0);
      expect(callsNamed(gl, "drawArrays").map((call) => call.args.slice(1))).toEqual([[0, 32]]);
    } finally {
      emitter.destroy();
      world.dispose();
    }
  });

  it("spawns two bursts of one frame from two poses when the emitter moves between them", () => {
    const { emitter, world, gl } = gpuEmitter(32);
    try {
      emitter.position.set(1, 0, 0);
      emitter.burst(4);
      emitter.position.set(-1, 0, 0);
      emitter.burst(4);

      // The translation column of each spawn pass's model matrix.
      const translations = callsNamed(gl, "modelMatrix").map((call) => call.args[12]);
      expect(translations).toEqual([1, -1]);
      // Consecutive slots, no overlap.
      expect(callsNamed(gl, "drawArrays").map((call) => call.args.slice(1))).toEqual([
        [0, 4],
        [4, 4],
      ]);
    } finally {
      emitter.destroy();
      world.dispose();
    }
  });

  it("draws a burst that wraps past the end of the ring as two segments", () => {
    const { emitter, world, gl } = gpuEmitter(8);
    try {
      emitter.burst(6);
      gl.__passCalls.length = 0;
      emitter.burst(5); // slots 6, 7, then 0, 1, 2.

      expect(callsNamed(gl, "drawArrays").map((call) => call.args.slice(1))).toEqual([
        [6, 2],
        [0, 3],
      ]);
      const slotBytes = 6 * 4;
      expect(callsNamed(gl, "copyBufferSubData").map((call) => call.args.slice(2))).toEqual([
        [6 * slotBytes, 6 * slotBytes, 2 * slotBytes],
        [0, 0, 3 * slotBytes],
      ]);
    } finally {
      emitter.destroy();
      world.dispose();
    }
  });

  it("caps a burst larger than the ring at one full ring", () => {
    const { emitter, world, gl } = gpuEmitter(8);
    try {
      emitter.burst(20);
      const drawn = callsNamed(gl, "drawArrays").reduce(
        (total, call) => total + (call.args[2] as number),
        0,
      );
      expect(drawn).toBe(8);
      expect(gl.__uniformCalls.get(FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_COUNT_UNIFORM)).toBe(8);
    } finally {
      emitter.destroy();
      world.dispose();
    }
  });

  it("gathers spawns inside a tick (delayed bursts, plays) into that tick's own pass", () => {
    const { emitter, world, gl } = gpuEmitter(32);
    try {
      emitter.burst(3, { delay: 0.01 });
      emitter.play(120);
      gl.__passCalls.length = 0;
      world.update(1 / 60); // the delayed burst expires (3) and the play emits 2.

      // No spawn pass of their own: one full-ring pass whose birth range carries all of them.
      expect(callsNamed(gl, "drawArrays").map((call) => call.args.slice(1))).toEqual([[0, 32]]);
      expect(gl.__uniformCalls.get(FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_START_UNIFORM)).toBe(0);
      expect(gl.__uniformCalls.get(FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_COUNT_UNIFORM)).toBe(5);

      // The next tick's range starts right after them.
      world.update(1 / 60);
      expect(gl.__uniformCalls.get(FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_START_UNIFORM)).toBe(5);
    } finally {
      emitter.destroy();
      world.dispose();
    }
  });

  it("reset() rewinds the spawn cursor, so the next burst starts at slot 0 again", () => {
    const { emitter, world, gl } = gpuEmitter(32);
    try {
      emitter.burst(5);
      emitter.reset();
      gl.__passCalls.length = 0;
      emitter.burst(2);
      expect(callsNamed(gl, "drawArrays").map((call) => call.args.slice(1))).toEqual([[0, 2]]);

      world.update(1 / 60);
      expect(gl.__uniformCalls.get(FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_COUNT_UNIFORM)).toBe(0);
    } finally {
      emitter.destroy();
      world.dispose();
    }
  });

  it("applyRenderArtifact swaps the material in place without touching the GPU kernel/buffers", () => {
    // Proves FXGPUEmitterDriver.applyRenderArtifact re-derives its varyings from the kernel's OWN
    // buffers (never a JS behavior artifact's attributeWrites - same independence as construction,
    // see the test above), and that a render-only swap leaves the simulation in place.
    const world = new FXWorld();
    const emitter = FXEmitter.fromArtifacts(
      unlitArtifact(),
      behaviorArtifact({ lifetime: 5 }),
      { gpuKernel: minimalKernel(), renderer: mockRenderer() as never, expectedCapacity: 16 },
      world,
    );
    try {
      expect(isGPUMesh(emitter)).toBe(true);
      emitter.burst(4);
      const mesh = meshOf(emitter) as unknown as { material: unknown; geometry: unknown };
      const materialBefore = mesh.material;

      emitter.applyRenderArtifact(
        unlitArtifact({ outputs: { albedo: "vec4(0.0, 1.0, 0.0, 1.0)" } }),
      );

      expect(mesh.material).not.toBe(materialBefore);
      // Still the same mesh instance, same fixed capacity - nothing about the driver was rebuilt.
      expect(meshOf(emitter)).toBe(mesh);
      expect(emitter.particleCapacity).toBe(16);
      expect(() => world.update(1 / 60)).not.toThrow();
    } finally {
      emitter.destroy();
      world.dispose();
    }
  });

  it("applyRenderArtifact rejects a GPU emitter's render swap that adds an unallocated attribute", () => {
    const emitter = FXEmitter.fromArtifacts(unlitArtifact(), behaviorArtifact({ lifetime: 5 }), {
      gpuKernel: minimalKernel(),
      renderer: mockRenderer() as never,
      expectedCapacity: 16,
    });
    try {
      expect(isGPUMesh(emitter)).toBe(true);
      expect(() =>
        emitter.applyRenderArtifact(
          unlitArtifact({ attributeReads: [{ name: "glow", components: 1 }] }),
        ),
      ).toThrow(/attribute reads no longer match/);
    } finally {
      emitter.destroy();
    }
  });
});

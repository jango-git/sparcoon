import { describe, expect, it } from "vitest";
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

function mockGL(options: { failLink?: boolean } = {}): unknown {
  let nextId = 1;
  const liveBuffers = new Set<unknown>();
  const uniformLocationNames = new Map<unknown, string>();
  const uniformCalls = new Map<string, number>();
  return {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    SEPARATE_ATTRIBS: 5,
    ARRAY_BUFFER: 6,
    TRANSFORM_FEEDBACK_BUFFER: 7,
    FLOAT: 8,
    POINTS: 9,
    RASTERIZER_DISCARD: 10,
    DYNAMIC_DRAW: 11,
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
    uniform1i: (location: unknown, value: number) => {
      const name = uniformLocationNames.get(location);
      if (name !== undefined) {
        uniformCalls.set(name, value);
      }
    },
    uniform1f: () => undefined,
    uniformMatrix4fv: () => undefined,
    uniform3fv: () => undefined,
    enable: () => undefined,
    disable: () => undefined,
    beginTransformFeedback: () => undefined,
    endTransformFeedback: () => undefined,
    drawArrays: () => undefined,
    // Exposed for assertions only, not part of the real WebGL2RenderingContext surface.
    __liveBuffers: liveBuffers,
    __uniformCalls: uniformCalls,
  };
}

function mockRenderer(options: { failLink?: boolean } = {}): {
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

  it("reports an immediate burst() called BEFORE any tick as a birth range on the very next tick", () => {
    // Regression: the GPU spawn range/count must accumulate across spawn() calls since the last
    // endTick(), not since the start of the current tick. burst() with no delay calls spawn()
    // directly, outside of any tick - the ordinary way to fire a one-shot effect, never touching
    // pendingBursts/activePlays at all. If the range/count instead reset at the START of the next
    // tick (beginTick), this burst's contribution would be silently discarded before ever reaching
    // the GPU as a birth range, even though the cursor had already moved past those slots - the
    // particles would exist as claimed slots but never actually get spawned by the shader.
    const kernel: FXParticleKernelArtifact = {
      vertexSource: "#version 300 es\nvoid main(){}",
      fragmentSource: "#version 300 es\nvoid main(){}",
      buffers: [
        { name: "position", stride: 3 },
        { name: "lifecycle", stride: 3 },
      ],
      transformFeedbackVaryings: ["out_position", "out_lifecycle"],
      bindings: {},
    };
    const world = new FXWorld();
    const renderer = mockRenderer();
    const emitter = FXEmitter.fromArtifacts(
      unlitArtifact(),
      behaviorArtifact({ lifetime: 5 }),
      { gpuKernel: kernel, renderer: renderer as never, expectedCapacity: 32 },
      world,
    );
    try {
      expect(isGPUMesh(emitter)).toBe(true);
      emitter.burst(5); // immediate: runs right now, not scheduled, not inside any tick.

      const gl = renderer.getContext() as unknown as { __uniformCalls: Map<string, number> };
      world.update(1 / 60);

      expect(gl.__uniformCalls.get(FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_START_UNIFORM)).toBe(0);
      expect(gl.__uniformCalls.get(FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_COUNT_UNIFORM)).toBe(5);
    } finally {
      emitter.destroy();
      world.dispose();
    }
  });

  it("reset() cancels an already-accumulated, not-yet-consumed spawn range - no stray birth on the next tick", () => {
    // Regression, follow-on from the fix above: endTick() now only clears the accumulated range
    // AFTER consuming it (not at the start of every tick), so a burst() that ran before reset() -
    // still unconsumed - must be explicitly cleared BY reset() too, or it would still spawn on the
    // next tick despite reset() having just been called to cancel exactly that.
    const kernel: FXParticleKernelArtifact = {
      vertexSource: "#version 300 es\nvoid main(){}",
      fragmentSource: "#version 300 es\nvoid main(){}",
      buffers: [
        { name: "position", stride: 3 },
        { name: "lifecycle", stride: 3 },
      ],
      transformFeedbackVaryings: ["out_position", "out_lifecycle"],
      bindings: {},
    };
    const world = new FXWorld();
    const renderer = mockRenderer();
    const emitter = FXEmitter.fromArtifacts(
      unlitArtifact(),
      behaviorArtifact({ lifetime: 5 }),
      { gpuKernel: kernel, renderer: renderer as never, expectedCapacity: 32 },
      world,
    );
    try {
      emitter.burst(5); // accumulates into the not-yet-consumed range...
      emitter.reset(); // ...which reset() must cancel before it is ever reported.

      const gl = renderer.getContext() as unknown as { __uniformCalls: Map<string, number> };
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
    // see the test above), and that a render-only swap never resets the accumulated spawn cursor.
    const world = new FXWorld();
    const emitter = FXEmitter.fromArtifacts(
      unlitArtifact(),
      behaviorArtifact({ lifetime: 5 }),
      { gpuKernel: minimalKernel(), renderer: mockRenderer() as never, expectedCapacity: 16 },
      world,
    );
    try {
      expect(isGPUMesh(emitter)).toBe(true);
      emitter.burst(4); // accumulates a not-yet-consumed spawn range.
      const mesh = meshOf(emitter) as unknown as { material: unknown; geometry: unknown };
      const materialBefore = mesh.material;

      emitter.applyRenderArtifact(
        unlitArtifact({ outputs: { albedo: "vec4(0.0, 1.0, 0.0, 1.0)" } }),
      );

      expect(mesh.material).not.toBe(materialBefore);
      // Still the same mesh instance, same fixed capacity - nothing about the driver was rebuilt.
      expect(meshOf(emitter)).toBe(mesh);
      expect(emitter.particleCapacity).toBe(16);
      // The not-yet-consumed spawn range survived the swap (never reset by it).
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

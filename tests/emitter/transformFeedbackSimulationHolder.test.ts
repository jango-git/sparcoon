import { describe, expect, it } from "vitest";
import { BufferAttribute, BufferGeometry, MeshBasicMaterial } from "three";
import type { FXEmitterTransform, FXParticleKernelArtifact } from "../../src/artifact/FXArtifact";
import { FXTransformFeedbackSimulationHolder } from "../../src/emitter/FXTransformFeedbackSimulationHolder";
import { FXTransformFeedbackParticle } from "../../src/instancedParticle/FXTransformFeedbackParticle";
import {
  FX_TRANSFORM_FEEDBACK_CAPACITY_UNIFORM,
  FX_TRANSFORM_FEEDBACK_DELTA_TIME_UNIFORM,
  FX_TRANSFORM_FEEDBACK_RAND_SEED_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SPAWN_ID_BASE_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_COUNT_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_START_UNIFORM,
} from "../../src/behaviorTransformFeedbackLayout";

// No real WebGL2 context is available in this headless test run. This mock cannot prove the
// GLSL/GL calls behave correctly against a real driver - it proves the JS-side orchestration:
// call order (useProgram before
// bindVertexArray, RASTERIZER_DISCARD strictly bracketing the draw, transform feedback strictly
// bracketing the draw, resetState() last), the per-tick rand-seed advance, and that every buffer
// gets swapped exactly once per tick.

interface RecordedCall {
  readonly name: string;
  readonly args: readonly unknown[];
}

function mockRendererAndGL(): {
  renderer: {
    getContext: () => unknown;
    state: { useProgram: (p: unknown) => void };
    resetState: () => void;
  };
  calls: RecordedCall[];
  uniformCalls: Map<string, unknown[]>;
} {
  const calls: RecordedCall[] = [];
  const uniformCalls = new Map<string, unknown[]>();
  let nextId = 1;
  const uniformLocationNames = new Map<unknown, string>();

  const record = (name: string, ...args: unknown[]): void => {
    calls.push({ name, args });
  };

  const gl = {
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
    createBuffer: () => ({ id: nextId++ }),
    createShader: () => ({ id: nextId++ }),
    shaderSource: () => undefined,
    compileShader: () => undefined,
    getShaderParameter: () => true,
    getShaderInfoLog: () => "",
    deleteShader: () => undefined,
    createProgram: () => ({ id: nextId++ }),
    attachShader: () => undefined,
    transformFeedbackVaryings: (...args: unknown[]) => record("transformFeedbackVaryings", ...args),
    linkProgram: (...args: unknown[]) => record("linkProgram", ...args),
    getProgramParameter: () => true,
    getProgramInfoLog: () => "",
    createVertexArray: () => ({ id: nextId++ }),
    deleteVertexArray: () => undefined,
    deleteProgram: () => undefined,
    getUniformLocation: (_program: unknown, name: string) => {
      const location = { id: nextId++ };
      uniformLocationNames.set(location, name);
      return location;
    },
    bindVertexArray: (...args: unknown[]) => record("bindVertexArray", ...args),
    bindBuffer: (...args: unknown[]) => record("bindBuffer", ...args),
    vertexAttribPointer: (...args: unknown[]) => record("vertexAttribPointer", ...args),
    enableVertexAttribArray: (...args: unknown[]) => record("enableVertexAttribArray", ...args),
    bindBufferBase: (...args: unknown[]) => record("bindBufferBase", ...args),
    uniform1i: (location: unknown, value: number) => {
      const name = uniformLocationNames.get(location);
      if (name !== undefined) {
        uniformCalls.set(name, [value]);
      }
      record("uniform1i", location, value);
    },
    uniform1f: (location: unknown, value: number) => {
      const name = uniformLocationNames.get(location);
      if (name !== undefined) {
        uniformCalls.set(name, [value]);
      }
      record("uniform1f", location, value);
    },
    uniformMatrix4fv: (...args: unknown[]) => record("uniformMatrix4fv", ...args),
    uniform3fv: (...args: unknown[]) => record("uniform3fv", ...args),
    enable: (...args: unknown[]) => record("enable", ...args),
    disable: (...args: unknown[]) => record("disable", ...args),
    beginTransformFeedback: (...args: unknown[]) => record("beginTransformFeedback", ...args),
    endTransformFeedback: (...args: unknown[]) => record("endTransformFeedback", ...args),
    drawArrays: (...args: unknown[]) => record("drawArrays", ...args),
    deleteBuffer: () => undefined,
    bufferData: () => undefined,
  };

  const renderer = {
    getContext: () => gl,
    state: { useProgram: (program: unknown) => record("state.useProgram", program) },
    resetState: () => record("resetState"),
  };

  return { renderer, calls, uniformCalls };
}

function baseQuad(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(12), 3));
  geometry.setAttribute("uv", new BufferAttribute(new Float32Array(8), 2));
  geometry.setAttribute("normal", new BufferAttribute(new Float32Array(12), 3));
  return geometry;
}

function minimalArtifact(): FXParticleKernelArtifact {
  return {
    vertexSource: "#version 300 es\nvoid main(){}",
    fragmentSource: "#version 300 es\nvoid main(){}",
    buffers: [{ name: "position", stride: 3 }],
    transformFeedbackVaryings: ["out_position"],
    bindings: {},
  };
}

const IDENTITY_TRANSFORM: FXEmitterTransform = {
  worldMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  velocity: [0, 0, 0],
  angularVelocity: [0, 0, 0],
};

describe("FXTransformFeedbackSimulationHolder", () => {
  it("declares transformFeedbackVaryings before linking the program", () => {
    const { renderer, calls } = mockRendererAndGL();
    const holder = new FXTransformFeedbackSimulationHolder(renderer as never, minimalArtifact());
    try {
      const names = calls.map((call) => call.name);
      expect(names.indexOf("transformFeedbackVaryings")).toBeLessThan(names.indexOf("linkProgram"));
    } finally {
      holder.destroy();
    }
  });

  it("brackets the draw with beginTransformFeedback/endTransformFeedback and RASTERIZER_DISCARD, in order", () => {
    const { renderer, calls } = mockRendererAndGL();
    const holder = new FXTransformFeedbackSimulationHolder(renderer as never, minimalArtifact());
    const mesh = new FXTransformFeedbackParticle(
      renderer.getContext() as never,
      { position: { glslTypeName: "vec3", bufferSize: 3, instantiable: true } },
      16,
      new MeshBasicMaterial(),
      baseQuad(),
    );
    try {
      calls.length = 0;
      holder.tick(mesh, 1 / 60, { start: 0, count: 4 }, IDENTITY_TRANSFORM);

      const names = calls.map((call) => call.name);
      const enableIndex = names.indexOf("enable");
      const beginIndex = names.indexOf("beginTransformFeedback");
      const drawIndex = names.indexOf("drawArrays");
      const endIndex = names.indexOf("endTransformFeedback");
      const disableIndex = names.indexOf("disable");
      const resetIndex = names.indexOf("resetState");

      expect(enableIndex).toBeLessThan(beginIndex);
      expect(beginIndex).toBeLessThan(drawIndex);
      expect(drawIndex).toBeLessThan(endIndex);
      expect(endIndex).toBeLessThan(disableIndex);
      // resetState is the very last thing this tick does.
      expect(resetIndex).toBe(names.length - 1);

      // The program is bound through the renderer's own cache-aware setter, never raw
      // gl.useProgram - and before the (raw) VAO bind, since attribute setup depends on it.
      const useProgramIndex = names.indexOf("state.useProgram");
      const bindVaoIndex = names.indexOf("bindVertexArray");
      expect(useProgramIndex).toBeGreaterThanOrEqual(0);
      expect(useProgramIndex).toBeLessThan(bindVaoIndex);
    } finally {
      mesh.destroy();
      holder.destroy();
    }
  });

  it("advances the rand seed every tick and passes through dt/spawn-range uniforms", () => {
    const { renderer, uniformCalls } = mockRendererAndGL();
    const holder = new FXTransformFeedbackSimulationHolder(renderer as never, minimalArtifact());
    const mesh = new FXTransformFeedbackParticle(
      renderer.getContext() as never,
      { position: { glslTypeName: "vec3", bufferSize: 3, instantiable: true } },
      16,
      new MeshBasicMaterial(),
      baseQuad(),
    );
    try {
      holder.tick(mesh, 1 / 30, { start: 5, count: 2 }, IDENTITY_TRANSFORM);
      expect(uniformCalls.get(FX_TRANSFORM_FEEDBACK_RAND_SEED_UNIFORM)).toEqual([1]);
      expect(uniformCalls.get(FX_TRANSFORM_FEEDBACK_DELTA_TIME_UNIFORM)).toEqual([1 / 30]);
      expect(uniformCalls.get(FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_START_UNIFORM)).toEqual([5]);
      expect(uniformCalls.get(FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_COUNT_UNIFORM)).toEqual([2]);
      expect(uniformCalls.get(FX_TRANSFORM_FEEDBACK_CAPACITY_UNIFORM)).toEqual([16]);
      // No particle spawned yet this emitter's whole lifetime, so the base an id offsets from
      // this first tick's births is still zero.
      expect(uniformCalls.get(FX_TRANSFORM_FEEDBACK_SPAWN_ID_BASE_UNIFORM)).toEqual([0]);

      holder.tick(mesh, 1 / 30, { start: 5, count: 2 }, IDENTITY_TRANSFORM);
      // A fresh, different seed the very next tick - never the same draw twice in a row.
      expect(uniformCalls.get(FX_TRANSFORM_FEEDBACK_RAND_SEED_UNIFORM)).toEqual([2]);
      // Advanced by the previous tick's spawn count (2) - never reset between ticks.
      expect(uniformCalls.get(FX_TRANSFORM_FEEDBACK_SPAWN_ID_BASE_UNIFORM)).toEqual([2]);
    } finally {
      mesh.destroy();
      holder.destroy();
    }
  });

  it("swaps every declared buffer exactly once per tick, after the draw completes", () => {
    const { renderer } = mockRendererAndGL();
    const artifact: FXParticleKernelArtifact = {
      ...minimalArtifact(),
      buffers: [
        { name: "position", stride: 3 },
        { name: "lifecycle", stride: 3 },
      ],
      transformFeedbackVaryings: ["out_position", "out_lifecycle"],
    };
    const holder = new FXTransformFeedbackSimulationHolder(renderer as never, artifact);
    const mesh = new FXTransformFeedbackParticle(
      renderer.getContext() as never,
      {
        position: { glslTypeName: "vec3", bufferSize: 3, instantiable: true },
        lifecycle: { glslTypeName: "vec3", bufferSize: 3, instantiable: true },
      },
      16,
      new MeshBasicMaterial(),
      baseQuad(),
    );
    try {
      const positionReadBefore = mesh.readBuffer("position");
      const lifecycleReadBefore = mesh.readBuffer("lifecycle");

      holder.tick(mesh, 1 / 60, { start: 0, count: 0 }, IDENTITY_TRANSFORM);

      // Both buffers flipped - the previous write side is now the read side for each.
      expect(mesh.readBuffer("position")).not.toBe(positionReadBefore);
      expect(mesh.readBuffer("lifecycle")).not.toBe(lifecycleReadBefore);
    } finally {
      mesh.destroy();
      holder.destroy();
    }
  });

  it("alternates cleanly across many ticks (A->B->A->B), never drifting to a third buffer", () => {
    // Only two physical WebGLBuffers ever exist per state buffer (FXTransformFeedbackParticle
    // never allocates a third) - this proves the swap is a genuine two-state flip sustained over
    // real usage, not something that happens to work once and then leaks/allocates further.
    const { renderer } = mockRendererAndGL();
    const holder = new FXTransformFeedbackSimulationHolder(renderer as never, minimalArtifact());
    const mesh = new FXTransformFeedbackParticle(
      renderer.getContext() as never,
      { position: { glslTypeName: "vec3", bufferSize: 3, instantiable: true } },
      16,
      new MeshBasicMaterial(),
      baseQuad(),
    );
    try {
      const bufferA = mesh.readBuffer("position");
      const bufferB = mesh.writeBuffer("position");

      for (let tick = 0; tick < 6; tick += 1) {
        const expectedRead = tick % 2 === 0 ? bufferB : bufferA;
        holder.tick(mesh, 1 / 60, { start: 0, count: 0 }, IDENTITY_TRANSFORM);
        expect(mesh.readBuffer("position")).toBe(expectedRead);
        // The two physical buffers are always exactly {bufferA, bufferB} - read and write are
        // never simultaneously the same buffer, and never a buffer outside this original pair.
        expect(new Set([mesh.readBuffer("position"), mesh.writeBuffer("position")])).toEqual(
          new Set([bufferA, bufferB]),
        );
      }
    } finally {
      mesh.destroy();
      holder.destroy();
    }
  });
});

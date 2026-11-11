import { describe, expect, it } from "vitest";
import { BufferAttribute, BufferGeometry, MeshBasicMaterial } from "three";
import type { FXParticleKernelArtifact } from "../../src/artifact/FXArtifact";
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
import { flushStateResets } from "../../src/render/FXDeferredStateReset.Internal";
import { IDENTITY_EMITTER_TRANSFORM } from "../helpers/artifacts";
import { callsNamed, mockRenderer, type MockRenderer } from "../helpers/mockWebGL";

// The mock context proves the JS-side orchestration: call order (useProgram before bindVertexArray,
// RASTERIZER_DISCARD and transform feedback strictly bracketing the draw, three's state reset owed), the
// per-tick rand-seed advance, and that the buffer pair swaps exactly once per tick.

function baseQuad(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(12), 3));
  geometry.setAttribute("uv", new BufferAttribute(new Float32Array(8), 2));
  geometry.setAttribute("normal", new BufferAttribute(new Float32Array(12), 3));
  return geometry;
}

/** A mesh laid out the way `holder`'s kernel writes, every slot field a float varying. */
function meshFor(
  mock: MockRenderer,
  holder: FXTransformFeedbackSimulationHolder,
): FXTransformFeedbackParticle {
  return new FXTransformFeedbackParticle(
    mock.gl.context,
    holder.layout,
    16,
    new MeshBasicMaterial(),
    baseQuad(),
  );
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

describe("FXTransformFeedbackSimulationHolder", () => {
  it("declares transformFeedbackVaryings before linking the program", () => {
    const mock = mockRenderer();
    const { calls } = mock.gl;
    const holder = new FXTransformFeedbackSimulationHolder(mock.renderer, minimalArtifact());
    try {
      const names = calls.map((call) => call.name);
      expect(names.indexOf("transformFeedbackVaryings")).toBeLessThan(names.indexOf("linkProgram"));
    } finally {
      holder.destroy();
    }
  });

  it("captures the kernel's outputs interleaved into one buffer", () => {
    const mock = mockRenderer();
    const { calls } = mock.gl;
    const holder = new FXTransformFeedbackSimulationHolder(mock.renderer, minimalArtifact());
    try {
      const varyings = calls.find((call) => call.name === "transformFeedbackVaryings");
      expect(varyings?.args.slice(1)).toEqual([
        ["out_position"],
        mock.gl.context.INTERLEAVED_ATTRIBS,
      ]);
    } finally {
      holder.destroy();
    }
  });

  it.each([
    ["the vertex shader", true, 1],
    ["the fragment shader", "fragment", 2],
  ] as const)(
    "throws when %s fails to compile, deleting every shader it made and linking nothing",
    (_shader, failCompile, shadersMade) => {
      const mock = mockRenderer({ failCompile });
      expect(
        () => new FXTransformFeedbackSimulationHolder(mock.renderer, minimalArtifact()),
      ).toThrow(/shader failed to compile: mock compile failure/);
      expect(callsNamed(mock.gl, "deleteShader")).toHaveLength(shadersMade);
      expect(callsNamed(mock.gl, "linkProgram")).toEqual([]);
    },
  );

  it("refuses a kernel whose slot does not fit this GPU, before touching GL", () => {
    const twoBuffers: FXParticleKernelArtifact = {
      ...minimalArtifact(),
      buffers: [
        { name: "position", stride: 3 },
        { name: "lifecycle", stride: 3 },
      ],
      transformFeedbackVaryings: ["out_position", "out_lifecycle"],
    };
    const tooManyComponents = mockRenderer({ maxFeedbackComponents: 5 });
    expect(
      () => new FXTransformFeedbackSimulationHolder(tooManyComponents.renderer, twoBuffers),
    ).toThrow(/writes 6 components per particle.*at most 5/);
    const tooManyInputs = mockRenderer({ maxVertexAttribs: 1 });
    expect(
      () => new FXTransformFeedbackSimulationHolder(tooManyInputs.renderer, twoBuffers),
    ).toThrow(/reads 2 buffers.*1 vertex inputs/);
    // A slot past WebGL's 255-byte vertex stride: 64 floats (within the 64 components) is 256 bytes.
    const wide: FXParticleKernelArtifact = {
      ...minimalArtifact(),
      buffers: Array.from({ length: 16 }, (_, index) => ({ name: `b${String(index)}`, stride: 4 })),
      transformFeedbackVaryings: Array.from({ length: 16 }, (_, index) => `out_b${String(index)}`),
    };
    const roomy = mockRenderer({ maxVertexAttribs: 32 });
    expect(() => new FXTransformFeedbackSimulationHolder(roomy.renderer, wide)).toThrow(
      /256 bytes.*at most 255/,
    );
    expect(callsNamed(tooManyComponents.gl, "linkProgram")).toEqual([]);
  });

  it("reads every slot field from the one read buffer, at its own offset, with the slot as stride", () => {
    const mock = mockRenderer();
    const { calls } = mock.gl;
    const artifact: FXParticleKernelArtifact = {
      ...minimalArtifact(),
      buffers: [
        { name: "position", stride: 3 },
        { name: "lifecycle", stride: 3 },
        { name: "glow", stride: 1 },
      ],
      transformFeedbackVaryings: ["out_position", "out_lifecycle", "out_glow"],
    };
    const holder = new FXTransformFeedbackSimulationHolder(mock.renderer, artifact);
    const mesh = meshFor(mock, holder);
    try {
      calls.length = 0;
      holder.tick(mesh, 1 / 60, { start: 0, count: 0 }, IDENTITY_EMITTER_TRANSFORM);
      const pointers = calls
        .filter((call) => call.name === "vertexAttribPointer")
        .map((call) => [call.args[0], call.args[1], call.args[4], call.args[5]]);
      // [location, components, stride bytes, offset bytes]
      expect(pointers).toEqual([
        [0, 3, 28, 0],
        [1, 3, 28, 12],
        [2, 1, 28, 24],
      ]);
      const feedback = calls.filter((call) => call.name === "bindBufferBase");
      expect(feedback.map((call) => call.args.slice(1))).toEqual([
        [0, mesh.readBuffer()], // the write half then, swapped to read since
        [0, null],
      ]);
    } finally {
      mesh.destroy();
      holder.destroy();
    }
  });

  it("brackets the draw with beginTransformFeedback/endTransformFeedback and RASTERIZER_DISCARD, in order", () => {
    const mock = mockRenderer();
    const { calls } = mock.gl;
    const holder = new FXTransformFeedbackSimulationHolder(mock.renderer, minimalArtifact());
    const mesh = meshFor(mock, holder);
    try {
      calls.length = 0;
      holder.tick(mesh, 1 / 60, { start: 0, count: 4 }, IDENTITY_EMITTER_TRANSFORM);

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
      // Owed, not made: the world resets once its whole tick is done.
      expect(resetIndex).toBe(-1);
      flushStateResets();
      expect(callsNamed(mock.gl, "resetState")).toHaveLength(1);

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
    const mock = mockRenderer();
    const { uniforms } = mock.gl;
    const holder = new FXTransformFeedbackSimulationHolder(mock.renderer, minimalArtifact());
    const mesh = meshFor(mock, holder);
    try {
      holder.tick(mesh, 1 / 30, { start: 5, count: 2 }, IDENTITY_EMITTER_TRANSFORM);
      expect(uniforms.get(FX_TRANSFORM_FEEDBACK_RAND_SEED_UNIFORM)).toBe(1);
      expect(uniforms.get(FX_TRANSFORM_FEEDBACK_DELTA_TIME_UNIFORM)).toBe(1 / 30);
      expect(uniforms.get(FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_START_UNIFORM)).toBe(5);
      expect(uniforms.get(FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_COUNT_UNIFORM)).toBe(2);
      expect(uniforms.get(FX_TRANSFORM_FEEDBACK_CAPACITY_UNIFORM)).toBe(16);
      // No particle spawned yet this emitter's whole lifetime, so the base an id offsets from
      // this first tick's births is still zero.
      expect(uniforms.get(FX_TRANSFORM_FEEDBACK_SPAWN_ID_BASE_UNIFORM)).toBe(0);

      holder.tick(mesh, 1 / 30, { start: 5, count: 2 }, IDENTITY_EMITTER_TRANSFORM);
      // A fresh, different seed the very next tick - never the same draw twice in a row.
      expect(uniforms.get(FX_TRANSFORM_FEEDBACK_RAND_SEED_UNIFORM)).toBe(2);
      // Advanced by the previous tick's spawn count (2) - never reset between ticks.
      expect(uniforms.get(FX_TRANSFORM_FEEDBACK_SPAWN_ID_BASE_UNIFORM)).toBe(2);
    } finally {
      mesh.destroy();
      holder.destroy();
    }
  });

  it("swaps the pair exactly once per tick, after the draw completes", () => {
    const mock = mockRenderer();
    const artifact: FXParticleKernelArtifact = {
      ...minimalArtifact(),
      buffers: [
        { name: "position", stride: 3 },
        { name: "lifecycle", stride: 3 },
      ],
      transformFeedbackVaryings: ["out_position", "out_lifecycle"],
    };
    const holder = new FXTransformFeedbackSimulationHolder(mock.renderer, artifact);
    const mesh = meshFor(mock, holder);
    try {
      const readBefore = mesh.readBuffer();
      const writeBefore = mesh.writeBuffer();

      holder.tick(mesh, 1 / 60, { start: 0, count: 0 }, IDENTITY_EMITTER_TRANSFORM);

      // Flipped: the half just written is now the one read.
      expect(mesh.readBuffer()).toBe(writeBefore);
      expect(mesh.writeBuffer()).toBe(readBefore);
    } finally {
      mesh.destroy();
      holder.destroy();
    }
  });

  it("alternates cleanly across many ticks (A->B->A->B), never drifting to a third buffer", () => {
    // Only two physical WebGLBuffers ever exist for the state (FXTransformFeedbackParticle
    // never allocates a third) - this proves the swap is a genuine two-state flip sustained over
    // real usage, not something that happens to work once and then leaks/allocates further.
    const mock = mockRenderer();
    const holder = new FXTransformFeedbackSimulationHolder(mock.renderer, minimalArtifact());
    const mesh = meshFor(mock, holder);
    try {
      const bufferA = mesh.readBuffer();
      const bufferB = mesh.writeBuffer();

      for (let tick = 0; tick < 6; tick += 1) {
        const expectedRead = tick % 2 === 0 ? bufferB : bufferA;
        holder.tick(mesh, 1 / 60, { start: 0, count: 0 }, IDENTITY_EMITTER_TRANSFORM);
        expect(mesh.readBuffer()).toBe(expectedRead);
        // The two physical buffers are always exactly {bufferA, bufferB} - read and write are
        // never simultaneously the same buffer, and never a buffer outside this original pair.
        expect(new Set([mesh.readBuffer(), mesh.writeBuffer()])).toEqual(
          new Set([bufferA, bufferB]),
        );
      }
    } finally {
      mesh.destroy();
      holder.destroy();
    }
  });

  it("spawn() seeds only its range: releases transform feedback before copying, never swaps", () => {
    const mock = mockRenderer();
    const { calls, uniforms } = mock.gl;
    const holder = new FXTransformFeedbackSimulationHolder(mock.renderer, minimalArtifact());
    const mesh = meshFor(mock, holder);
    try {
      const read = mesh.readBuffer();
      const write = mesh.writeBuffer();
      calls.length = 0;
      holder.spawn(mesh, { start: 3, count: 4 }, IDENTITY_EMITTER_TRANSFORM);

      const names = calls.map((call) => call.name);
      // Captured into the write half at the range's own offset...
      const range = calls.find((call) => call.name === "bindBufferRange");
      expect(range?.args.slice(2)).toEqual([write, 3 * 12, 4 * 12]);
      expect(calls.find((call) => call.name === "drawArrays")?.args.slice(1)).toEqual([3, 4]);
      // ...released from transform feedback before it is copied into the read half.
      const releaseIndex = names.lastIndexOf("bindBufferBase");
      expect(releaseIndex).toBeLessThan(names.indexOf("copyBufferSubData"));
      expect(calls.find((call) => call.name === "copyBufferSubData")?.args.slice(2)).toEqual([
        3 * 12,
        3 * 12,
        4 * 12,
      ]);
      expect(names).not.toContain("resetState");
      // No swap: the slots outside the range keep the read half they already had.
      expect(mesh.readBuffer()).toBe(read);
      expect(uniforms.get(FX_TRANSFORM_FEEDBACK_DELTA_TIME_UNIFORM)).toBe(0);

      // Ids keep counting across spawn passes and ticks alike.
      holder.tick(mesh, 1 / 60, { start: 7, count: 0 }, IDENTITY_EMITTER_TRANSFORM);
      expect(uniforms.get(FX_TRANSFORM_FEEDBACK_SPAWN_ID_BASE_UNIFORM)).toBe(4);
    } finally {
      mesh.destroy();
      holder.destroy();
    }
  });

  it("shares one program with every holder of the same kernel, deleted with the last", () => {
    const mock = mockRenderer();
    const first = new FXTransformFeedbackSimulationHolder(mock.renderer, minimalArtifact());
    const second = new FXTransformFeedbackSimulationHolder(mock.renderer, minimalArtifact());
    expect(callsNamed(mock.gl, "linkProgram")).toHaveLength(1);

    first.destroy();
    expect(callsNamed(mock.gl, "deleteProgram")).toEqual([]);
    second.destroy();
    expect(callsNamed(mock.gl, "deleteProgram")).toHaveLength(1);
  });
});

import {
  BufferAttribute,
  BufferGeometry,
  DepthTexture,
  MeshBasicMaterial,
  PerspectiveCamera,
  WebGLRenderTarget,
} from "three";
import { describe, expect, it, vi } from "vitest";

import type { FXParticleKernelArtifact } from "../../src/artifact/FXArtifact";
import {
  FX_TRANSFORM_FEEDBACK_CAPACITY_UNIFORM,
  FX_TRANSFORM_FEEDBACK_DELTA_TIME_UNIFORM,
  FX_TRANSFORM_FEEDBACK_RAND_SEED_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SCENE_DEPTH_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SPAWN_ID_BASE_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_COUNT_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_START_UNIFORM,
} from "../../src/behaviorTransformFeedbackLayout";
import { FXCameraView } from "../../src/emitter/FXCameraView.Internal";
import type { FXSurfaceTable } from "../../src/emitter/FXSurfaceTable.Internal";
import { FXTransformFeedbackSimulationHolder } from "../../src/emitter/FXTransformFeedbackSimulationHolder";
import type { FXVolumeTable } from "../../src/emitter/FXVolumeTable.Internal";
import { FXTransformFeedbackParticle } from "../../src/instancedParticle/FXTransformFeedbackParticle";
import { fxSetCameraDepth } from "../../src/render/FXCameraDepth";
import { flushStateResets } from "../../src/render/FXDeferredStateReset.Internal";
import { IDENTITY_EMITTER_TRANSFORM, NOTHING_INHERITED } from "../helpers/artifacts";
import { callsNamed, type MockRenderer, mockRenderer } from "../helpers/mockWebGL";
import { allViews } from "../helpers/slots";

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
    holder.slot,
    allViews(holder.slot),
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

  it("reads no status, log or uniform of the program until its first pass", () => {
    const mock = mockRenderer();
    const holder = new FXTransformFeedbackSimulationHolder(mock.renderer, minimalArtifact());
    const mesh = meshFor(mock, holder);
    try {
      for (const name of ["getShaderParameter", "getProgramParameter", "getUniformLocation"]) {
        expect(callsNamed(mock.gl, name)).toEqual([]);
      }
      holder.tick(
        mesh,
        1 / 60,
        { start: 0, count: 0 },
        IDENTITY_EMITTER_TRANSFORM,
        NOTHING_INHERITED,
      );
      expect(callsNamed(mock.gl, "getProgramParameter").length).toBeGreaterThan(0);
      expect(callsNamed(mock.gl, "getUniformLocation").length).toBeGreaterThan(0);
      expect(callsNamed(mock.gl, "drawArrays")).toHaveLength(1);
    } finally {
      holder.destroy();
      flushStateResets();
    }
  });

  it.each([
    ["the vertex shader", true],
    ["the fragment shader", "fragment"],
  ] as const)(
    "runs no pass when %s fails to compile, logging the failure once",
    (_shader, failCompile) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const mock = mockRenderer({ failCompile });
      const holder = new FXTransformFeedbackSimulationHolder(mock.renderer, minimalArtifact());
      const mesh = meshFor(mock, holder);
      try {
        expect(holder.program.failure).toBeUndefined();
        holder.tick(
          mesh,
          1 / 60,
          { start: 0, count: 1 },
          IDENTITY_EMITTER_TRANSFORM,
          NOTHING_INHERITED,
        );
        expect(holder.program.failure).toBe("mock compile failure");
        holder.spawn(mesh, { start: 0, count: 1 }, IDENTITY_EMITTER_TRANSFORM, NOTHING_INHERITED);
        expect(callsNamed(mock.gl, "drawArrays")).toEqual([]);
        expect(callsNamed(mock.gl, "deleteShader")).toHaveLength(2);
        expect(error).toHaveBeenCalledTimes(1);
      } finally {
        holder.destroy();
        error.mockRestore();
      }
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
      holder.tick(
        mesh,
        1 / 60,
        { start: 0, count: 0 },
        IDENTITY_EMITTER_TRANSFORM,
        NOTHING_INHERITED,
      );
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
      holder.tick(
        mesh,
        1 / 60,
        { start: 0, count: 4 },
        IDENTITY_EMITTER_TRANSFORM,
        NOTHING_INHERITED,
      );

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
      holder.tick(
        mesh,
        1 / 30,
        { start: 5, count: 2 },
        IDENTITY_EMITTER_TRANSFORM,
        NOTHING_INHERITED,
      );
      expect(uniforms.get(FX_TRANSFORM_FEEDBACK_RAND_SEED_UNIFORM)).toBe(1);
      expect(uniforms.get(FX_TRANSFORM_FEEDBACK_DELTA_TIME_UNIFORM)).toBe(1 / 30);
      expect(uniforms.get(FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_START_UNIFORM)).toBe(5);
      expect(uniforms.get(FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_COUNT_UNIFORM)).toBe(2);
      expect(uniforms.get(FX_TRANSFORM_FEEDBACK_CAPACITY_UNIFORM)).toBe(16);
      // No particle spawned yet this emitter's whole lifetime, so the base an id offsets from
      // this first tick's births is still zero.
      expect(uniforms.get(FX_TRANSFORM_FEEDBACK_SPAWN_ID_BASE_UNIFORM)).toBe(0);

      holder.tick(
        mesh,
        1 / 30,
        { start: 5, count: 2 },
        IDENTITY_EMITTER_TRANSFORM,
        NOTHING_INHERITED,
      );
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

      holder.tick(
        mesh,
        1 / 60,
        { start: 0, count: 0 },
        IDENTITY_EMITTER_TRANSFORM,
        NOTHING_INHERITED,
      );

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
        holder.tick(
          mesh,
          1 / 60,
          { start: 0, count: 0 },
          IDENTITY_EMITTER_TRANSFORM,
          NOTHING_INHERITED,
        );
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
      holder.spawn(mesh, { start: 3, count: 4 }, IDENTITY_EMITTER_TRANSFORM, NOTHING_INHERITED);

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
      holder.tick(
        mesh,
        1 / 60,
        { start: 7, count: 0 },
        IDENTITY_EMITTER_TRANSFORM,
        NOTHING_INHERITED,
      );
      expect(uniforms.get(FX_TRANSFORM_FEEDBACK_SPAWN_ID_BASE_UNIFORM)).toBe(4);
    } finally {
      mesh.destroy();
      holder.destroy();
    }
  });

  it("uploads each pass's inherited values as whole vec4s, zero-padded", () => {
    const mock = mockRenderer();
    const { calls } = mock.gl;
    const holder = new FXTransformFeedbackSimulationHolder(mock.renderer, minimalArtifact());
    const mesh = meshFor(mock, holder);
    const uploaded = (): number[][] =>
      callsNamed(mock.gl, "uniform4fv").map((call) => [...(call.args[1] as Float32Array)]);
    try {
      calls.length = 0;
      holder.spawn(
        mesh,
        { start: 0, count: 1 },
        IDENTITY_EMITTER_TRANSFORM,
        new Float32Array([1, 2, 3, 4, 5]),
      );
      expect(uploaded()).toEqual([[1, 2, 3, 4, 5, 0, 0, 0]]);

      calls.length = 0;
      holder.tick(
        mesh,
        1 / 60,
        { start: 1, count: 0 },
        IDENTITY_EMITTER_TRANSFORM,
        NOTHING_INHERITED,
      );
      // Nothing to inherit still uploads one whole vec4: the uniform is declared at least that long.
      expect(uploaded()).toEqual([[0, 0, 0, 0]]);
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

  describe("mesh surfaces", () => {
    const table: FXSurfaceTable = { data: new Float32Array(7 * 4), texels: 7 };
    const sampling = (): FXParticleKernelArtifact => ({
      ...minimalArtifact(),
      vertexSource: "#version 300 es\nuniform highp sampler2D u_s;\nvoid main(){}",
      meshSurfaces: { u_s: "rock" },
    });

    it("uploads a surface once and binds it to its texture unit every pass", () => {
      const mock = mockRenderer();
      const { calls } = mock.gl;
      const first = new FXTransformFeedbackSimulationHolder(mock.renderer, sampling(), {
        u_s: { kind: "surface", table },
      });
      const second = new FXTransformFeedbackSimulationHolder(mock.renderer, sampling(), {
        u_s: { kind: "surface", table },
      });
      const mesh = meshFor(mock, first);
      try {
        const storage = callsNamed(mock.gl, "texStorage2D");
        expect(storage).toHaveLength(1);
        expect(storage[0]?.args.slice(2, 5)).toEqual([mock.gl.context.RGBA32F, 7, 1]);
        expect(callsNamed(mock.gl, "texSubImage2D")[0]?.args.slice(2, 6)).toEqual([0, 0, 7, 1]);
        // Its raw calls are invisible to three, whose state is reset right after the upload.
        const names = calls.map((call) => call.name);
        expect(names.indexOf("resetState")).toBeGreaterThan(names.indexOf("texSubImage2D"));

        calls.length = 0;
        first.tick(
          mesh,
          1 / 60,
          { start: 0, count: 0 },
          IDENTITY_EMITTER_TRANSFORM,
          NOTHING_INHERITED,
        );
        expect(callsNamed(mock.gl, "state.activeTexture")[0]?.args).toEqual([
          mock.gl.context.TEXTURE0,
        ]);
        expect(callsNamed(mock.gl, "state.bindTexture")).toHaveLength(1);
        expect(mock.gl.uniforms.get("u_s")).toBe(0);

        first.destroy();
        expect(mock.gl.liveTextures.size).toBe(1);
        second.destroy();
        expect(mock.gl.liveTextures.size).toBe(0);
      } finally {
        mesh.destroy();
      }
    });

    it("refuses more surfaces than the vertex stage has texture units, claiming nothing", () => {
      const mock = mockRenderer({ maxVertexTextureUnits: 0 });
      expect(
        () =>
          new FXTransformFeedbackSimulationHolder(mock.renderer, sampling(), {
            u_s: { kind: "surface", table },
          }),
      ).toThrow(/texture units/);
      expect(callsNamed(mock.gl, "linkProgram")).toEqual([]);
      expect(mock.gl.liveTextures.size).toBe(0);
    });
  });
  describe("volumes", () => {
    const table: FXVolumeTable = {
      data: new Float32Array(3 + 4 * 3 * 2),
      bytes: new Uint8Array(4 * 3 * 2),
      width: 4,
      height: 3,
      depth: 2,
    };
    const sampling = (): FXParticleKernelArtifact => ({
      ...minimalArtifact(),
      vertexSource:
        "#version 300 es\nuniform highp sampler2D u_s;\nuniform highp sampler3D u_v;\nvoid main(){}",
      meshSurfaces: { u_s: "rock" },
      volumes: { u_v: "field" },
    });
    const surface: FXSurfaceTable = { data: new Float32Array(7 * 4), texels: 7 };

    it("uploads a volume as a filtered R8 3D texture and binds it beside a surface", () => {
      const mock = mockRenderer();
      const { context } = mock.gl;
      const holder = new FXTransformFeedbackSimulationHolder(mock.renderer, sampling(), {
        u_s: { kind: "surface", table: surface },
        u_v: { kind: "volume", table },
      });
      const mesh = meshFor(mock, holder);
      try {
        expect(callsNamed(mock.gl, "texStorage3D")[0]?.args).toEqual([
          context.TEXTURE_3D,
          1,
          context.R8,
          4,
          3,
          2,
        ]);
        expect(callsNamed(mock.gl, "texSubImage3D")[0]?.args.slice(5, 10)).toEqual([
          4,
          3,
          2,
          context.RED,
          context.UNSIGNED_BYTE,
        ]);
        const filters = callsNamed(mock.gl, "texParameteri").filter(
          (call) => call.args[0] === context.TEXTURE_3D && call.args[2] === context.LINEAR,
        );
        expect(filters).toHaveLength(2);

        mock.gl.calls.length = 0;
        holder.tick(
          mesh,
          1 / 60,
          { start: 0, count: 0 },
          IDENTITY_EMITTER_TRANSFORM,
          NOTHING_INHERITED,
        );
        expect(callsNamed(mock.gl, "state.bindTexture").map((call) => call.args[0])).toEqual([
          context.TEXTURE_2D,
          context.TEXTURE_3D,
        ]);
        expect(mock.gl.uniforms.get("u_s")).toBe(0);
        expect(mock.gl.uniforms.get("u_v")).toBe(1);
      } finally {
        mesh.destroy();
        holder.destroy();
      }
      expect(mock.gl.liveTextures.size).toBe(0);
    });

    it("refuses a volume past the GPU's 3D texture size, claiming nothing", () => {
      const mock = mockRenderer({ max3DTextureSize: 3 });
      expect(
        () =>
          new FXTransformFeedbackSimulationHolder(mock.renderer, sampling(), {
            u_s: { kind: "surface", table: surface },
            u_v: { kind: "volume", table },
          }),
      ).toThrow(/3D texture size/);
      expect(callsNamed(mock.gl, "linkProgram")).toEqual([]);
      expect(mock.gl.liveTextures.size).toBe(0);
    });
  });
  describe("scene depth", () => {
    const reading = (): FXParticleKernelArtifact => ({
      ...minimalArtifact(),
      vertexSource: `#version 300 es\nuniform highp sampler2D u_s;\nuniform highp sampler2D ${FX_TRANSFORM_FEEDBACK_SCENE_DEPTH_UNIFORM};\nvoid main(){}`,
      meshSurfaces: { u_s: "rock" },
      sceneDepth: true,
    });
    const surface: FXSurfaceTable = { data: new Float32Array(7 * 4), texels: 7 };

    /** A camera with a 64 x 32 depth three already holds a WebGL texture for. */
    function cameraWithDepth(mock: MockRenderer): {
      camera: PerspectiveCamera;
      target: WebGLRenderTarget;
      texture: object;
    } {
      const camera = new PerspectiveCamera();
      const target = new WebGLRenderTarget(64, 32, { depthTexture: new DepthTexture(64, 32) });
      const texture = {};
      mock.renderer.properties.get(target.depthTexture)["__webglTexture"] = texture;
      fxSetCameraDepth(camera, target.depthTexture);
      return { camera, target, texture };
    }

    function tick(
      holder: FXTransformFeedbackSimulationHolder,
      mesh: FXTransformFeedbackParticle,
    ): void {
      holder.tick(
        mesh,
        1 / 60,
        { start: 0, count: 0 },
        IDENTITY_EMITTER_TRANSFORM,
        NOTHING_INHERITED,
      );
    }

    it("binds the camera's depth on the unit after the samplers, with the captured view", () => {
      const mock = mockRenderer();
      const { context } = mock.gl;
      const { camera, texture } = cameraWithDepth(mock);
      camera.position.set(1, 2, 3);
      const view = new FXCameraView();
      view.capture(camera);
      const holder = new FXTransformFeedbackSimulationHolder(
        mock.renderer,
        reading(),
        { u_s: { kind: "surface", table: surface } },
        view,
      );
      const mesh = meshFor(mock, holder);
      try {
        mock.gl.calls.length = 0;
        tick(holder, mesh);
        expect(callsNamed(mock.gl, "state.bindTexture").map((call) => call.args)).toEqual([
          [context.TEXTURE_2D, expect.anything()],
          [context.TEXTURE_2D, texture],
        ]);
        expect(mock.gl.uniforms.get(FX_TRANSFORM_FEEDBACK_SCENE_DEPTH_UNIFORM)).toBe(1);
        expect(callsNamed(mock.gl, "uniform3f")[0]?.args.slice(1)).toEqual([1 / 64, 1 / 32, 1]);
        const matrices = callsNamed(mock.gl, "uniformMatrix4fv").map((call) => call.args[2]);
        expect(matrices).toContainEqual(view.viewProjection.elements);
        expect(matrices).toContainEqual(view.inverseViewProjection.elements);
      } finally {
        mesh.destroy();
        holder.destroy();
      }
    });

    it("reads no depth before a capture, without one given, and while drawing into its target", () => {
      const mock = mockRenderer();
      const { camera, target } = cameraWithDepth(mock);
      const view = new FXCameraView();
      const holder = new FXTransformFeedbackSimulationHolder(
        mock.renderer,
        reading(),
        {
          u_s: { kind: "surface", table: surface },
        },
        view,
      );
      const mesh = meshFor(mock, holder);
      const flags = (): number[] => {
        mock.gl.calls.length = 0;
        tick(holder, mesh);
        return callsNamed(mock.gl, "uniform3f").map((call) => call.args[3] as number);
      };
      try {
        expect(flags()).toEqual([0]);
        view.capture(camera);
        expect(flags()).toEqual([1]);
        mock.renderTarget = target;
        expect(flags()).toEqual([0]);
        mock.renderTarget = null;
        fxSetCameraDepth(camera, undefined);
        expect(flags()).toEqual([0]);
      } finally {
        mesh.destroy();
        holder.destroy();
      }
    });

    it("counts the depth among the vertex stage's texture units", () => {
      const mock = mockRenderer({ maxVertexTextureUnits: 1 });
      expect(
        () =>
          new FXTransformFeedbackSimulationHolder(
            mock.renderer,
            reading(),
            { u_s: { kind: "surface", table: surface } },
            new FXCameraView(),
          ),
      ).toThrow(/samples 2 textures/);
      expect(mock.gl.liveTextures.size).toBe(0);
    });

    it("refuses a kernel reading the scene depth without a view", () => {
      const mock = mockRenderer();
      expect(() => new FXTransformFeedbackSimulationHolder(mock.renderer, reading())).toThrow(
        /reads the scene depth/,
      );
      expect(callsNamed(mock.gl, "linkProgram")).toEqual([]);
    });
  });
});

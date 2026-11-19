import { describe, expect, it, vi } from "vitest";

import type { FXParticleKernelArtifact } from "../../src/artifact/FXArtifact";
import {
  acquireKernelProgram,
  fxPrepareKernel,
} from "../../src/emitter/FXKernelProgramCache.Internal";
import { callsNamed, mockRenderer, mockWebGL } from "../helpers/mockWebGL";

function kernel(body = ""): FXParticleKernelArtifact {
  return {
    vertexSource: `#version 300 es\nvoid main(){${body}}`,
    fragmentSource: "#version 300 es\nvoid main(){}",
    buffers: [{ name: "position", stride: 3 }],
    transformFeedbackVaryings: ["out_position"],
    bindings: {},
  };
}

describe("acquireKernelProgram", () => {
  it("links a kernel once per context and deletes it with its last user", () => {
    const gl = mockWebGL();
    const first = acquireKernelProgram(gl.context, kernel());
    const second = acquireKernelProgram(gl.context, kernel());
    expect(second.resource).toBe(first.resource);
    expect(callsNamed(gl, "linkProgram")).toHaveLength(1);

    first.release();
    first.release();
    expect(callsNamed(gl, "deleteProgram")).toEqual([]);
    second.release();
    expect(callsNamed(gl, "deleteProgram").map((call) => call.args[0])).toEqual([
      first.resource.program,
    ]);
  });

  it("links anew once the last user is gone", () => {
    const gl = mockWebGL();
    acquireKernelProgram(gl.context, kernel()).release();
    acquireKernelProgram(gl.context, kernel()).release();
    expect(callsNamed(gl, "linkProgram")).toHaveLength(2);
  });

  it("keeps kernels of other sources, and other contexts, apart", () => {
    const gl = mockWebGL();
    const other = mockWebGL();
    const program = acquireKernelProgram(gl.context, kernel()).resource;
    expect(acquireKernelProgram(gl.context, kernel("int a;")).resource).not.toBe(program);
    expect(acquireKernelProgram(other.context, kernel()).resource).not.toBe(program);
  });

  it("keeps a kernel that failed to link failed for every user, linking it once", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const gl = mockWebGL({ failLink: true });
    const first = acquireKernelProgram(gl.context, kernel());
    const second = acquireKernelProgram(gl.context, kernel());
    expect(first.resource.resolve()).toEqual({
      step: "program failed to link",
      log: "mock link failure",
    });
    expect(second.resource.resolve()).toBe(first.resource.resolve());
    expect(String(error.mock.calls[0]?.[0])).toBe(
      "FXKernelProgramCache: program failed to link: mock link failure",
    );
    expect(callsNamed(gl, "linkProgram")).toHaveLength(1);
    expect(error).toHaveBeenCalledTimes(1);
    first.release();
    second.release();
    error.mockRestore();
  });

  it("sends the program off without reading its outcome", () => {
    const gl = mockWebGL();
    const lease = acquireKernelProgram(gl.context, kernel());
    expect(callsNamed(gl, "getShaderParameter")).toEqual([]);
    expect(callsNamed(gl, "getProgramParameter")).toEqual([]);
    lease.release();
  });

  it("links anew after a context loss, and a stale release deletes nothing", () => {
    const gl = mockWebGL();
    const stale = acquireKernelProgram(gl.context, kernel());
    gl.context.canvas.dispatchEvent(new Event("webglcontextlost"));
    const fresh = acquireKernelProgram(gl.context, kernel());
    expect(fresh.resource).not.toBe(stale.resource);

    stale.release();
    expect(callsNamed(gl, "deleteProgram")).toEqual([]);
    expect(acquireKernelProgram(gl.context, kernel()).resource).toBe(fresh.resource);
  });
});

describe("fxPrepareKernel", () => {
  it("builds the program a later claim of the same kernel shares, building until the build ends", () => {
    const mock = mockRenderer({ parallelShaderCompile: true });
    const preparation = fxPrepareKernel(mock.renderer, kernel());
    expect(preparation.building).toBe(true);
    mock.gl.finishBuilds();
    expect(preparation.building).toBe(false);
    const claim = acquireKernelProgram(mock.gl.context, kernel());
    preparation.release();
    preparation.release();
    expect(callsNamed(mock.gl, "linkProgram")).toHaveLength(1);
    expect(callsNamed(mock.gl, "deleteProgram")).toEqual([]);
    claim.release();
  });

  it("is never building where the build cannot be told apart from waiting for it", () => {
    const mock = mockRenderer();
    const preparation = fxPrepareKernel(mock.renderer, kernel());
    expect(preparation.building).toBe(false);
    preparation.release();
  });
});

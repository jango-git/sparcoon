import { describe, expect, it } from "vitest";

import type { FXParticleKernelArtifact } from "../../src/artifact/FXArtifact";
import { acquireKernelProgram } from "../../src/emitter/FXKernelProgramCache.Internal";
import { callsNamed, mockWebGL } from "../helpers/mockWebGL";

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
    expect(second.program).toBe(first.program);
    expect(callsNamed(gl, "linkProgram")).toHaveLength(1);

    first.release();
    first.release();
    expect(callsNamed(gl, "deleteProgram")).toEqual([]);
    second.release();
    expect(callsNamed(gl, "deleteProgram").map((call) => call.args[0])).toEqual([first.program]);
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
    const program = acquireKernelProgram(gl.context, kernel()).program;
    expect(acquireKernelProgram(gl.context, kernel("int a;")).program).not.toBe(program);
    expect(acquireKernelProgram(other.context, kernel()).program).not.toBe(program);
  });

  it("caches nothing for a kernel that failed to link", () => {
    const gl = mockWebGL({ failLink: true });
    expect(() => acquireKernelProgram(gl.context, kernel())).toThrow(/failed to link/);
    expect(() => acquireKernelProgram(gl.context, kernel())).toThrow(/failed to link/);
    expect(callsNamed(gl, "linkProgram")).toHaveLength(2);
  });

  it("links anew after a context loss, and a stale release deletes nothing", () => {
    const gl = mockWebGL();
    const stale = acquireKernelProgram(gl.context, kernel());
    gl.context.canvas.dispatchEvent(new Event("webglcontextlost"));
    const fresh = acquireKernelProgram(gl.context, kernel());
    expect(fresh.program).not.toBe(stale.program);

    stale.release();
    expect(callsNamed(gl, "deleteProgram")).toEqual([]);
    expect(acquireKernelProgram(gl.context, kernel()).program).toBe(fresh.program);
  });
});

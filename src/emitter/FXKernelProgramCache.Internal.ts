import type { FXParticleKernelArtifact } from "../artifact/FXArtifact.js";
import { type FXContextLease, FXContextLeases } from "./FXContextLeases.Internal.js";
import { linkProgram } from "./FXProgramLink.Internal.js";

const ERROR_PREFIX = "FXKernelProgramCache";

// Every holder of the same kernel on the same context shares one linked program.
const programs = new FXContextLeases<string, WebGLProgram>((gl, program) => {
  gl.deleteProgram(program);
});

// The exact sources, not a hash of them: a collision would hand a holder another kernel.
function kernelKey(artifact: FXParticleKernelArtifact): string {
  return [
    artifact.vertexSource,
    artifact.fragmentSource,
    artifact.transformFeedbackVaryings.join(","),
  ].join("\0");
}

/**
 * @internal A claim on the linked program for `artifact` on `gl`, linked on first use.
 * @throws When the kernel fails to compile or link.
 */
export function acquireKernelProgram(
  gl: WebGL2RenderingContext,
  artifact: FXParticleKernelArtifact,
): FXContextLease<WebGLProgram> {
  return programs.acquire(gl, kernelKey(artifact), () => linkKernelProgram(gl, artifact));
}

function linkKernelProgram(
  gl: WebGL2RenderingContext,
  artifact: FXParticleKernelArtifact,
): WebGLProgram {
  // The varyings come in buffer order, so the interleaved capture writes exactly the slot layout.
  return linkProgram(
    gl,
    artifact.vertexSource,
    artifact.fragmentSource,
    artifact.transformFeedbackVaryings,
    ERROR_PREFIX,
  );
}

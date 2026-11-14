import type { FXParticleKernelArtifact } from "../artifact/FXArtifact.js";
import { type FXContextLease, FXContextLeases } from "./FXContextLeases.Internal.js";

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
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, artifact.vertexSource);
  let fragmentShader: WebGLShader;
  try {
    fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, artifact.fragmentSource);
  } catch (error) {
    // compileShader deletes only the shader it failed on.
    gl.deleteShader(vertexShader);
    throw error;
  }
  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  // Must be called before linking (WebGL2 spec). The varyings come in buffer order, so the
  // interleaved capture writes exactly the slot layout.
  gl.transformFeedbackVaryings(
    program,
    [...artifact.transformFeedbackVaryings],
    gl.INTERLEAVED_ATTRIBS,
  );
  gl.linkProgram(program);
  // Shaders are safe to delete once linked - GL keeps them alive by refcount until the program
  // itself is deleted, regardless of link success.
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`${ERROR_PREFIX}: program failed to link: ${info ?? ""}`);
  }
  return program;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (shader === null) {
    throw new Error(`${ERROR_PREFIX}: gl.createShader() failed`);
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`${ERROR_PREFIX}: shader failed to compile: ${info ?? ""}`);
  }
  return shader;
}

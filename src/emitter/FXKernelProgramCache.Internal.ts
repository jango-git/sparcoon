import type { FXParticleKernelArtifact } from "../artifact/FXArtifact.js";

/**
 * @internal One holder's claim on a linked transform-feedback kernel program. Every holder of the
 * same kernel on the same context shares one program; it is deleted when the last claim is
 * released.
 */
export interface FXKernelProgramLease {
  readonly program: WebGLProgram;
  /** Gives the claim up; a second call is a no-op. */
  release(): void;
}

interface FXKernelProgramEntry {
  readonly program: WebGLProgram;
  users: number;
}

const ERROR_PREFIX = "FXKernelProgramCache";

// Programs belong to one context. A lost context takes them with it, so its entries are dropped:
// a context restored under the same object must link anew.
const entriesByContext = new WeakMap<WebGL2RenderingContext, Map<string, FXKernelProgramEntry>>();

function entriesOf(gl: WebGL2RenderingContext): Map<string, FXKernelProgramEntry> {
  const known = entriesByContext.get(gl);
  if (known !== undefined) {
    return known;
  }
  const entries = new Map<string, FXKernelProgramEntry>();
  entriesByContext.set(gl, entries);
  gl.canvas.addEventListener("webglcontextlost", () => {
    entries.clear();
  });
  return entries;
}

// The exact sources, not a hash of them: a collision would hand a holder another kernel.
function kernelKey(artifact: FXParticleKernelArtifact): string {
  return [
    artifact.vertexSource,
    artifact.fragmentSource,
    artifact.transformFeedbackVaryings.join(","),
  ].join("\0");
}

/**
 * @internal The linked program for `artifact` on `gl`, linked on first use.
 * @throws When the kernel fails to compile or link.
 */
export function acquireKernelProgram(
  gl: WebGL2RenderingContext,
  artifact: FXParticleKernelArtifact,
): FXKernelProgramLease {
  const entries = entriesOf(gl);
  const key = kernelKey(artifact);
  let entry = entries.get(key);
  if (entry === undefined) {
    entry = { program: linkKernelProgram(gl, artifact), users: 0 };
    entries.set(key, entry);
  }

  const linked = entry;
  linked.users += 1;
  let released = false;
  return {
    program: linked.program,
    release: (): void => {
      if (released) {
        return;
      }
      released = true;
      linked.users -= 1;
      // Past a context loss the entry is no longer in the map, and its program is already gone.
      if (linked.users === 0 && entries.get(key) === linked) {
        entries.delete(key);
        gl.deleteProgram(linked.program);
      }
    },
  };
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

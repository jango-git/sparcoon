import type { WebGLRenderer } from "three";

/**
 * A stand-in WebGL2 context for the transform-feedback paths, which headless vitest has no real
 * context for. It records the JS side - which calls are made, in what order, with what arguments -
 * and cannot prove the GL calls behave correctly against a real driver.
 */

/** One recorded GL (or renderer) call. */
export interface MockGLCall {
  readonly name: string;
  readonly args: readonly unknown[];
}

export interface MockGLOptions {
  /** The program fails to link. */
  readonly failLink?: boolean;
  /** Every shader fails to compile (`true`), or only the fragment shader. */
  readonly failCompile?: boolean | "fragment";
  /** MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS; the WebGL2 minimum, 64, by default. */
  readonly maxFeedbackComponents?: number;
  /** MAX_VERTEX_ATTRIBS; the WebGL2 minimum, 16, by default. */
  readonly maxVertexAttribs?: number;
}

export interface MockGL {
  /** The context to hand to code under test. */
  readonly context: WebGL2RenderingContext;
  /** Every call on the context and on the renderer built around it, in order. */
  readonly calls: MockGLCall[];
  /** The last value each named uniform was set to (`uniform1i`/`uniform1f`). */
  readonly uniforms: Map<string, number>;
  /** Buffers created and not deleted yet. */
  readonly liveBuffers: Set<unknown>;
}

/** The renderer surface the transform-feedback code reads, around a {@link MockGL}. */
export interface MockRenderer {
  readonly renderer: WebGLRenderer;
  readonly gl: MockGL;
}

// The real WebGL2 enum values, so a recorded argument reads like the real call.
const CONSTANTS = {
  POINTS: 0x0000,
  FLOAT: 0x1406,
  ARRAY_BUFFER: 0x8892,
  DYNAMIC_DRAW: 0x88e8,
  MAX_VERTEX_ATTRIBS: 0x8869,
  FRAGMENT_SHADER: 0x8b30,
  VERTEX_SHADER: 0x8b31,
  COMPILE_STATUS: 0x8b81,
  LINK_STATUS: 0x8b82,
  INTERLEAVED_ATTRIBS: 0x8c8c,
  MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS: 0x8c8a,
  RASTERIZER_DISCARD: 0x8c89,
  TRANSFORM_FEEDBACK_BUFFER: 0x8c8e,
  COPY_READ_BUFFER: 0x8f36,
  COPY_WRITE_BUFFER: 0x8f37,
  ACTIVE_UNIFORMS: 0x8b86,
  FLOAT_VEC2: 0x8b50,
  FLOAT_VEC3: 0x8b51,
  FLOAT_VEC4: 0x8b52,
  INT: 0x1404,
  FLOAT_MAT2: 0x8b5a,
  FLOAT_MAT3: 0x8b5b,
  FLOAT_MAT4: 0x8b5c,
} as const;

// A declared uniform's type, as `getActiveUniform` reports it.
const UNIFORM_TYPES: Readonly<Record<string, number>> = {
  float: CONSTANTS.FLOAT,
  vec2: CONSTANTS.FLOAT_VEC2,
  vec3: CONSTANTS.FLOAT_VEC3,
  vec4: CONSTANTS.FLOAT_VEC4,
  int: CONSTANTS.INT,
  mat2: CONSTANTS.FLOAT_MAT2,
  mat3: CONSTANTS.FLOAT_MAT3,
  mat4: CONSTANTS.FLOAT_MAT4,
};

// Calls with nothing to answer: recorded, and return nothing.
const RECORDED_ONLY = [
  "compileShader",
  "deleteShader",
  "attachShader",
  "transformFeedbackVaryings",
  "linkProgram",
  "deleteProgram",
  "deleteVertexArray",
  "bindVertexArray",
  "bindBuffer",
  "bufferData",
  "vertexAttribPointer",
  "enableVertexAttribArray",
  "bindBufferBase",
  "bindBufferRange",
  "copyBufferSubData",
  "uniformMatrix2fv",
  "uniformMatrix3fv",
  "uniformMatrix4fv",
  "uniform2fv",
  "uniform3fv",
  "uniform4fv",
  "enable",
  "disable",
  "beginTransformFeedback",
  "endTransformFeedback",
  "drawArrays",
] as const;

export function mockWebGL(options: MockGLOptions = {}): MockGL {
  const calls: MockGLCall[] = [];
  const uniforms = new Map<string, number>();
  const liveBuffers = new Set<unknown>();
  const uniformNames = new Map<unknown, string>();
  const shaderTypes = new Map<unknown, number>();
  // Every uniform any shader source declares: the program's active uniforms (none compiled away).
  const declaredUniforms: { readonly name: string; readonly type: number }[] = [];
  let nextId = 1;

  const record = (name: string, args: readonly unknown[]): void => {
    calls.push({ name, args });
  };
  const handle = (): { id: number } => ({ id: nextId++ });
  const setUniform = (location: unknown, value: number): void => {
    const name = uniformNames.get(location);
    if (name !== undefined) {
      uniforms.set(name, value);
    }
  };

  const context: Record<string, unknown> = {
    ...CONSTANTS,
    // Dispatch "webglcontextlost" on it to simulate a loss.
    canvas: new EventTarget(),
    getParameter: (name: number) => {
      if (name === CONSTANTS.MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS) {
        return options.maxFeedbackComponents ?? 64;
      }
      return name === CONSTANTS.MAX_VERTEX_ATTRIBS ? (options.maxVertexAttribs ?? 16) : undefined;
    },
    createBuffer: () => {
      const buffer = handle();
      liveBuffers.add(buffer);
      return buffer;
    },
    deleteBuffer: (...args: unknown[]) => {
      record("deleteBuffer", args);
      liveBuffers.delete(args[0]);
    },
    createShader: (type: number) => {
      const shader = handle();
      shaderTypes.set(shader, type);
      return shader;
    },
    createProgram: handle,
    createVertexArray: handle,
    getShaderParameter: (shader: unknown) =>
      !(
        options.failCompile === true ||
        (options.failCompile === "fragment" &&
          shaderTypes.get(shader) === CONSTANTS.FRAGMENT_SHADER)
      ),
    getShaderInfoLog: () => "mock compile failure",
    shaderSource: (...args: unknown[]) => {
      record("shaderSource", args);
      for (const match of String(args[1]).matchAll(
        /^\s*uniform\s+(?:\w+p\s+)?(\w+)\s+([\w$]+);/gm,
      )) {
        const type = UNIFORM_TYPES[match[1]];
        if (type !== undefined && !declaredUniforms.some((uniform) => uniform.name === match[2])) {
          declaredUniforms.push({ name: match[2], type });
        }
      }
    },
    getProgramParameter: (_program: unknown, name: number) =>
      name === CONSTANTS.ACTIVE_UNIFORMS ? declaredUniforms.length : !(options.failLink ?? false),
    getActiveUniform: (_program: unknown, index: number) => {
      const uniform = declaredUniforms[index];
      return uniform === undefined ? null : { name: uniform.name, type: uniform.type, size: 1 };
    },
    getProgramInfoLog: () => "mock link failure",
    getUniformLocation: (_program: unknown, name: string) => {
      const location = handle();
      uniformNames.set(location, name);
      return location;
    },
    uniform1i: (...args: unknown[]) => {
      record("uniform1i", args);
      setUniform(args[0], args[1] as number);
    },
    uniform1f: (...args: unknown[]) => {
      record("uniform1f", args);
      setUniform(args[0], args[1] as number);
    },
  };
  for (const name of RECORDED_ONLY) {
    context[name] = (...args: unknown[]): void => {
      record(name, args);
    };
  }

  return { context: context as unknown as WebGL2RenderingContext, calls, uniforms, liveBuffers };
}

/**
 * A WebGL2 renderer around a fresh {@link mockWebGL} context, reporting no device limits. Its own
 * calls are recorded as `state.useProgram` and `resetState`.
 */
export function mockRenderer(options: MockGLOptions = {}): MockRenderer {
  const gl = mockWebGL(options);
  const renderer = {
    capabilities: { isWebGL2: true },
    getContext: () => gl.context,
    state: {
      useProgram: (program: unknown) => {
        gl.calls.push({ name: "state.useProgram", args: [program] });
      },
    },
    resetState: () => {
      gl.calls.push({ name: "resetState", args: [] });
    },
  };
  return { renderer: renderer as unknown as WebGLRenderer, gl };
}

/** The recorded calls named `name`, in order. */
export function callsNamed(gl: MockGL, name: string): MockGLCall[] {
  return gl.calls.filter((call) => call.name === name);
}

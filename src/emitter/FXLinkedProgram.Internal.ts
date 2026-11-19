/** `KHR_parallel_shader_compile`'s query: whether compiling and linking a program has finished. */
const COMPLETION_STATUS_KHR = 0x91b1;

/** How often {@link whenProgramsSettle} polls, as three's `compileAsync` does. */
const POLL_INTERVAL_MS = 10;

/** Why a program cannot be used: the step that failed and what the driver logged. */
interface FXBuildFailure {
  readonly step: "shader failed to compile" | "program failed to link";
  readonly log: string;
}

/**
 * @internal A raw WebGL2 program sent off to compile and link, whose outcome is read only when it
 * is asked for. Reading a status, an info log or a uniform location of a program still building
 * stops the main thread until the build ends, so nothing reads one before the program is used.
 *
 * With `KHR_parallel_shader_compile`, {@link settled} and {@link building} ask whether the build
 * has ended without waiting for it. Without it there is no such question, and only
 * {@link resolve} learns the outcome.
 */
export class FXLinkedProgram {
  public readonly program: WebGLProgram;

  private readonly parallelCompile: object | null;
  /** Kept until the outcome is read: the compile logs come from them. */
  private shaders: readonly WebGLShader[];
  /** `undefined` until the outcome is read; then the failure, or `null` for a usable program. */
  private outcome: FXBuildFailure | null | undefined;

  /**
   * Sends the program off: `feedbackVaryings` are captured interleaved, in that order, when there
   * are any. `errorPrefix` names who asks in the failure.
   * @throws When the context cannot create a shader (it is lost).
   */
  constructor(
    private readonly gl: WebGL2RenderingContext,
    vertexSource: string,
    fragmentSource: string,
    feedbackVaryings: readonly string[],
    private readonly errorPrefix: string,
  ) {
    /* Enabling it again is harmless: the renderer or the game may have enabled it already. */
    this.parallelCompile = gl.getExtension("KHR_parallel_shader_compile");
    const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource, errorPrefix);
    let fragmentShader: WebGLShader;
    try {
      fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource, errorPrefix);
    } catch (error) {
      gl.deleteShader(vertexShader);
      throw error;
    }
    this.shaders = [vertexShader, fragmentShader];
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    if (feedbackVaryings.length > 0) {
      /* Must be called before linking (WebGL2 spec). */
      gl.transformFeedbackVaryings(program, [...feedbackVaryings], gl.INTERLEAVED_ATTRIBS);
    }
    gl.linkProgram(program);
    this.program = program;
  }

  /** Whether the outcome can be read without waiting: read already, or the build has ended. */
  public get settled(): boolean {
    if (this.outcome !== undefined || this.gl.isContextLost()) {
      return true;
    }
    return (
      this.parallelCompile !== null &&
      this.gl.getProgramParameter(this.program, COMPLETION_STATUS_KHR) === true
    );
  }

  /**
   * Whether the build has not ended on a context that can tell when it does: waiting for it then
   * saves a stall. `false` on a context without `KHR_parallel_shader_compile`, where nothing can.
   */
  public get building(): boolean {
    return this.parallelCompile !== null && !this.settled;
  }

  /**
   * What the driver logged for a program it rejected; `undefined` while the program can be used
   * or its build has not ended.
   */
  public get failure(): string | undefined {
    return this.settled ? this.resolve()?.log : undefined;
  }

  /**
   * Reads the outcome, waiting for the build when it has not ended: `null` for a usable program,
   * otherwise why it is not. A failure is logged once, however many users the program has.
   */
  public resolve(): FXBuildFailure | null {
    if (this.outcome !== undefined) {
      return this.outcome;
    }
    this.outcome = this.gl.isContextLost() ? null : this.readOutcome();
    this.deleteShaders();
    if (this.outcome !== null) {
      console.error(`${this.errorPrefix}: ${this.outcome.step}: ${this.outcome.log}`);
    }
    return this.outcome;
  }

  /** Deletes the program. A wait on it ends: there is nothing left to build. */
  public delete(): void {
    this.outcome ??= null;
    this.deleteShaders();
    this.gl.deleteProgram(this.program);
  }

  private readOutcome(): FXBuildFailure | null {
    const gl = this.gl;
    /* A shader that failed to compile explains the failed link better than the link log does. */
    for (const shader of this.shaders) {
      if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
        return { step: "shader failed to compile", log: gl.getShaderInfoLog(shader) ?? "" };
      }
    }
    if (gl.getProgramParameter(this.program, gl.LINK_STATUS) !== true) {
      return { step: "program failed to link", log: gl.getProgramInfoLog(this.program) ?? "" };
    }
    return null;
  }

  /** Safe once linked: GL keeps an attached shader alive until its program is deleted. */
  private deleteShaders(): void {
    for (const shader of this.shaders) {
      this.gl.deleteShader(shader);
    }
    this.shaders = [];
  }
}

/**
 * @internal What one user of a shared {@link FXLinkedProgram} reads off it once it is built, such as
 * its uniform locations: read on the first {@link get}, which waits for the build if it has not
 * ended.
 */
export class FXProgramBinding<T> {
  /** `undefined` before the first {@link get}; `null` when the program failed to build. */
  private value: T | null | undefined;

  constructor(
    public readonly linked: FXLinkedProgram,
    private readonly read: (program: WebGLProgram) => T,
  ) {}

  /** What the built program gives; `null` when it failed to build. */
  public get(): T | null {
    if (this.value === undefined) {
      this.value = this.linked.resolve() === null ? this.read(this.linked.program) : null;
    }
    return this.value;
  }
}

/**
 * @internal Resolves once every one of `programs` can be used or has failed. They are polled from
 * timers, never in the call, so the wait goes on while nothing renders. A program on a context
 * without `KHR_parallel_shader_compile` cannot be polled: it is waited for, one per timer
 * callback, so each wait is a pause of its own instead of one long pause.
 */
export function whenProgramsSettle(programs: readonly FXLinkedProgram[]): Promise<void> {
  const pending = new Set(programs);
  if (pending.size === 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const check = (): void => {
      let waited = false;
      for (const program of pending) {
        if (program.settled) {
          pending.delete(program);
        } else if (!program.building && !waited) {
          program.resolve();
          pending.delete(program);
          waited = true;
        }
      }
      if (pending.size === 0) {
        resolve();
        return;
      }
      setTimeout(check, waited ? 0 : POLL_INTERVAL_MS);
    };
    setTimeout(check, 0);
  });
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
  errorPrefix: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (shader === null) {
    throw new Error(`${errorPrefix}: gl.createShader() failed`);
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
}

import type { WebGLRenderer } from "three";
import type { FXEmitterTransform, FXParticleKernelArtifact } from "../artifact/FXArtifact.js";
import { meshPropertyKeyFor } from "../coreLayout.js";
import {
  FX_TRANSFORM_FEEDBACK_CAPACITY_UNIFORM,
  FX_TRANSFORM_FEEDBACK_DELTA_TIME_UNIFORM,
  FX_TRANSFORM_FEEDBACK_MODEL_MATRIX_UNIFORM,
  FX_TRANSFORM_FEEDBACK_OBJECT_ANGULAR_VELOCITY_UNIFORM,
  FX_TRANSFORM_FEEDBACK_OBJECT_VELOCITY_UNIFORM,
  FX_TRANSFORM_FEEDBACK_RAND_SEED_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SPAWN_ID_BASE_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_COUNT_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_START_UNIFORM,
} from "../behaviorTransformFeedbackLayout.js";
import type { FXTransformFeedbackParticle } from "../instancedParticle/FXTransformFeedbackParticle.js";

/**
 * @internal The GPU sibling of `FXSimulationHolder`: holds a precompiled {@link FXParticleKernelArtifact}
 * (one fused GLSL program covering both spawn and update) and drives it via raw WebGL2 transform
 * feedback each tick. Bypasses three.js's `Material`/
 * `WebGLProgram` machinery entirely - three has no transform-feedback support at all - the same
 * way the render side never touches it either.
 */
export class FXTransformFeedbackSimulationHolder {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly bufferNames: readonly string[];
  private readonly strides: readonly number[];
  private readonly uniformLocations: Record<string, WebGLUniformLocation | null> = {};

  // A fresh, monotonic seed every tick - decorrelates `rand()` draws across ticks (and, crucially,
  // across a buffer slot's successive rebirths under the cursor/overwrite scheme - see the `rand`
  // registry entry's own doc comment in the editor's core/ir/FXFunctions.Internal.ts for why this
  // matters). Wraparound is harmless: it only ever feeds a hash's bit-mixing, never arithmetic
  // that needs exact precision.
  private randSeedCounter = 0;

  // Running total of particles ever spawned by this emitter - the base a newborn's id offsets
  // from this tick's relative spawn index. Never reset (no reset() exists on this class, only
  // destroy()): a stop/replay must not reissue ids already handed out, same reasoning as
  // randSeedCounter above.
  private spawnIdBase = 0;

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly artifact: FXParticleKernelArtifact,
  ) {
    // Every emitter driven by this class already required the live render tier to be "standard"
    // (a real WebGL2 context) before this class is ever constructed (FXEmitter.fromArtifacts's
    // driver-selection rule) - the cast reflects an already-established precondition, not a new
    // capability check.
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    this.gl = gl;
    // `artifact.buffers[].name` is the raw, unprefixed kernel-compiled name (e.g. "velocity") -
    // `mesh.readBuffer`/`writeBuffer`/`swapBuffers` key by the mesh's own property-buffer key
    // instead (`fx_velocity`, matching `FXGPUEmitterDriver`'s own `varyings`), so every name must go
    // through the same mapping the JS-driven path also uses (`meshPropertyKeyFor`) before reaching
    // the mesh - the two core buffers pass through unchanged either way, which is why this only
    // actually mattered for attribute-buffer emitters, not the position/lifetime-only fixtures this
    // class's own tests use.
    this.bufferNames = artifact.buffers.map((buffer) => meshPropertyKeyFor(buffer.name));
    this.strides = artifact.buffers.map((buffer) => buffer.stride);

    const vertexShader = compileShader(gl, gl.VERTEX_SHADER, artifact.vertexSource);
    const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, artifact.fragmentSource);
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    // Must be called before linking (WebGL2 spec) - SEPARATE_ATTRIBS matches this class's one
    // dedicated WebGLBuffer per state buffer (never one interleaved buffer for all of them).
    gl.transformFeedbackVaryings(
      program,
      [...artifact.transformFeedbackVaryings],
      gl.SEPARATE_ATTRIBS,
    );
    gl.linkProgram(program);
    // Shaders are safe to delete once linked - GL keeps them alive by refcount until the program
    // itself is deleted, regardless of link success.
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
      const info = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`FXTransformFeedbackSimulationHolder: program failed to link: ${info ?? ""}`);
    }
    this.program = program;

    for (const name of FIXED_UNIFORM_NAMES) {
      this.uniformLocations[name] = gl.getUniformLocation(program, name);
    }
    for (const name of Object.keys(artifact.bindings)) {
      this.uniformLocations[name] = gl.getUniformLocation(program, name);
    }

    // A dedicated VAO for this simulation pass only - never one three.js's own WebGLBindingStates
    // manages, so raw attribute setup here can never corrupt a mesh's cached vertex state. This
    // is exactly the raw gl.bindVertexArray() call whose effect on three's VAO cache `tick()`'s
    // closing `resetState()` call exists to correct (see that call site's own doc comment).
    this.vao = gl.createVertexArray();
  }

  /**
   * Runs one transform-feedback pass: reads `mesh`'s current buffers, writes the fused spawn+
   * update program's result into the other half of each ping-pong pair, then swaps. `spawnRange`
   * is this tick's birth range under the buffer's cursor/overwrite scheme - `count === 0` is a
   * valid, ordinary "no births this tick" case, not skipped specially.
   */
  public tick(
    mesh: FXTransformFeedbackParticle,
    deltaTime: number,
    spawnRange: { readonly start: number; readonly count: number },
    emitter: FXEmitterTransform,
  ): void {
    const gl = this.gl;
    this.randSeedCounter += 1;

    // Routed through the renderer's own cache-aware setter (not raw gl.useProgram()) so three's
    // `WebGLState.currentProgram` cache stays truthful - its own next draw then correctly detects
    // the mismatch and re-binds, with no reset needed for this half of the state-hygiene problem.
    // The other half (the VAO-identity cache) has no such setter - see the raw
    // gl.bindVertexArray() call below and resetState() at the end of this method.
    this.renderer.state.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    this.bufferNames.forEach((name, index) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.readBuffer(name));
      gl.vertexAttribPointer(index, this.strides[index], gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(index);
    });
    this.bufferNames.forEach((name, index) => {
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, index, mesh.writeBuffer(name));
    });

    this.setUniforms(deltaTime, spawnRange, emitter, mesh.capacity);

    gl.enable(gl.RASTERIZER_DISCARD);
    gl.beginTransformFeedback(gl.POINTS);
    gl.drawArrays(gl.POINTS, 0, mesh.capacity);
    gl.endTransformFeedback();
    gl.disable(gl.RASTERIZER_DISCARD);

    // A bound TRANSFORM_FEEDBACK_BUFFER base is otherwise still "active" for this binding point;
    // release it rather than leave a stale reference around between ticks.
    for (let index = 0; index < this.bufferNames.length; index += 1) {
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, index, null);
    }

    for (const name of this.bufferNames) {
      mesh.swapBuffers(name);
    }

    // Consumed - advance past every id this tick's spawn range just claimed.
    this.spawnIdBase += spawnRange.count;

    // Our raw gl.bindVertexArray() call above is invisible to three's own VAO-identity cache
    // (WebGLBindingStates has no scoped, public way to invalidate just this mesh's entry) -
    // resetState() is the only public lever, so it runs every tick. Per-emitter for now, not
    // batched across every GPU-driven emitter into one call per frame - a real, deferred
    // optimization, not required for correctness.
    this.renderer.resetState();
  }

  public destroy(): void {
    this.gl.deleteProgram(this.program);
    this.gl.deleteVertexArray(this.vao);
  }

  /** GPU-tier mirror of `FXSimulationHolder.applyBindingValues`: mutate each named uniform's live
   *  value in place; unknown name = no-op. `FXEmitter.applyValues` calls both mirrors, since
   *  either backend may be the active one. */
  public applyBindingValues(values: Readonly<Record<string, number | Float32Array>>): void {
    for (const name in values) {
      if (name in this.artifact.bindings) {
        this.artifact.bindings[name].value = values[name];
      }
    }
  }

  private setUniforms(
    deltaTime: number,
    spawnRange: { readonly start: number; readonly count: number },
    emitter: FXEmitterTransform,
    capacity: number,
  ): void {
    const gl = this.gl;
    gl.uniform1i(
      this.uniformLocations[FX_TRANSFORM_FEEDBACK_RAND_SEED_UNIFORM],
      this.randSeedCounter,
    );
    gl.uniform1i(
      this.uniformLocations[FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_START_UNIFORM],
      spawnRange.start,
    );
    gl.uniform1i(
      this.uniformLocations[FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_COUNT_UNIFORM],
      spawnRange.count,
    );
    gl.uniform1i(
      this.uniformLocations[FX_TRANSFORM_FEEDBACK_SPAWN_ID_BASE_UNIFORM],
      this.spawnIdBase,
    );
    gl.uniform1i(this.uniformLocations[FX_TRANSFORM_FEEDBACK_CAPACITY_UNIFORM], capacity);
    gl.uniform1f(this.uniformLocations[FX_TRANSFORM_FEEDBACK_DELTA_TIME_UNIFORM], deltaTime);
    gl.uniformMatrix4fv(this.uniformLocations[FX_TRANSFORM_FEEDBACK_MODEL_MATRIX_UNIFORM], false, [
      ...emitter.worldMatrix,
    ]);
    gl.uniform3fv(this.uniformLocations[FX_TRANSFORM_FEEDBACK_OBJECT_VELOCITY_UNIFORM], [
      ...emitter.velocity,
    ]);
    gl.uniform3fv(this.uniformLocations[FX_TRANSFORM_FEEDBACK_OBJECT_ANGULAR_VELOCITY_UNIFORM], [
      ...emitter.angularVelocity,
    ]);
    for (const [name, slot] of Object.entries(this.artifact.bindings)) {
      // Float32Array-valued (sampler2D/LUT) bindings are reserved for a future node - see
      // FXParticleKernelArtifact.bindings's own doc comment - never produced by any node today.
      gl.uniform1f(this.uniformLocations[name], slot.value as number);
    }
  }
}

const FIXED_UNIFORM_NAMES: readonly string[] = [
  FX_TRANSFORM_FEEDBACK_RAND_SEED_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_START_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_COUNT_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SPAWN_ID_BASE_UNIFORM,
  FX_TRANSFORM_FEEDBACK_CAPACITY_UNIFORM,
  FX_TRANSFORM_FEEDBACK_DELTA_TIME_UNIFORM,
  FX_TRANSFORM_FEEDBACK_MODEL_MATRIX_UNIFORM,
  FX_TRANSFORM_FEEDBACK_OBJECT_VELOCITY_UNIFORM,
  FX_TRANSFORM_FEEDBACK_OBJECT_ANGULAR_VELOCITY_UNIFORM,
];

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (shader === null) {
    throw new Error("FXTransformFeedbackSimulationHolder: gl.createShader() failed");
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`FXTransformFeedbackSimulationHolder: shader failed to compile: ${info ?? ""}`);
  }
  return shader;
}

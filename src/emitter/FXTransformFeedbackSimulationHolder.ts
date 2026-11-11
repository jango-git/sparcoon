import type { WebGLRenderer } from "three";
import type { FXEmitterTransform, FXParticleKernelArtifact } from "../artifact/FXArtifact.js";
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
import {
  kernelSlotLayout,
  type FXSlotLayout,
  type FXTransformFeedbackParticle,
} from "../instancedParticle/FXTransformFeedbackParticle.js";
import {
  acquireKernelProgram,
  type FXKernelProgramLease,
} from "./FXKernelProgramCache.Internal.js";

/** WebGL's cap on a vertex attribute stride, in bytes - one particle's slot is that stride. */
const MAX_VERTEX_STRIDE_BYTES = 255;

/**
 * @internal The GPU sibling of `FXSimulationHolder`: holds a precompiled {@link FXParticleKernelArtifact}
 * (one fused GLSL program covering both spawn and update) and drives it via raw WebGL2 transform
 * feedback each tick. Bypasses three.js's `Material`/`WebGLProgram` machinery entirely - three has
 * no transform-feedback support at all.
 *
 * The kernel's outputs are captured interleaved (INTERLEAVED_ATTRIBS) into one buffer, one slot per
 * particle laid out by {@link kernelSlotLayout}; its inputs read the same layout back. Interleaved
 * capture is limited only by its total component count (WebGL2 guarantees 64), where capturing each
 * buffer separately is limited to 4 buffers - the two core ones included.
 */
export class FXTransformFeedbackSimulationHolder {
  /** The slot this kernel writes; the mesh it simulates must be laid out the same. */
  public readonly layout: FXSlotLayout;

  private readonly gl: WebGL2RenderingContext;
  private readonly programLease: FXKernelProgramLease;
  private readonly vao: WebGLVertexArrayObject;
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
    this.layout = kernelSlotLayout(artifact.buffers);
    assertFitsTransformFeedback(gl, this.layout);

    // Shared by every holder of this kernel: safe, as every pass sets all of its uniforms.
    this.programLease = acquireKernelProgram(gl, artifact);
    const program = this.programLease.program;

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
   * Runs one transform-feedback pass: reads `mesh`'s current half, writes the fused spawn+update
   * program's result into the other half of the ping-pong pair, then swaps. `spawnRange`
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

    this.bindProgramAndInputs(mesh);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, mesh.writeBuffer());

    this.setUniforms(deltaTime, spawnRange, emitter, mesh.capacity);

    gl.enable(gl.RASTERIZER_DISCARD);
    gl.beginTransformFeedback(gl.POINTS);
    gl.drawArrays(gl.POINTS, 0, mesh.capacity);
    gl.endTransformFeedback();
    gl.disable(gl.RASTERIZER_DISCARD);

    // A bound base stays "active" for its binding point otherwise.
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
    mesh.swapBuffers();

    // Consumed - advance past every id this tick's spawn range just claimed.
    this.spawnIdBase += spawnRange.count;

    // Our raw gl.bindVertexArray() call above is invisible to three's own VAO-identity cache
    // (WebGLBindingStates has no scoped, public way to invalidate just this mesh's entry) -
    // resetState() is the only public lever, so it runs every tick. Per-emitter for now, not
    // batched across every GPU-driven emitter into one call per frame - a real, deferred
    // optimization, not required for correctness.
    this.renderer.resetState();
  }

  /**
   * Seeds the slots of `spawnRange` right now, from `emitter` and the current binding values, and
   * touches no other slot: the spawn half of {@link tick}, run on its own. Lets every `burst()`
   * outside the emitter's tick spawn from the pose and parameters of the moment it was called,
   * instead of sharing one pass - and so one pose - with everything else spawned that frame.
   *
   * Transform feedback cannot write the buffer it reads, so the seeded range is drawn into the
   * write half of the pair (`drawArrays(first, count)`: `gl_VertexID` is the slot index, which
   * makes every drawn vertex a birth under the kernel's own range test) and then copied into the
   * read half - the side the renderer draws and the next {@link tick} reads. No swap: every slot
   * outside the range keeps its state untouched. A range that wraps past the end of the ring is
   * drawn as two segments. `spawnRange.count` must not exceed the mesh's capacity; `births` is how
   * many births the range stands for - more than its count when a burst exceeded the ring - and
   * how far the particle ids advance, as {@link tick} advances them by its whole range count.
   */
  public spawn(
    mesh: FXTransformFeedbackParticle,
    spawnRange: { readonly start: number; readonly count: number },
    emitter: FXEmitterTransform,
    births: number = spawnRange.count,
  ): void {
    if (spawnRange.count <= 0) {
      return;
    }
    const gl = this.gl;
    this.randSeedCounter += 1;

    const capacity = mesh.capacity;
    const head = Math.min(spawnRange.count, capacity - spawnRange.start);
    const segments: readonly (readonly [first: number, count: number])[] =
      head < spawnRange.count
        ? [
            [spawnRange.start, head],
            [0, spawnRange.count - head],
          ]
        : [[spawnRange.start, spawnRange.count]];

    this.bindProgramAndInputs(mesh);
    // dt 0: the spawn branch has no use for it, and nothing else runs in this pass.
    this.setUniforms(0, spawnRange, emitter, capacity);

    const slotBytes = this.layout.stride * Float32Array.BYTES_PER_ELEMENT;
    gl.enable(gl.RASTERIZER_DISCARD);
    for (const [first, count] of segments) {
      gl.bindBufferRange(
        gl.TRANSFORM_FEEDBACK_BUFFER,
        0,
        mesh.writeBuffer(),
        first * slotBytes,
        count * slotBytes,
      );
      gl.beginTransformFeedback(gl.POINTS);
      gl.drawArrays(gl.POINTS, first, count);
      gl.endTransformFeedback();
    }
    gl.disable(gl.RASTERIZER_DISCARD);
    // Released before the copy: a buffer still bound for transform feedback cannot be a copy
    // source.
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);

    gl.bindBuffer(gl.COPY_READ_BUFFER, mesh.writeBuffer());
    gl.bindBuffer(gl.COPY_WRITE_BUFFER, mesh.readBuffer());
    for (const [first, count] of segments) {
      gl.copyBufferSubData(
        gl.COPY_READ_BUFFER,
        gl.COPY_WRITE_BUFFER,
        first * slotBytes,
        first * slotBytes,
        count * slotBytes,
      );
    }
    gl.bindBuffer(gl.COPY_READ_BUFFER, null);
    gl.bindBuffer(gl.COPY_WRITE_BUFFER, null);

    this.spawnIdBase += births;
    // Same reason as in tick(): the raw VAO bind is invisible to three's caches.
    this.renderer.resetState();
  }

  public destroy(): void {
    this.programLease.release();
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

  /** Binds the program and wires the read half's slot fields as its vertex inputs. */
  private bindProgramAndInputs(mesh: FXTransformFeedbackParticle): void {
    const gl = this.gl;
    // Routed through the renderer's own cache-aware setter (not raw gl.useProgram()) so three's
    // `WebGLState.currentProgram` cache stays truthful - its own next draw then correctly detects
    // the mismatch and re-binds, with no reset needed for this half of the state-hygiene problem.
    // The other half (the VAO-identity cache) has no such setter - see the raw
    // gl.bindVertexArray() call below and the resetState() that ends every pass.
    this.renderer.state.useProgram(this.programLease.program);
    gl.bindVertexArray(this.vao);

    const slotBytes = this.layout.stride * Float32Array.BYTES_PER_ELEMENT;
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.readBuffer());
    // A field's index is its input location (see FXSlotLayout).
    this.layout.fields.forEach((field, location) => {
      gl.vertexAttribPointer(
        location,
        field.components,
        gl.FLOAT,
        false,
        slotBytes,
        field.offset * Float32Array.BYTES_PER_ELEMENT,
      );
      gl.enableVertexAttribArray(location);
    });
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

/**
 * Throws when the slot `layout` does not fit this GPU: more components than interleaved transform
 * feedback captures, a slot wider than WebGL allows a vertex stride to be, or more fields than the
 * GPU has vertex inputs. Checked up front because WebGL fails nothing visible over the first -
 * `transformFeedbackVaryings` only raises a GL error, the program links without its outputs, and
 * every pass then writes nothing. The throw instead sends the emitter to its JS kernel (see
 * `FXEmitter.fromArtifacts`).
 *
 * On a conforming GPU the stride is the binding limit (255 bytes is 63 floats, under the 64
 * components WebGL2 guarantees); the component check guards a GPU that reports less anyway.
 */
function assertFitsTransformFeedback(gl: WebGL2RenderingContext, layout: FXSlotLayout): void {
  const fail = (reason: string): never => {
    throw new Error(`FXTransformFeedbackSimulationHolder: ${reason}`);
  };
  const maxComponents = gl.getParameter(gl.MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS) as number;
  if (layout.stride > maxComponents) {
    fail(
      `the kernel writes ${String(layout.stride)} components per particle; this GPU's ` +
        `transform feedback takes at most ${String(maxComponents)}`,
    );
  }
  const slotBytes = layout.stride * Float32Array.BYTES_PER_ELEMENT;
  if (slotBytes > MAX_VERTEX_STRIDE_BYTES) {
    fail(
      `a particle takes ${String(slotBytes)} bytes; a vertex stride is at most ` +
        String(MAX_VERTEX_STRIDE_BYTES),
    );
  }
  const maxInputs = gl.getParameter(gl.MAX_VERTEX_ATTRIBS) as number;
  if (layout.fields.length > maxInputs) {
    fail(
      `the kernel reads ${String(layout.fields.length)} buffers; this GPU has ` +
        `${String(maxInputs)} vertex inputs`,
    );
  }
}

import type { WebGLRenderer } from "three";

import type {
  FXEmitterTransform,
  FXKernelDrawInputs,
  FXKernelUniformValue,
  FXParticleKernelArtifact,
  FXValueSlot,
} from "../artifact/FXArtifact.js";
import { ownSlots } from "../artifact/FXValueSlots.Internal.js";
import {
  FX_TRANSFORM_FEEDBACK_BIRTH_AGE_COUNT_UNIFORM,
  FX_TRANSFORM_FEEDBACK_BIRTH_AGES_UNIFORM,
  FX_TRANSFORM_FEEDBACK_CAPACITY_UNIFORM,
  FX_TRANSFORM_FEEDBACK_DELTA_TIME_UNIFORM,
  FX_TRANSFORM_FEEDBACK_INHERITED_UNIFORM,
  FX_TRANSFORM_FEEDBACK_MODEL_MATRIX_UNIFORM,
  FX_TRANSFORM_FEEDBACK_OBJECT_ANGULAR_VELOCITY_UNIFORM,
  FX_TRANSFORM_FEEDBACK_OBJECT_VELOCITY_UNIFORM,
  FX_TRANSFORM_FEEDBACK_RAND_SEED_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SPAWN_ID_BASE_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_COUNT_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_START_UNIFORM,
} from "../behaviorTransformFeedbackLayout.js";
import { FX_PARTICLE_ID_RANGE } from "../coreLayout.js";
import { type FXSlotLayout, particleSlotLayout } from "../instancedParticle/FXParticleSlot.js";
import type { FXTransformFeedbackParticle } from "../instancedParticle/FXTransformFeedbackParticle.js";
import { deferStateReset } from "../render/FXDeferredStateReset.Internal.js";
import { gpuLimit } from "../render/FXGPULimits.Internal.js";
import type { FXAgedBirths } from "./FXBirthAges.Internal.js";
import type { FXCameraView } from "./FXCameraView.Internal.js";
import type { FXContextLease } from "./FXContextLeases.Internal.js";
import { acquireKernelProgram } from "./FXKernelProgramCache.Internal.js";
import type { FXKernelResource, FXKernelResources } from "./FXKernelResources.Internal.js";
import { type FXLinkedProgram, FXProgramBinding } from "./FXLinkedProgram.Internal.js";
import { FXSceneDepthBinding } from "./FXSceneDepthBinding.Internal.js";
import { acquireSurfaceTexture } from "./FXSurfaceTexture.Internal.js";
import { acquireVolumeTexture } from "./FXVolumeTexture.Internal.js";

/**
 * @internal A pass's births under the ring's cursor/overwrite scheme: `count` slots from `start`, the
 * last `aged.count` of them born earlier in the tick, as old as `aged.ages` says - the rest at its
 * end, age 0.
 */
export interface FXKernelSpawnRange {
  readonly start: number;
  readonly count: number;
  readonly aged?: FXAgedBirths;
}

/** A birth probe's range: vertex 0 alone. */
const PROBE_RANGE: FXKernelSpawnRange = { start: 0, count: 1 };

/** WebGL's cap on a vertex attribute stride, in bytes - one particle's slot is that stride. */
const MAX_VERTEX_STRIDE_BYTES = 255;

/**
 * @internal The GPU sibling of `FXSimulationHolder`. Runs the fused spawn+update program with raw
 * WebGL2 transform feedback each tick, outside three's material and program machinery.
 *
 * Outputs are captured interleaved into one buffer laid out by {@link particleSlotLayout}, limited
 * by total component count (64 guaranteed) rather than the 4 buffers of separate capture.
 */
export class FXTransformFeedbackSimulationHolder {
  /** The slot this kernel writes; the mesh it simulates must be laid out the same. */
  public readonly slot: FXSlotLayout;

  private readonly gl: WebGL2RenderingContext;
  private readonly programLease: FXContextLease<FXLinkedProgram>;
  private readonly vao: WebGLVertexArrayObject;
  // This emitter's own bindings - its parameters and draw uniforms - never the shared artifact's.
  private readonly bindings: Record<string, FXValueSlot<FXKernelUniformValue>>;
  /** The texture of every resource the kernel declares, uploaded before its program is built. */
  private readonly resourceTextures: readonly FXResourceTexture[];
  /** Where the program reads its inputs, found on its first pass; no pass runs without it. */
  private readonly binding: FXProgramBinding<FXKernelProgramBinding>;
  // Filled in place each pass (see setUniforms).
  private readonly drawFrame: { -readonly [K in keyof FXKernelDrawInputs]: FXKernelDrawInputs[K] } =
    { deltaTime: 0, worldMatrix: [], velocity: [], angularVelocity: [] };
  private readonly compute: FXParticleKernelArtifact["compute"];
  // The inherited values a pass uploads, whole vec4s (see FX_TRANSFORM_FEEDBACK_INHERITED_UNIFORM).
  private inheritedVectors = new Float32Array(4);

  // A new seed every tick, so `rand()` draws differ between ticks and between successive rebirths
  // of one slot. Wraparound is harmless: it only feeds a hash.
  private randSeedCounter = 0;

  // Particles spawned so far modulo FX_PARTICLE_ID_RANGE: the base for this tick's ids, which the
  // kernel offsets by spawn index. Kept across stop and replay so ids do not repeat.
  private spawnIdBase = 0;

  /**
   * Sends the program off to build and uploads the textures it samples; nothing waits for the
   * build until the first pass. `resources` are the tables of the artifact's mesh surfaces and
   * volumes, by sampler uniform. `view` is the camera view whose depth a program reading the scene
   * depth samples.
   * @throws When the slot or the textures do not fit this GPU, or the program reads the scene
   *   depth and there is no `view`.
   */
  constructor(
    private readonly renderer: WebGLRenderer,
    artifact: FXParticleKernelArtifact,
    resources: FXKernelResources = {},
    view?: FXCameraView,
  ) {
    // The caller (FXEmitter.fromArtifacts) has already checked the context is WebGL2.
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    this.gl = gl;
    this.slot = particleSlotLayout(artifact.buffers);
    assertFitsTransformFeedback(gl, this.slot);
    if (artifact.sceneDepth === true && view === undefined) {
      throw new Error(
        "FXTransformFeedbackSimulationHolder: the kernel reads the scene depth - give it a view",
      );
    }
    assertFitsTextureUnits(
      gl,
      Object.keys(resources).length + (artifact.sceneDepth === true ? 1 : 0),
    );
    this.resourceTextures = resourceTextures(renderer, gl, resources);
    this.bindings = ownSlots(artifact.bindings);
    this.compute = artifact.compute;

    // Shared by every holder of this kernel: safe, as every pass sets all of its uniforms. Last,
    // so the checks above never wait for its build.
    try {
      this.programLease = acquireKernelProgram(gl, artifact);
    } catch (error) {
      releaseTextures(this.resourceTextures);
      throw error;
    }
    this.binding = new FXProgramBinding(this.programLease.resource, (program) =>
      bindProgram(gl, program, this.bindings, this.resourceTextures, view),
    );

    // Own VAO, separate from three's, so raw attribute setup cannot corrupt its cache. The state
    // reset after each pass (see tick()) corrects the raw bindVertexArray call.
    this.vao = gl.createVertexArray();
  }

  /** The program the passes run, building or built. */
  public get program(): FXLinkedProgram {
    return this.programLease.resource;
  }

  /**
   * Runs one transform-feedback pass: reads `mesh`'s current half, writes the fused spawn+update
   * program's result into the other half of the ping-pong pair, then swaps. `spawnRange`
   * is this tick's birth range under the buffer's cursor/overwrite scheme - `count === 0` is a
   * valid, ordinary "no births this tick" case, not skipped specially - with its aged tail.
   */
  public tick(
    mesh: FXTransformFeedbackParticle,
    deltaTime: number,
    spawnRange: FXKernelSpawnRange,
    emitter: FXEmitterTransform,
    inherited: Float32Array,
  ): void {
    const gl = this.gl;
    if (!this.preparePass(mesh, deltaTime, spawnRange, emitter, inherited)) {
      return;
    }
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, mesh.writeBuffer());
    this.capture(0, mesh.capacity);

    // A bound base stays "active" for its binding point otherwise.
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
    mesh.swapBuffers();

    // Consumed - advance past every id this tick's spawn range just claimed.
    this.spawnIdBase = (this.spawnIdBase + spawnRange.count) % FX_PARTICLE_ID_RANGE;

    // The raw bindVertexArray call is invisible to three's VAO cache and three has no scoped way to
    // invalidate one entry, so the world resets three's state after its tick.
    deferStateReset(this.renderer);
  }

  /**
   * Seeds the slots of `spawnRange` now, as the spawn half of {@link tick} on its own, so each
   * burst outside the tick spawns from the pose and parameters of its moment.
   *
   * Transform feedback cannot write the buffer it reads, so the range is drawn into the write half
   * (`gl_VertexID` is the slot index, which makes every drawn vertex a birth under the kernel's
   * range test) and then copied into the read half. No swap: slots outside the range keep their
   * state. A range that wraps is drawn as two segments. `spawnRange.count` must not exceed
   * capacity. `births` is how many births the range stands for (more than its count when a burst
   * exceeded the ring) and how far the particle ids advance.
   */
  public spawn(
    mesh: FXTransformFeedbackParticle,
    spawnRange: FXKernelSpawnRange,
    emitter: FXEmitterTransform,
    inherited: Float32Array,
    births: number = spawnRange.count,
  ): void {
    if (spawnRange.count <= 0) {
      return;
    }
    const gl = this.gl;
    const capacity = mesh.capacity;
    const head = Math.min(spawnRange.count, capacity - spawnRange.start);
    const segments: readonly (readonly [first: number, count: number])[] =
      head < spawnRange.count
        ? [
            [spawnRange.start, head],
            [0, spawnRange.count - head],
          ]
        : [[spawnRange.start, spawnRange.count]];

    // dt 0: the spawn branch has no use for it, and nothing else runs in this pass.
    if (!this.preparePass(mesh, 0, spawnRange, emitter, inherited)) {
      return;
    }

    const slotBytes = this.slot.stride * Float32Array.BYTES_PER_ELEMENT;
    for (const [first, count] of segments) {
      gl.bindBufferRange(
        gl.TRANSFORM_FEEDBACK_BUFFER,
        0,
        mesh.writeBuffer(),
        first * slotBytes,
        count * slotBytes,
      );
      this.capture(first, count);
    }
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

    this.spawnIdBase = (this.spawnIdBase + births) % FX_PARTICLE_ID_RANGE;
    // Same reason as in tick(): the raw VAO bind is invisible to three's caches.
    deferStateReset(this.renderer);
  }

  /**
   * Seeds `target`, a buffer of one slot outside the ring, with the particle a birth from `emitter`
   * would be now (see `FXBirthProbe`): the spawn half of {@link tick} over vertex 0 alone, whose
   * range of one makes it a birth under the kernel's own range test. The spawn branch never reads
   * the slot it overwrites, so the vertex's input - the ring's slot 0 - goes unseen, and no slot of
   * `mesh` is written. It takes the id the next birth will, advancing none.
   */
  public seedProbe(
    mesh: FXTransformFeedbackParticle,
    target: WebGLBuffer,
    emitter: FXEmitterTransform,
    inherited: Float32Array,
  ): void {
    const gl = this.gl;
    if (!this.preparePass(mesh, 0, PROBE_RANGE, emitter, inherited)) {
      return;
    }
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, target);
    this.capture(0, 1);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
    // Same reason as in tick(): the raw VAO bind is invisible to three's caches.
    deferStateReset(this.renderer);
  }

  public destroy(): void {
    releaseTextures(this.resourceTextures);
    this.programLease.release();
    this.gl.deleteVertexArray(this.vao);
  }

  /** Sets each named binding in place, as `FXSimulationHolder.applyBindingValues`. */
  public applyBindingValues(values: Readonly<Record<string, number | Float32Array>>): void {
    for (const name in values) {
      if (name in this.bindings) {
        this.bindings[name].value = values[name];
      }
    }
  }

  /**
   * Readies a pass of the program over `mesh`'s current half: a fresh random seed, the program and
   * its inputs bound, and every uniform set for `spawnRange`. Returns `false`, readying nothing,
   * when the program failed to build.
   */
  private preparePass(
    mesh: FXTransformFeedbackParticle,
    deltaTime: number,
    spawnRange: FXKernelSpawnRange,
    emitter: FXEmitterTransform,
    inherited: Float32Array,
  ): boolean {
    const binding = this.binding.get();
    if (binding === null) {
      return false;
    }
    this.randSeedCounter += 1;
    this.bindProgramAndInputs(mesh);
    this.setUniforms(binding, deltaTime, spawnRange, emitter, inherited, mesh.capacity);
    return true;
  }

  /** Runs the bound program over vertices `[first, first + count)` into the bound feedback buffer. */
  private capture(first: number, count: number): void {
    const gl = this.gl;
    gl.enable(gl.RASTERIZER_DISCARD);
    gl.beginTransformFeedback(gl.POINTS);
    gl.drawArrays(gl.POINTS, first, count);
    gl.endTransformFeedback();
    gl.disable(gl.RASTERIZER_DISCARD);
  }

  /** Binds the program and wires the read half's slot fields as its vertex inputs. */
  private bindProgramAndInputs(mesh: FXTransformFeedbackParticle): void {
    const gl = this.gl;
    // Set through the renderer's state, so three's current-program cache stays correct.
    this.renderer.state.useProgram(this.programLease.resource.program);
    gl.bindVertexArray(this.vao);

    const slotBytes = this.slot.stride * Float32Array.BYTES_PER_ELEMENT;
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.readBuffer());
    // A field's index is its input location (see FXSlotLayout).
    this.slot.fields.forEach((field, location) => {
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
    binding: FXKernelProgramBinding,
    deltaTime: number,
    spawnRange: FXKernelSpawnRange,
    emitter: FXEmitterTransform,
    inherited: Float32Array,
    capacity: number,
  ): void {
    const gl = this.gl;
    const vectorLength = Math.max(4, Math.ceil(inherited.length / 4) * 4);
    if (this.inheritedVectors.length === vectorLength) {
      this.inheritedVectors.fill(0);
    } else {
      this.inheritedVectors = new Float32Array(vectorLength);
    }
    this.inheritedVectors.set(inherited);
    gl.uniform4fv(
      binding.uniformLocations[FX_TRANSFORM_FEEDBACK_INHERITED_UNIFORM],
      this.inheritedVectors,
    );
    gl.uniform1i(
      binding.uniformLocations[FX_TRANSFORM_FEEDBACK_RAND_SEED_UNIFORM],
      this.randSeedCounter,
    );
    gl.uniform1i(
      binding.uniformLocations[FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_START_UNIFORM],
      spawnRange.start,
    );
    gl.uniform1i(
      binding.uniformLocations[FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_COUNT_UNIFORM],
      spawnRange.count,
    );
    gl.uniform1i(
      binding.uniformLocations[FX_TRANSFORM_FEEDBACK_SPAWN_ID_BASE_UNIFORM],
      this.spawnIdBase,
    );
    gl.uniform1i(
      binding.uniformLocations[FX_TRANSFORM_FEEDBACK_BIRTH_AGE_COUNT_UNIFORM],
      spawnRange.aged?.count ?? 0,
    );
    const ages = spawnRange.aged?.ages;
    gl.uniform2f(
      binding.uniformLocations[FX_TRANSFORM_FEEDBACK_BIRTH_AGES_UNIFORM],
      ages?.first ?? 0,
      ages?.step ?? 0,
    );
    gl.uniform1i(binding.uniformLocations[FX_TRANSFORM_FEEDBACK_CAPACITY_UNIFORM], capacity);
    gl.uniform1f(binding.uniformLocations[FX_TRANSFORM_FEEDBACK_DELTA_TIME_UNIFORM], deltaTime);
    // WebGL reads a plain array as it is: nothing to copy.
    gl.uniformMatrix4fv(
      binding.uniformLocations[FX_TRANSFORM_FEEDBACK_MODEL_MATRIX_UNIFORM],
      false,
      emitter.worldMatrix as number[],
    );
    gl.uniform3fv(
      binding.uniformLocations[FX_TRANSFORM_FEEDBACK_OBJECT_VELOCITY_UNIFORM],
      emitter.velocity as number[],
    );
    gl.uniform3fv(
      binding.uniformLocations[FX_TRANSFORM_FEEDBACK_OBJECT_ANGULAR_VELOCITY_UNIFORM],
      emitter.angularVelocity as number[],
    );
    if (this.compute !== undefined) {
      const frame = this.drawFrame;
      frame.deltaTime = deltaTime;
      frame.worldMatrix = emitter.worldMatrix;
      frame.velocity = emitter.velocity;
      frame.angularVelocity = emitter.angularVelocity;
      this.compute(frame, this.bindings);
    }
    for (const entry of binding.uploads) {
      entry.upload(gl, entry.location, entry.slot.value);
    }
    binding.samplers.forEach((sampler, unit) => {
      // Through three's state, so its texture cache stays true to the context.
      this.renderer.state.activeTexture(gl.TEXTURE0 + unit);
      this.renderer.state.bindTexture(sampler.texture.target, sampler.texture.lease.resource);
      gl.uniform1i(sampler.location, unit);
    });
    binding.sceneDepth?.bind(this.renderer, binding.samplers.length);
  }
}

const FIXED_UNIFORM_NAMES: readonly string[] = [
  FX_TRANSFORM_FEEDBACK_RAND_SEED_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_START_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_COUNT_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SPAWN_ID_BASE_UNIFORM,
  FX_TRANSFORM_FEEDBACK_BIRTH_AGE_COUNT_UNIFORM,
  FX_TRANSFORM_FEEDBACK_BIRTH_AGES_UNIFORM,
  FX_TRANSFORM_FEEDBACK_CAPACITY_UNIFORM,
  FX_TRANSFORM_FEEDBACK_DELTA_TIME_UNIFORM,
  FX_TRANSFORM_FEEDBACK_MODEL_MATRIX_UNIFORM,
  FX_TRANSFORM_FEEDBACK_OBJECT_VELOCITY_UNIFORM,
  FX_TRANSFORM_FEEDBACK_OBJECT_ANGULAR_VELOCITY_UNIFORM,
  FX_TRANSFORM_FEEDBACK_INHERITED_UNIFORM,
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
  const maxComponents = gpuLimit(gl, gl.MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS);
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
  const maxInputs = gpuLimit(gl, gl.MAX_VERTEX_ATTRIBS);
  if (layout.fields.length > maxInputs) {
    fail(
      `the kernel reads ${String(layout.fields.length)} buffers; this GPU has ` +
        `${String(maxInputs)} vertex inputs`,
    );
  }
}

/** One binding a pass uploads: where the program reads it, its slot, how its type uploads. */
interface FXBindingUpload {
  readonly location: WebGLUniformLocation;
  readonly slot: FXValueSlot<FXKernelUniformValue>;
  readonly upload: FXUniformUpload;
}

type FXUniformUpload = (
  gl: WebGL2RenderingContext,
  location: WebGLUniformLocation,
  value: FXKernelUniformValue,
) => void;

const UPLOAD_FLOAT: FXUniformUpload = (gl, location, value) => {
  gl.uniform1f(location, value as number);
};
const UPLOAD_VEC2: FXUniformUpload = (gl, location, value) => {
  gl.uniform2fv(location, value as number[]);
};
const UPLOAD_VEC3: FXUniformUpload = (gl, location, value) => {
  gl.uniform3fv(location, value as number[]);
};
const UPLOAD_VEC4: FXUniformUpload = (gl, location, value) => {
  gl.uniform4fv(location, value as number[]);
};
const UPLOAD_MAT2: FXUniformUpload = (gl, location, value) => {
  gl.uniformMatrix2fv(location, false, value as number[]);
};
const UPLOAD_MAT3: FXUniformUpload = (gl, location, value) => {
  gl.uniformMatrix3fv(location, false, value as number[]);
};
const UPLOAD_MAT4: FXUniformUpload = (gl, location, value) => {
  gl.uniformMatrix4fv(location, false, value as number[]);
};

/**
 * The upload of each binding of `bindings` that `program` uses, by the type the program declares
 * it as - a binding it does not use (compiled away) uploads nothing. A float takes a number; a
 * vector or matrix an array (column-major). A sampler is a resource (see `samplerBindings`).
 */
function bindingUploads(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  bindings: Readonly<Record<string, FXValueSlot<FXKernelUniformValue>>>,
): FXBindingUpload[] {
  const byType = new Map<number, FXUniformUpload>([
    [gl.FLOAT, UPLOAD_FLOAT],
    [gl.FLOAT_VEC2, UPLOAD_VEC2],
    [gl.FLOAT_VEC3, UPLOAD_VEC3],
    [gl.FLOAT_VEC4, UPLOAD_VEC4],
    [gl.FLOAT_MAT2, UPLOAD_MAT2],
    [gl.FLOAT_MAT3, UPLOAD_MAT3],
    [gl.FLOAT_MAT4, UPLOAD_MAT4],
  ]);
  const types = new Map<string, number>();
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
  for (let index = 0; index < count; index += 1) {
    const info = gl.getActiveUniform(program, index);
    if (info !== null) {
      types.set(info.name, info.type);
    }
  }
  const uploads: FXBindingUpload[] = [];
  for (const name in bindings) {
    const type = types.get(name);
    const upload = type === undefined ? undefined : byType.get(type);
    const location = gl.getUniformLocation(program, name);
    if (upload !== undefined && location !== null) {
      uploads.push({ location, slot: bindings[name], upload });
    }
  }
  return uploads;
}

/** The texture of one resource the kernel declares, by its sampler uniform. */
interface FXResourceTexture {
  readonly name: string;
  readonly target: number;
  readonly lease: FXContextLease<WebGLTexture>;
}

/** A resource the program samples: where its sampler is, and the texture it binds there. */
interface FXSamplerBinding {
  readonly location: WebGLUniformLocation;
  readonly texture: FXResourceTexture;
}

/** Where a built program reads its inputs. */
interface FXKernelProgramBinding {
  readonly uniformLocations: Readonly<Record<string, WebGLUniformLocation | null>>;
  /** Each binding the program uses, resolved once: a pass only walks this. */
  readonly uploads: readonly FXBindingUpload[];
  /** The textures the program samples, texture unit `i` for entry `i`. */
  readonly samplers: readonly FXSamplerBinding[];
  /** The scene depth the program reads, on the unit after the samplers'; `undefined` for none. */
  readonly sceneDepth: FXSceneDepthBinding | undefined;
}

/**
 * Throws when `units` textures - every resource the kernel declares, and its scene depth - take
 * more texture units than this GPU's vertex stage has. Counted from the artifact, before the
 * program is built: a sampler the driver compiles away would take none, but which ones it drops
 * is known only once the build has ended.
 */
function assertFitsTextureUnits(gl: WebGL2RenderingContext, units: number): void {
  const maxUnits = gpuLimit(gl, gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS);
  if (units > maxUnits) {
    throw new Error(
      `FXTransformFeedbackSimulationHolder: the kernel samples ${String(units)} textures; this ` +
        `GPU's vertex stage has ${String(maxUnits)} texture units`,
    );
  }
}

/** The texture of each of `resources`, uploaded now. */
function resourceTextures(
  renderer: WebGLRenderer,
  gl: WebGL2RenderingContext,
  resources: FXKernelResources,
): FXResourceTexture[] {
  const textures: FXResourceTexture[] = [];
  try {
    for (const name in resources) {
      textures.push({ name, ...resourceTexture(renderer, gl, resources[name]) });
    }
  } catch (error) {
    releaseTextures(textures);
    throw error;
  }
  return textures;
}

function releaseTextures(textures: readonly FXResourceTexture[]): void {
  for (const texture of textures) {
    texture.lease.release();
  }
}

/**
 * Where the built `program` reads its inputs. A binding, resource or scene depth it does not use
 * (compiled away) is left out.
 */
function bindProgram(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  bindings: Readonly<Record<string, FXValueSlot<FXKernelUniformValue>>>,
  textures: readonly FXResourceTexture[],
  view: FXCameraView | undefined,
): FXKernelProgramBinding {
  const uniformLocations: Record<string, WebGLUniformLocation | null> = {};
  for (const name of FIXED_UNIFORM_NAMES) {
    uniformLocations[name] = gl.getUniformLocation(program, name);
  }
  const samplers: FXSamplerBinding[] = [];
  for (const texture of textures) {
    const location = gl.getUniformLocation(program, texture.name);
    if (location !== null) {
      samplers.push({ location, texture });
    }
  }
  return {
    uniformLocations,
    uploads: bindingUploads(gl, program, bindings),
    samplers,
    sceneDepth: view === undefined ? undefined : FXSceneDepthBinding.of(gl, program, view),
  };
}

/** The texture `resource` is sampled from, and the target it binds to. */
function resourceTexture(
  renderer: WebGLRenderer,
  gl: WebGL2RenderingContext,
  resource: FXKernelResource,
): Pick<FXResourceTexture, "target" | "lease"> {
  switch (resource.kind) {
    case "surface":
      return { target: gl.TEXTURE_2D, lease: acquireSurfaceTexture(renderer, resource.table) };
    case "volume":
      return { target: gl.TEXTURE_3D, lease: acquireVolumeTexture(renderer, resource.table) };
  }
}

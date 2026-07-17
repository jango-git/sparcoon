import type { BufferGeometry, Camera, InstancedBufferAttribute } from "three";
import { Object3D, Quaternion, Vector3 } from "three";
import type { FXEmitterTransform } from "../artifact/FXArtifact.js";
import type { FXBehaviorArtifact, FXRenderArtifact } from "../artifact/FXArtifact.js";
import type { FXFromArtifactsOptions } from "./FXFromArtifactsOptions.js";
import { FXWorld } from "../world/FXWorld.js";
import { FXObjectMotionTracker } from "./FXObjectMotion.Internal.js";
import {
  FX_AGE,
  FX_CORE_LIFECYCLE,
  FX_CORE_LIFECYCLE_STRIDE,
  FX_CORE_POSITION,
  FX_CORE_POSITION_STRIDE,
} from "../coreLayout.js";
import { FXInstancedParticle } from "../instancedParticle/FXInstancedParticle.js";
import type { GLTypeInfo } from "../instancedParticle/glTypeInfo.js";
import { resolveGeometrySource } from "../instancedParticle/primitiveGeometry.js";
import {
  assertValidNonNegativeNumber,
  assertValidPositiveInteger,
  assertValidPositiveNumber,
} from "../miscellaneous/asserts.js";
import { FXArtifactMaterial } from "../render/FXArtifactMaterial.js";
import { FXSimulationHolder } from "./FXSimulationHolder.js";
import type {
  FXApplyValues,
  FXEmitterBurstOptions,
  FXEmitterOptions,
  FXEmitterPlayOptions,
} from "./FXEmitter.Internal.js";
import {
  EMITTER_DEFAULT_CAPACITY_STEP,
  EMITTER_DEFAULT_CAST_SHADOW,
  EMITTER_DEFAULT_EXPECTED_CAPACITY,
  EMITTER_DEFAULT_PREWARM_MAX_STEP_COUNT,
  EMITTER_DEFAULT_PREWARM_MIN_STEP_DURATION,
  EMITTER_DEFAULT_RECEIVE_SHADOW,
  EMITTER_DEFAULT_SORT_FRACTION,
} from "./FXEmitter.Internal.js";

// User attribute `name` -> mesh property-buffer key `fx_<name>`.
const ATTRIBUTE_BUFFER_PREFIX = "fx_";

// GLSL type of a float attribute, indexed by component count.
const GLSL_TYPE_BY_COMPONENTS: readonly string[] = ["", "float", "vec2", "vec3", "vec4"];

const CORE_POSITION_TYPE: GLTypeInfo = {
  glslTypeName: "vec3",
  bufferSize: FX_CORE_POSITION_STRIDE,
  instantiable: true,
};

const CORE_LIFECYCLE_TYPE: GLTypeInfo = {
  glslTypeName: "vec2",
  bufferSize: FX_CORE_LIFECYCLE_STRIDE,
  instantiable: true,
};

/**
 * Particle emitter - one instanced billboard/mesh draw call, per-particle state driven by a
 * precompiled behavior artifact and appearance by a precompiled render artifact spliced into a
 * Three material. Built and ticked by {@link FXEffect} through an {@link FXWorld}. Not exported from
 * the package (the runtime path is running artifacts, not hand-building emitters); reached only as
 * the live handle returned by {@link FXEffect.getEmitter}.
 */
export class FXEmitter extends Object3D {
  /** Camera for back-to-front depth sorting; `undefined` disables it. Distances are world-space, so any emitter/ancestor transform is handled correctly. */
  public sortCamera?: Camera;
  /** Fraction of frames sorting runs on (`1` = every frame, `0.1` = ~every 10th); defaults to `0.1`. */
  public sortFraction: number;

  private readonly world: FXWorld;
  private readonly mesh: FXInstancedParticle;
  private readonly material: FXArtifactMaterial;
  private readonly simulation?: FXSimulationHolder;
  private readonly collectedProperties: Record<string, GLTypeInfo>;

  private nextHandler = 0;
  private readonly pendingBursts: { handler: number; count: number; delay: number }[] = [];
  private readonly activePlays: {
    handler: number;
    rate: number;
    duration: number;
    elapsed: number;
    accumulator: number;
    delay: number;
  }[] = [];

  private sortingAccumulator = 0;
  private readonly sortingCameraWorldPosition = new Vector3();

  // The emitter's `matrixWorld` as a column-major mat4, plus its world-space velocity/angular
  // velocity, handed to the behavior kernel each spawn/update. Mutated in place - never
  // reallocated per frame.
  private readonly emitterTransform: {
    worldMatrix: number[];
    velocity: number[];
    angularVelocity: number[];
  } = {
    worldMatrix: new Array<number>(16).fill(0),
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
  };

  // Reused decompose scratch (avoids a per-tick allocation); scale is discarded.
  private readonly motionPositionScratch = new Vector3();
  private readonly motionQuaternionScratch = new Quaternion();
  private readonly motionScaleScratch = new Vector3();
  private readonly motionTracker = new FXObjectMotionTracker();

  private destroyed = false;

  // Frame-loop cache for {@link kernelBuffers}; rebuilt when the mesh's buffer set changes.
  private kernelBuffersCache?: Record<string, Float32Array>;
  private kernelBuffersCacheVersion = -1;

  /** @internal Use {@link FXEmitter.fromArtifacts}. */
  private constructor(
    material: FXArtifactMaterial,
    simulation: FXSimulationHolder | undefined,
    options: Partial<FXEmitterOptions> = {},
    baseGeometry: BufferGeometry,
    world: FXWorld,
  ) {
    super();
    this.world = world;

    if (options.expectedCapacity !== undefined) {
      // Sizes the Float32Array buffers - a fractional length is a RangeError.
      assertValidPositiveInteger(
        options.expectedCapacity,
        "FXEmitter.constructor.options.expectedCapacity",
      );
    }
    if (options.capacityStep !== undefined) {
      assertValidPositiveInteger(
        options.capacityStep,
        "FXEmitter.constructor.options.capacityStep",
      );
    }
    this.material = material;
    this.simulation = simulation;

    // Property set = the two core buffers plus one `fx_<name>` per attribute, known before the mesh
    // and Three material are built so `a_<name>`/`p_<name>` are declared up front. A cross-artifact
    // width disagreement fails fast here.
    const components = this.attributeComponents();
    this.collectedProperties = this.buildCollectedProperties(components);
    const threeMaterial = material.buildThreeMaterial(this.collectedProperties);

    this.mesh = new FXInstancedParticle(
      this.collectedProperties,
      options.expectedCapacity ?? EMITTER_DEFAULT_EXPECTED_CAPACITY,
      options.capacityStep ?? EMITTER_DEFAULT_CAPACITY_STEP,
      threeMaterial,
      baseGeometry,
    );

    if (options.receiveShadow ?? EMITTER_DEFAULT_RECEIVE_SHADOW) {
      this.mesh.receiveShadow = true;
    }

    // Pay for the second (depth) ShaderMaterial only when a cast shadow is actually requested.
    // `castShadow`/`customDepthMaterial` are inherited Object3D members; `frustumCulled` is already
    // false on the mesh, so the shadow pass's frustum check is a no-op just like the color pass.
    if (options.castShadow ?? EMITTER_DEFAULT_CAST_SHADOW) {
      this.mesh.castShadow = true;
      this.mesh.customDepthMaterial = material.buildThreeDepthMaterial(this.collectedProperties);
    }

    this.sortCamera = options.sortCamera;
    this.sortFraction = EMITTER_DEFAULT_SORT_FRACTION;
    if (options.sortFraction !== undefined) {
      this.setSortFraction(options.sortFraction, "FXEmitter.constructor.options.sortFraction");
    }
    this.assertCanSpawn("FXEmitter.constructor");

    this.add(this.mesh);
    this.world.registerObject(this);
  }

  public get particleCount(): number {
    return this.mesh.instanceCount;
  }

  public get particleCapacity(): number {
    return this.mesh.instanceCapacity;
  }

  /**
   * Builds an emitter into `world` from a precompiled effect - the low-level building block behind
   * {@link FXEffect}. Exposed for editor tooling through the `sparcoon/editor` entry (live preview
   * rebuilds a single emitter per graph edit); not part of the main package surface, where the
   * runtime path is running whole projects through `FXEffect`.
   */
  public static fromArtifacts(
    render: FXRenderArtifact,
    behavior: FXBehaviorArtifact,
    options: FXFromArtifactsOptions = {},
    world: FXWorld = FXWorld.getDefault(),
  ): FXEmitter {
    const material = new FXArtifactMaterial(render, options.textures);
    const holder = new FXSimulationHolder(behavior);
    const baseGeometry = resolveGeometrySource(render.geometry, options.geometries ?? {});
    return new FXEmitter(material, holder, options, baseGeometry, world);
  }

  /**
   * @internal Ticks this emitter one frame. Driven by {@link FXWorld.update}, which advances the
   * shared clock once and passes it in as `elapsedTime`.
   */
  public onWorldTick(deltaTime: number, elapsedTime: number): void {
    this.onRendering(deltaTime);
    this.material.setElapsedTime(elapsedTime);
    this.material.setDeltaTime(deltaTime);
    // emitterTransform.velocity/angularVelocity are always length 3 (see its declaration) -
    // computed once per tick in onRendering -> tick.
    this.material.setObjectVelocity(this.emitterTransform.velocity as [number, number, number]);
    this.material.setObjectAngularVelocity(
      this.emitterTransform.angularVelocity as [number, number, number],
    );
  }

  /** Unregisters, removes from the scene, disposes mesh and material. Idempotent. */
  public destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;

    this.world.unregisterObject(this);

    // Drop scheduled work and the buffer cache so nothing references the mesh's buffers after teardown.
    this.pendingBursts.length = 0;
    this.activePlays.length = 0;
    this.kernelBuffersCache = undefined;

    // The material owns no per-emitter GPU resources; the mesh teardown disposes the instanced
    // geometry and the mounted material.
    this.material.destroy();
    this.mesh.destroy();

    this.removeFromParent();
  }

  /**
   * Spawns `count` particles immediately, or after `options.delay`.
   * @returns Handler for {@link stop} to cancel a pending delayed burst.
   */
  public burst(count: number, options: Partial<FXEmitterBurstOptions> = {}): number {
    // Whole particles only: a fractional count sets a fractional `instanceCount`.
    assertValidPositiveInteger(count, "FXEmitter.burst.count");
    this.assertCanSpawn("FXEmitter.burst");
    if (this.destroyed) {
      return DEAD_HANDLER;
    }
    const handler = this.nextHandler++;
    const delay = options.delay ?? 0;
    assertValidNonNegativeNumber(delay, "FXEmitter.burst.options.delay");

    if (delay <= 0) {
      this.spawnBurst(count);
    } else {
      this.pendingBursts.push({ handler, count, delay });
    }

    return handler;
  }

  /**
   * Starts continuous emission at `rate` particles/second.
   * @returns Handler for {@link stop} to cancel.
   */
  public play(rate: number, options: Partial<FXEmitterPlayOptions> = {}): number {
    assertValidPositiveNumber(rate, "FXEmitter.play.rate");
    if (options.delay !== undefined) {
      assertValidNonNegativeNumber(options.delay, "FXEmitter.play.options.delay");
    }
    this.assertCanSpawn("FXEmitter.play");
    if (this.destroyed) {
      return DEAD_HANDLER;
    }
    const handler = this.nextHandler++;

    this.activePlays.push({
      handler,
      rate,
      duration: options.duration ?? Infinity,
      elapsed: 0,
      accumulator: 0,
      delay: options.delay ?? 0,
    });

    return handler;
  }

  /**
   * Stops an active play or pending burst by handler; stops all when called with no arguments.
   * @returns `true` if anything was stopped.
   */
  public stop(handler?: number): boolean {
    if (this.destroyed) {
      return false;
    }
    if (handler === undefined) {
      const hadAnything = this.pendingBursts.length > 0 || this.activePlays.length > 0;
      this.pendingBursts.length = 0;
      this.activePlays.length = 0;
      return hadAnything;
    }

    const burstIndex = this.pendingBursts.findIndex((b) => b.handler === handler);
    if (burstIndex !== -1) {
      this.pendingBursts.splice(burstIndex, 1);
      return true;
    }

    const playIndex = this.activePlays.findIndex((play) => play.handler === handler);
    if (playIndex !== -1) {
      this.activePlays.splice(playIndex, 1);
      return true;
    }

    return false;
  }

  /**
   * Simulates forward in time to avoid a cold-start on frame 0.
   * @param stepDuration - Maximum step size in seconds. Defaults to `1/60`.
   */
  public prewarm(duration: number, stepDuration = EMITTER_DEFAULT_PREWARM_MIN_STEP_DURATION): void {
    assertValidPositiveNumber(duration, "FXEmitter.prewarm.duration");
    assertValidPositiveNumber(stepDuration, "FXEmitter.prewarm.stepDuration");
    if (this.destroyed) {
      // Ticking a destroyed emitter would fire pending bursts and mutate disposed geometry.
      return;
    }
    const stepCount = Math.min(
      duration / Math.max(stepDuration, EMITTER_DEFAULT_PREWARM_MIN_STEP_DURATION),
      EMITTER_DEFAULT_PREWARM_MAX_STEP_COUNT,
    );
    const step = duration / stepCount;
    let remaining = duration;

    while (remaining > 0) {
      const deltaTime = Math.min(remaining, step);
      this.tick(deltaTime);
      remaining -= deltaTime;
    }
  }

  /** Kills all live particles and cancels all active plays and pending bursts. */
  public reset(): void {
    if (this.destroyed) {
      return;
    }
    this.pendingBursts.length = 0;
    this.activePlays.length = 0;
    this.mesh.drop();
    // A restarted effect should not report a teleport spike from wherever the emitter was last
    // posed - drop the velocity/angular-velocity baseline along with the particles.
    this.motionTracker.reset();
  }

  /**
   * Scrubs live parameter values into uniform/binding slots by name, picked up next frame - the
   * runtime's value channel for a non-structural edit. Unknown name = safe no-op; never recompiles.
   * A structural edit is instead a fresh {@link fromArtifacts} (the editor decides which).
   */
  public applyValues(values: FXApplyValues): void {
    if (this.destroyed) {
      return;
    }
    if (values.uniforms !== undefined) {
      this.material.applyUniformValues(values.uniforms);
    }
    if (values.bindings !== undefined) {
      this.simulation?.applyBindingValues(values.bindings);
    }
  }

  /**
   * Merged attribute set (name -> component count): union of the behavior's writes and the render's
   * reads. Throws on a cross-artifact width disagreement rather than sizing a buffer wrong.
   */
  private attributeComponents(): ReadonlyMap<string, number> {
    const components = new Map<string, number>();
    const add = (name: string, count: number): void => {
      const existing = components.get(name);
      if (existing !== undefined && existing !== count) {
        throw new Error(
          `FXEmitter: attribute "${name}" is written and read with conflicting widths ` +
            `(${existing.toString()} vs ${count.toString()}); the behavior attributeWrites and ` +
            `the render attributeReads must agree`,
        );
      }
      components.set(name, count);
    };
    for (const write of this.simulation?.attributeWrites ?? []) {
      add(write.name, write.components);
    }
    for (const read of this.material.attributeReads) {
      add(read.name, read.components);
    }
    return components;
  }

  private buildCollectedProperties(
    components: ReadonlyMap<string, number>,
  ): Record<string, GLTypeInfo> {
    const properties: Record<string, GLTypeInfo> = {
      [FX_CORE_POSITION]: CORE_POSITION_TYPE,
      [FX_CORE_LIFECYCLE]: CORE_LIFECYCLE_TYPE,
    };
    for (const [name, count] of components) {
      properties[`${ATTRIBUTE_BUFFER_PREFIX}${name}`] = {
        glslTypeName: GLSL_TYPE_BY_COMPONENTS[count],
        bufferSize: count,
        instantiable: true,
      };
    }
    return properties;
  }

  private setSortFraction(value: number, context: string): void {
    assertValidNonNegativeNumber(value, context);
    // Clamp to [0, 1]: a value > 1 would grow `sortingAccumulator` without bound.
    this.sortFraction = Math.min(value, 1);
  }

  // Throws when the behavior artifact cannot seed births. Checked at the scheduling points, NOT in
  // the frame tick - a throw from the world tick would take the host's render loop down.
  private assertCanSpawn(context: string): void {
    if (this.simulation !== undefined && !this.simulation.canSpawn) {
      throw new Error(`${context}: this behavior artifact cannot seed births (update-only)`);
    }
  }

  // Maps each kernel state-buffer name to its backing Float32Array. Cached across ticks/bursts and
  // rebuilt only when the mesh's buffer set changes (`bufferVersion` - capacity growth).
  private kernelBuffers(): Record<string, Float32Array> {
    const version = this.mesh.bufferVersion;
    if (this.kernelBuffersCache !== undefined && this.kernelBuffersCacheVersion === version) {
      return this.kernelBuffersCache;
    }
    const buffers: Record<string, Float32Array> = {
      [FX_CORE_POSITION]: this.mesh.propertyBuffers[FX_CORE_POSITION].array as Float32Array,
      [FX_CORE_LIFECYCLE]: this.mesh.propertyBuffers[FX_CORE_LIFECYCLE].array as Float32Array,
    };
    for (const buffer of this.simulation?.attributeBuffers ?? []) {
      const attribute = this.mesh.propertyBuffers[`${ATTRIBUTE_BUFFER_PREFIX}${buffer.name}`] as
        InstancedBufferAttribute | undefined;
      if (attribute !== undefined) {
        buffers[buffer.name] = attribute.array as Float32Array;
      }
    }
    this.kernelBuffersCache = buffers;
    this.kernelBuffersCacheVersion = version;
    return buffers;
  }

  // The emitter's world matrix as the reused snapshot the kernel reads. It is the mesh's
  // `matrixWorld` (same matrix the shader and depth sort see), so a world-space graph stays
  // consistent under any transform. `Matrix4.elements` is already column-major.
  private worldTransform(): FXEmitterTransform {
    this.mesh.updateWorldMatrix(true, false);
    const world = this.mesh.matrixWorld.elements;
    const transform = this.emitterTransform;
    for (let i = 0; i < 16; i += 1) {
      transform.worldMatrix[i] = world[i];
    }
    return transform;
  }

  private markBuffersNeedUpdate(names: readonly string[]): void {
    for (const name of names) {
      const isCore = name === FX_CORE_POSITION || name === FX_CORE_LIFECYCLE;
      const key = isCore ? name : `${ATTRIBUTE_BUFFER_PREFIX}${name}`;
      const attribute = this.mesh.propertyBuffers[key] as InstancedBufferAttribute | undefined;
      if (attribute !== undefined) {
        attribute.needsUpdate = true;
      }
    }
  }

  private tick(deltaTime: number): void {
    // World-space velocity/angular velocity since the previous tick, computed once here and not
    // inside worldTransform() - the burst/play loops below and the update phase can each call
    // worldTransform() several times this tick, and diffing per-call instead of per-tick would
    // corrupt the value on a frame with more than one of those (each call would diff against a
    // baseline the previous call already advanced).
    this.mesh.updateWorldMatrix(true, false);
    this.mesh.matrixWorld.decompose(
      this.motionPositionScratch,
      this.motionQuaternionScratch,
      this.motionScaleScratch,
    );
    const motion = this.motionTracker.sample(
      {
        position: [
          this.motionPositionScratch.x,
          this.motionPositionScratch.y,
          this.motionPositionScratch.z,
        ],
        quaternion: [
          this.motionQuaternionScratch.x,
          this.motionQuaternionScratch.y,
          this.motionQuaternionScratch.z,
          this.motionQuaternionScratch.w,
        ],
      },
      deltaTime,
    );
    this.emitterTransform.velocity[0] = motion.velocity[0];
    this.emitterTransform.velocity[1] = motion.velocity[1];
    this.emitterTransform.velocity[2] = motion.velocity[2];
    this.emitterTransform.angularVelocity[0] = motion.angularVelocity[0];
    this.emitterTransform.angularVelocity[1] = motion.angularVelocity[1];
    this.emitterTransform.angularVelocity[2] = motion.angularVelocity[2];

    // Age increment + cull. Age is owned by this fixed loop, not the graph - same for every effect.
    {
      const lifecycle = this.mesh.propertyBuffers[FX_CORE_LIFECYCLE];
      const { array, itemSize } = lifecycle;
      const instanceCount = this.mesh.instanceCount;

      for (let i = 0; i < instanceCount; i++) {
        array[i * itemSize + FX_AGE] += deltaTime;
      }
    }

    this.mesh.removeDeadParticles();

    for (let i = this.pendingBursts.length - 1; i >= 0; i--) {
      const pending = this.pendingBursts[i];
      pending.delay -= deltaTime;

      if (pending.delay <= 0) {
        this.pendingBursts.splice(i, 1);
        this.spawnBurst(pending.count);
      }
    }

    for (let i = this.activePlays.length - 1; i >= 0; i--) {
      const play = this.activePlays[i];
      let effectiveDeltaTime = deltaTime;

      if (play.delay > 0) {
        play.delay -= deltaTime;

        if (play.delay > 0) {
          continue;
        }

        // Delay just expired - use the overshoot as effective dt this tick.
        effectiveDeltaTime = -play.delay;
        play.delay = 0;
      }

      const previousElapsed = play.elapsed;
      play.elapsed += effectiveDeltaTime;
      const expired = play.elapsed >= play.duration;

      // On the final (partial) tick, emit only for the slice inside the play's duration, so the last
      // fraction and the accumulator remainder still spawn instead of being dropped on removal.
      const emitDeltaTime = expired
        ? Math.max(0, play.duration - previousElapsed)
        : effectiveDeltaTime;
      play.accumulator += play.rate * emitDeltaTime;
      const particlesToSpawn = Math.floor(play.accumulator);

      if (particlesToSpawn > 0) {
        this.spawnBurst(particlesToSpawn);
        play.accumulator -= particlesToSpawn;
      }

      if (expired) {
        this.activePlays.splice(i, 1);
      }
    }

    if (this.mesh.instanceCount === 0) {
      return;
    }

    if (this.simulation !== undefined) {
      // Motion integration lives in the graph (an `integrate-motion` node writes
      // `position += velocity * dt`), not in this host loop.
      this.simulation.update(
        this.kernelBuffers(),
        this.mesh.instanceCount,
        deltaTime,
        this.worldTransform(),
      );
      this.markBuffersNeedUpdate(this.simulation.updateWrittenBuffers);
    }

    // Age (written above) must reach the GPU this frame; the update phase's buffers were flagged already.
    this.mesh.propertyBuffers[FX_CORE_LIFECYCLE].needsUpdate = true;
  }

  private readonly onRendering = (deltaTime: number): void => {
    this.tick(deltaTime);

    if (this.sortCamera !== undefined && this.mesh.instanceCount > 0) {
      // `sortFraction` is public, so clamp here too: a direct assignment above 1 would grow the accumulator unbounded.
      this.sortingAccumulator += Math.min(Math.max(this.sortFraction, 0), 1);

      if (this.sortingAccumulator >= 1) {
        this.sortingAccumulator -= 1;
        // Sort in world space to match the shader's `p_cameraDistance`, correct under any transform.
        this.sortCamera.getWorldPosition(this.sortingCameraWorldPosition);
        this.mesh.updateWorldMatrix(true, false);
        this.mesh.sortByDistance(this.sortingCameraWorldPosition, this.mesh.matrixWorld);
      }
    }
  };

  private spawnBurst(count: number): void {
    const instanceBegin = this.mesh.instanceCount;
    this.mesh.createInstances(count);
    const instanceEnd = this.mesh.instanceCount;

    // Re-checked (defensive): no spawn function would leave the freshly zeroed rows born dead.
    if (this.simulation?.canSpawn === true) {
      this.simulation.spawn(
        this.kernelBuffers(),
        instanceBegin,
        instanceEnd - instanceBegin,
        this.worldTransform(),
      );
      this.markBuffersNeedUpdate(this.simulation.spawnWrittenBuffers);
    }
  }
}

// Returned by post-destroy `burst`/`play` - never matches a scheduled handler.
const DEAD_HANDLER = -1;

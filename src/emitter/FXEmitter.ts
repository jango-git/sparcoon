import type { Camera } from "three";
import { Object3D, Vector3 } from "three";
import {
  assertValidNonNegativeNumber,
  assertValidPositiveNumber,
} from "../miscellaneous/asserts";
import { FXInstancedParticle } from "../instancedParticle/FXInstancedParticle";
import type { GLTypeInfo } from "../instancedParticle/shared";
import { resolveGLSLTypeInfo } from "../instancedParticle/shared";
import type { FXMaterial } from "../materials/FXMaterial/FXMaterial";
import {
  BUILTIN_OFFSET_AGE,
  BUILTIN_OFFSET_POSITION_X,
  BUILTIN_OFFSET_POSITION_Y,
  BUILTIN_OFFSET_POSITION_Z,
  BUILTIN_OFFSET_RANDOM_A,
  BUILTIN_OFFSET_RANDOM_B,
  BUILTIN_OFFSET_RANDOM_C,
  BUILTIN_OFFSET_ROTATION,
  BUILTIN_OFFSET_TORQUE,
  BUILTIN_OFFSET_VELOCITY_X,
  BUILTIN_OFFSET_VELOCITY_Y,
  BUILTIN_OFFSET_VELOCITY_Z,
} from "../miscellaneous/miscellaneous";
import type { FXBehavior } from "./behavior/FXBehavior";
import type {
  FXEmitterBurstOptions,
  FXEmitterOptions,
  FXEmitterPlayOptions,
} from "./FXEmitter.Internal";
import {
  collectProperties,
  EMITTER_DEFAULT_AUTOMATICALLY_DESTROY_MODULES,
  EMITTER_DEFAULT_CAPACITY_STEP,
  EMITTER_DEFAULT_CAST_SHADOW,
  EMITTER_DEFAULT_EXPECTED_CAPACITY,
  EMITTER_DEFAULT_PREWARM_MAX_STEP_COUNT,
  EMITTER_DEFAULT_PREWARM_MIN_STEP_DURATION,
  EMITTER_DEFAULT_RECEIVE_SHADOW,
  EMITTER_DEFAULT_SORT_FRACTION,
  EMITTERS,
} from "./FXEmitter.Internal";
import type { FXSpawn } from "./spawn/FXSpawn";

/**
 * Particle emitter - add to a scene to make particles visible
 *
 * @remarks
 * Drives a pipeline of spawn modules (run once at particle birth) and behavior modules
 * (run every frame). Call {@link FXEmitter.onWillRender} each frame to tick the system.
 */
export class FXEmitter extends Object3D {
  /** When `true`, {@link FXEmitter.destroy} also calls `destroy()` on all modules and the material; defaults to `true` */
  public automaticallyDestroyModules: boolean;
  /** Camera used for back-to-front depth sorting; `undefined` disables sorting */
  public sortCamera?: Camera;
  /** Fraction of frames on which sorting runs (`1` = every frame, `0.1` = ~every 10th frame); defaults to `0.1` */
  public sortFraction: number;

  private readonly mesh: FXInstancedParticle;
  private readonly material: FXMaterial;

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

  /**
   * @param spawnSequence - Modules executed in order when particles are born
   * @param behaviorSequence - Modules executed in order every frame for all live particles
   * @param material - Particle material
   * @param options - Emitter configuration
   */
  constructor(
    private readonly spawnSequence: FXSpawn[],
    private readonly behaviorSequence: readonly FXBehavior[],
    material: FXMaterial,
    options: Partial<FXEmitterOptions> = {},
  ) {
    super();

    if (options.expectedCapacity !== undefined) {
      assertValidPositiveNumber(options.expectedCapacity, "FXEmitter.constructor.options.expectedCapacity");
    }
    if (options.capacityStep !== undefined) {
      assertValidPositiveNumber(options.capacityStep, "FXEmitter.constructor.options.capacityStep");
    }
    if (options.sortFraction !== undefined) {
      assertValidNonNegativeNumber(options.sortFraction, "FXEmitter.constructor.options.sortFraction");
    }

    const collectedProperties: Record<string, GLTypeInfo> = {
      builtin: resolveGLSLTypeInfo("Matrix4"),
    };
    collectProperties(collectedProperties, spawnSequence, "FXEmitter.constructor.spawnSequence");
    collectProperties(
      collectedProperties,
      behaviorSequence,
      "FXEmitter.constructor.behaviorSequence",
    );

    const threeMaterial = material.buildThreeMaterial(collectedProperties);

    this.mesh = new FXInstancedParticle(
      collectedProperties,
      options.expectedCapacity ?? EMITTER_DEFAULT_EXPECTED_CAPACITY,
      options.capacityStep ?? EMITTER_DEFAULT_CAPACITY_STEP,
      threeMaterial,
    );

    if (options.castShadow ?? EMITTER_DEFAULT_CAST_SHADOW) {
      this.mesh.castShadow = true;
      this.mesh.customDepthMaterial = material.buildDepthMaterial();
      this.mesh.customDistanceMaterial = material.buildDistanceMaterial();
    }

    if (options.receiveShadow ?? EMITTER_DEFAULT_RECEIVE_SHADOW) {
      this.mesh.receiveShadow = true;
    }

    this.automaticallyDestroyModules =
      options.automaticallyDestroyModules ?? EMITTER_DEFAULT_AUTOMATICALLY_DESTROY_MODULES;
    this.sortCamera = options.sortCamera;
    this.sortFraction = options.sortFraction ?? EMITTER_DEFAULT_SORT_FRACTION;

    this.material = material;
    this.add(this.mesh);
    EMITTERS.push(this);
  }

  /**
   * Ticks all active emitters; call once per frame before rendering
   *
   * @param deltaTime - Elapsed time in seconds since the last frame
   */
  public static onWillRender = (deltaTime: number): void => {
    for (const instance of EMITTERS) {
      instance.onRendering(deltaTime);
    }
  };

  /** Unregisters the emitter, removes it from the scene, and disposes modules and material when {@link automaticallyDestroyModules} is `true` */
  public destroy(): void {
    const index = EMITTERS.indexOf(this);
    if (index !== -1) {
      EMITTERS.splice(index, 1);
    }

    if (this.automaticallyDestroyModules) {
      for (const module of this.spawnSequence) {
        module.destroy?.();
      }
      for (const module of this.behaviorSequence) {
        module.destroy?.();
      }
      this.material.destroy();
    }

    this.removeFromParent();
  }

  /**
   * Spawns `count` particles immediately, or after a delay when `options.delay` is set
   *
   * @param count - Number of particles to spawn
   * @param options - Burst options
   * @returns Handler that can be passed to {@link stop} to cancel a pending delayed burst
   */
  public burst(count: number, options: Partial<FXEmitterBurstOptions> = {}): number {
    assertValidPositiveNumber(count, "FXEmitter.burst.count");
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
   * Starts continuous emission at the given rate
   *
   * @param rate - Particles per second
   * @param options - Play options
   * @returns Handler that can be passed to {@link stop} to cancel
   */
  public play(rate: number, options: Partial<FXEmitterPlayOptions> = {}): number {
    assertValidPositiveNumber(rate, "FXEmitter.play.rate");
    if (options.delay !== undefined) {
      assertValidNonNegativeNumber(options.delay, "FXEmitter.play.options.delay");
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
   * Stops an active play or pending burst by handler; stops all when called with no arguments
   *
   * @param handler - Handler returned by {@link play} or {@link burst}; omit to stop everything
   * @returns `true` if anything was stopped
   */
  public stop(handler?: number): boolean {
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

    const playIndex = this.activePlays.findIndex((p) => p.handler === handler);
    if (playIndex !== -1) {
      this.activePlays.splice(playIndex, 1);
      return true;
    }

    return false;
  }

  /**
   * Simulates the emitter forward in time to avoid a cold-start on frame 0
   *
   * @param duration - Total time to simulate in seconds
   * @param stepDuration - Maximum simulation step size in seconds. Defaults to `1/60`
   */
  public prewarm(duration: number, stepDuration = EMITTER_DEFAULT_PREWARM_MIN_STEP_DURATION): void {
    assertValidPositiveNumber(duration, "FXEmitter.prewarm.duration");
    assertValidPositiveNumber(stepDuration, "FXEmitter.prewarm.stepDuration");
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

  /** Kills all live particles and cancels all active plays and pending bursts */
  public reset(): void {
    this.pendingBursts.length = 0;
    this.activePlays.length = 0;
    this.mesh.drop();
  }

  private tick(deltaTime: number): void {
    // Age increment & cull dead particles
    {
      const { builtin } = this.mesh.propertyBuffers;
      const { array, itemSize } = builtin;

      for (let i = 0; i < this.mesh.instanceCount; i++) {
        array[i * itemSize + BUILTIN_OFFSET_AGE] += deltaTime;
      }
    }

    this.mesh.removeDeadParticles();

    // Pending bursts (delayed)
    for (let i = this.pendingBursts.length - 1; i >= 0; i--) {
      const pending = this.pendingBursts[i];
      pending.delay -= deltaTime;

      if (pending.delay <= 0) {
        this.pendingBursts.splice(i, 1);
        this.spawnBurst(pending.count);
      }
    }

    // Active plays
    for (let i = this.activePlays.length - 1; i >= 0; i--) {
      const play = this.activePlays[i];
      let effectiveDeltaTime = deltaTime;

      if (play.delay > 0) {
        play.delay -= deltaTime;

        if (play.delay > 0) {
          continue;
        }

        // Delay just expired - use the overshoot as effective dt this tick
        effectiveDeltaTime = -play.delay;
        play.delay = 0;
      }

      play.elapsed += effectiveDeltaTime;

      if (play.elapsed >= play.duration) {
        this.activePlays.splice(i, 1);
        continue;
      }

      play.accumulator += play.rate * effectiveDeltaTime;
      const particlesToSpawn = Math.floor(play.accumulator);

      if (particlesToSpawn > 0) {
        this.spawnBurst(particlesToSpawn);
        play.accumulator -= particlesToSpawn;
      }
    }

    if (this.mesh.instanceCount === 0) {
      return;
    }

    {
      const { propertyBuffers, instanceCount } = this.mesh;

      for (const module of this.behaviorSequence) {
        module.update(propertyBuffers, instanceCount, deltaTime);
      }
    }

    {
      const { builtin } = this.mesh.propertyBuffers;
      const { array, itemSize } = builtin;

      for (let i = 0; i < this.mesh.instanceCount; i++) {
        const offset = i * itemSize;

        // Position += velocity * dt
        array[offset + BUILTIN_OFFSET_POSITION_X] +=
          array[offset + BUILTIN_OFFSET_VELOCITY_X] * deltaTime;
        array[offset + BUILTIN_OFFSET_POSITION_Y] +=
          array[offset + BUILTIN_OFFSET_VELOCITY_Y] * deltaTime;
        array[offset + BUILTIN_OFFSET_POSITION_Z] +=
          array[offset + BUILTIN_OFFSET_VELOCITY_Z] * deltaTime;

        // Rotation += torque * dt
        array[offset + BUILTIN_OFFSET_ROTATION] +=
          array[offset + BUILTIN_OFFSET_TORQUE] * deltaTime;
      }

      builtin.needsUpdate = true;
    }
  }

  private readonly onRendering = (deltaTime: number): void => {
    this.tick(deltaTime);

    if (this.sortCamera !== undefined && this.mesh.instanceCount > 0) {
      this.sortingAccumulator += this.sortFraction;

      if (this.sortingAccumulator >= 1) {
        this.sortingAccumulator -= 1;
        this.sortCamera.getWorldPosition(this.sortingCameraWorldPosition);
        this.mesh.sortByDistance(this.sortingCameraWorldPosition);
      }
    }
  };

  private spawnBurst(count: number): void {
    const instanceBegin = this.mesh.instanceCount;
    this.mesh.createInstances(count);
    const instanceEnd = this.mesh.instanceCount;

    {
      const { builtin } = this.mesh.propertyBuffers;
      const { array, itemSize } = builtin;

      for (let i = instanceBegin; i < instanceEnd; i++) {
        const itemOffset = i * itemSize;
        array[itemOffset + BUILTIN_OFFSET_RANDOM_A] = Math.random();
        array[itemOffset + BUILTIN_OFFSET_RANDOM_B] = Math.random();
        array[itemOffset + BUILTIN_OFFSET_RANDOM_C] = Math.random();
      }

      builtin.needsUpdate = true;
    }

    for (const spawnModule of this.spawnSequence) {
      spawnModule.spawn(this.mesh.propertyBuffers, instanceBegin, instanceEnd);
    }
  }
}

import type { Camera, Mesh, WebGLRenderer } from "three";
import { Object3D, Vector3 } from "three";

import type { FXEmitterTransform } from "../artifact/FXArtifact.js";
import type { FXBehaviorArtifact, FXRenderArtifact } from "../artifact/FXArtifact.js";
import { resolveGeometrySource } from "../instancedParticle/primitiveGeometry.js";
import {
  assertValidNonNegativeNumber,
  assertValidNumber,
  assertValidPositiveInteger,
  assertValidPositiveNumber,
} from "../miscellaneous/asserts.js";
import { FXArtifactMaterial } from "../render/FXArtifactMaterial.js";
import { flushStateResets } from "../render/FXDeferredStateReset.Internal.js";
import { createDrawFrame, type FXDrawFrame } from "../render/FXDrawFrame.Internal.js";
import type { FXUniformValue } from "../render/FXExternalTexture.js";
import { fxBudgetOverruns, type FXRenderBudget } from "../render/FXRenderBudget.js";
import type { FXTrailOptions } from "../trail/FXTrail.js";
import { assertValidTrailOptions, FXTrail } from "../trail/FXTrail.js";
import { trailReadFields } from "../trail/FXTrailFields.Internal.js";
import { FXWorld } from "../world/FXWorld.js";
import type { FXApplyRenderArtifactOptions } from "./FXApplyRenderArtifactOptions.js";
import type {
  FXApplyValues,
  FXEmissionBasis,
  FXEmitterBurstOptions,
  FXEmitterOptions,
  FXEmitterPlayOptions,
  FXParticleDeathListener,
  FXSpawnOrigin,
} from "./FXEmitter.Internal.js";
import {
  asEmissionBasis,
  EMITTER_DEFAULT_CAST_SHADOW,
  EMITTER_DEFAULT_EXPECTED_CAPACITY,
  EMITTER_DEFAULT_PREWARM_MAX_STEP_COUNT,
  EMITTER_DEFAULT_PREWARM_MIN_STEP_DURATION,
  EMITTER_DEFAULT_RECEIVE_SHADOW,
  EMITTER_DEFAULT_SORT_FRACTION,
  FX_EMISSION_BASES,
} from "./FXEmitter.Internal.js";
import type { FXEmitterDriver, FXParticleDeathSink } from "./FXEmitterDriver.Internal.js";
import type { FXFromArtifactsOptions } from "./FXFromArtifactsOptions.js";
import { FXGPUEmitterDriver } from "./FXGPUEmitterDriver.Internal.js";
import { FXJSEmitterDriver } from "./FXJSEmitterDriver.Internal.js";
import { FXObjectMotionTracker } from "./FXObjectMotion.Internal.js";
import { sampleObjectMotion } from "./FXObjectMotionSample.Internal.js";

/**
 * Particle emitter - one instanced billboard/mesh draw call, per-particle state driven by a
 * precompiled behavior artifact and appearance by a precompiled render artifact spliced into a
 * Three material. Built and ticked by {@link FXEffect} through an {@link FXWorld}. Not exported from
 * the package (the runtime path is running artifacts, not hand-building emitters); reached only as
 * the live handle returned by {@link FXEffect.getEmitter}.
 *
 * A thin facade over one {@link FXEmitterDriver} (JS or GPU - see `FXEmitterDriver.Internal.ts`),
 * chosen once by {@link fromArtifacts} and never switched mid-playback. This class itself owns only
 * what is genuinely backend-independent: play/burst/stop/prewarm scheduling, the births queue and
 * when the driver seeds it (see {@link tick}), death listeners, sort-fraction timing,
 * object motion tracking, the render material and the optional {@link FXTrail} (with its own
 * material) - both CAN be replaced in place, by {@link applyRenderArtifact} and
 * {@link applyTrailArtifact}, without touching the driver or its particle state.
 */
export class FXEmitter extends Object3D {
  /** Camera for back-to-front depth sorting; `undefined` disables it. Distances are world-space, so any emitter/ancestor transform is handled correctly. */
  public sortCamera?: Camera;
  /** Fraction of frames sorting runs on (`1` = every frame, `0.1` = ~every 10th); defaults to `0.1`. */
  public sortFraction: number;

  private readonly world: FXWorld;
  private readonly driver: FXEmitterDriver;
  // Not readonly: applyRenderArtifact replaces it wholesale on a successful render-only swap.
  // Never name this `material`: `private` exists only in TypeScript, and three treats any object
  // in the scene with a truthy `.material` as drawable - `renderer.compile()` would try to build a
  // program for this non-three material on an object with no geometry, and crash.
  private artifactMaterial: FXArtifactMaterial;
  // The optional trail behind every particle; replaced wholesale by applyTrailArtifact.
  private trail: FXTrail | undefined;
  // Sorting gives up the slot stability a trail's history relies on - warned once, then skipped.
  private warnedAboutTrailSorting = false;
  // What the renderer's GPU offers a trail material (see deviceLimits); `undefined` without one.
  private readonly limits: FXRenderBudget | undefined;
  // A trail past those limits is skipped - warned once per emitter, not on every swap.
  private readonly trailLimitWarning: { warned: boolean };
  // The last value applyValues set per parameter, for a material swapped in later
  // (applyRenderArtifact, applyTrailArtifact) to start from the values its parameters are being
  // driven with, not its baked ones.
  private readonly appliedUniforms: Record<string, FXUniformValue> = {};
  // Filled in place for each material each tick (see advanceMaterial).
  private readonly drawFrame: FXDrawFrame = createDrawFrame();

  private nextHandler = 0;
  // The schedule - what will spawn later: delayed bursts and plays, each with its handler. `stop`
  // cancels it; `loopTimeline` cancels the part that follows this emitter's pose (no `origin`).
  private readonly pendingBursts: {
    handler: number;
    count: number;
    delay: number;
    origin: FXEmitterTransform | undefined;
  }[] = [];
  private readonly activePlays: {
    handler: number;
    rate: number;
    over: FXEmissionBasis;
    duration: number;
    elapsed: number;
    accumulator: number;
    delay: number;
    origin: FXEmitterTransform | undefined;
  }[] = [];
  // Births that are due and wait for this emitter's tick to seed them, in call order - the only way
  // particles are born (see tick). Not cancellable: only `reset` drops them.
  private readonly dueBirths: FXDueBirth[] = [];
  // Nothing alive and nothing to fade: true from construction and after `settle` until the next
  // birth.
  private settled = true;
  // See FXEmitterOptions.maxLifetime. Advanced at the start of a tick, before its births zero it,
  // so no particle is older than it.
  private readonly maxLifetime: number | undefined;
  private sinceLastBirth = 0;

  // Particle-death listeners, and the deaths ticks found (position xyz, velocity xyz, flat), handed
  // out after the whole world ticked (afterWorldTick). Two queues swapped per hand-out: a death is
  // taken off `pendingDeaths` before any listener sees it, so one that throws never sees it again.
  private readonly deathListeners = new Set<FXParticleDeathListener>();
  private pendingDeaths: number[] = [];
  private dispatchingDeaths: number[] = [];
  private readonly deathScratch = { position: [0, 0, 0], velocity: [0, 0, 0] };
  // This tick's births at a pose other than its own, seeded after its pass (reused per tick).
  private readonly birthsElsewhere: FXDueBirth[] = [];

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
    worldMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
  };

  private readonly motionTracker = new FXObjectMotionTracker();

  private destroyed = false;

  /** @internal Use {@link FXEmitter.fromArtifacts}. */
  private constructor(
    driver: FXEmitterDriver,
    material: FXArtifactMaterial,
    options: Partial<FXEmitterOptions>,
    world: FXWorld,
    trail: FXTrail | undefined,
    limits: FXRenderBudget | undefined,
    trailLimitWarning: { warned: boolean },
  ) {
    super();
    this.world = world;
    this.limits = limits;
    this.trailLimitWarning = trailLimitWarning;
    this.driver = driver;
    this.artifactMaterial = material;
    this.trail = trail;

    // Every check that can throw comes first, before this emitter owns anything of its own (the
    // caller, fromArtifacts, releases the driver and trail it handed in).
    this.assertCanSpawn("FXEmitter.constructor");
    if (options.maxLifetime !== undefined) {
      assertValidNonNegativeNumber(
        options.maxLifetime,
        "FXEmitter.constructor.options.maxLifetime",
      );
    }
    this.maxLifetime = options.maxLifetime;
    this.sortCamera = options.sortCamera;
    this.sortFraction = EMITTER_DEFAULT_SORT_FRACTION;
    if (options.sortFraction !== undefined) {
      this.setSortFraction(options.sortFraction, "FXEmitter.constructor.options.sortFraction");
    }

    if (options.receiveShadow ?? EMITTER_DEFAULT_RECEIVE_SHADOW) {
      this.mesh.receiveShadow = true;
    }

    // Pay for the second (depth) ShaderMaterial only when a cast shadow is actually requested.
    // `castShadow`/`customDepthMaterial` are inherited Object3D members; `frustumCulled` is already
    // false on the mesh, so the shadow pass's frustum check is a no-op just like the color pass.
    if (options.castShadow ?? EMITTER_DEFAULT_CAST_SHADOW) {
      this.mesh.castShadow = true;
      this.mesh.customDepthMaterial = material.buildThreeDepthMaterial(this.driver.layout);
    }

    // The trail after the particles, as applyTrailArtifact attaches one (see FXTrail's doc).
    this.add(this.mesh);
    if (trail !== undefined) {
      this.add(trail.mesh);
    }
    this.world.registerObject(this);
  }

  /** Whether the emitter has nothing alive, drawn or scheduled, and skips its ticks until its next
   *  birth. */
  public get isSettled(): boolean {
    return this.settled && !this.hasScheduledBirths();
  }

  /** Exact live count for a JS-driven emitter; for a GPU-driven one, there is no CPU-visible live
   *  count to report - `capacity` is the honest upper bound reported instead. */
  public get particleCount(): number {
    return this.driver.particleCount;
  }

  /** The fixed ring size (`expectedCapacity`), the same on both backends - never grows. */
  public get particleCapacity(): number {
    return this.driver.particleCapacity;
  }

  /**
   * Particles lost to the fixed ring since this emitter was built: a birth overwrites the slot at
   * the cursor whether its particle is live or not, so this counts the live particles a birth
   * overwrote - each died early - plus births beyond capacity in a single burst. A capacity
   * diagnostic: nonzero means `expectedCapacity` is smaller than the spawn rate times the longest
   * lifetime (bursts included); a development build also warns once, on the first one. `undefined`
   * on a GPU-driven emitter, whose slot occupancy is not visible to the CPU (its ring overwrites
   * the same way).
   */
  public get particleOverflowCount(): number | undefined {
    return this.driver.particleOverflowCount;
  }

  /** Whether {@link onParticleDeath} works here: a CPU-driven emitter's particles' deaths are seen,
   *  a GPU-driven one's never leave the GPU. */
  public get reportsParticleDeaths(): boolean {
    return this.driver.reportsDeaths;
  }

  /**
   * Whether this emitter draws a trail behind its particles - not one it was given but skipped,
   * past what the renderer's GPU offers (see {@link fromArtifacts}).
   */
  public get hasTrail(): boolean {
    return this.trail !== undefined;
  }

  // The active driver's own mesh - a thin passthrough, not a second source of truth (this.driver.mesh
  // is authoritative; nothing caches or duplicates it here).
  private get mesh(): Mesh {
    return this.driver.mesh;
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
    const capacity = options.expectedCapacity ?? EMITTER_DEFAULT_EXPECTED_CAPACITY;
    // The fixed ring size on both backends, checked in every build (once per emitter, never per
    // frame): zero would wrap the cursor to NaN, and a fractional length is a RangeError far
    // from its cause.
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(
        `FXEmitter.fromArtifacts.options.expectedCapacity: expected an integer >= 1, got ${String(capacity)}`,
      );
    }

    const material = new FXArtifactMaterial(render, options.textures);
    const baseGeometry = resolveGeometrySource(render.geometry, options.geometries ?? {});

    // The one place this emitter's backend is chosen, ever (never switched mid-playback). A real
    // driver-level failure (program link, buffer/VAO setup) despite "Try GPU simulation" having
    // compiled and the live render tier already being "standard" falls back to the mandatory JS
    // artifact in place, no reload loop, matching the editor's sceneCoordinator.ts own forced-
    // WebGL1-creation-failure fallback shape on the render side.
    let driver: FXEmitterDriver | undefined;
    if (options.gpuKernel !== undefined && options.renderer !== undefined) {
      try {
        driver = new FXGPUEmitterDriver(
          options.gpuKernel,
          options.renderer,
          material,
          capacity,
          baseGeometry,
        );
      } catch (error) {
        console.warn(
          "FXEmitter: GPU (transform-feedback) behavior setup failed at runtime; falling back " +
            "to the JS behavior artifact for this emitter.",
          error,
        );
      }
    }
    driver ??= new FXJSEmitterDriver(behavior, material, capacity, baseGeometry);

    // Everything built so far owns GPU resources: a throw from here on releases them.
    const limits = deviceLimits(options.renderer);
    const trailLimitWarning = { warned: false };
    let trail: FXTrail | undefined;
    try {
      if (options.trail !== undefined) {
        trail = FXEmitter.buildTrail(
          driver,
          options.trail,
          options.textures,
          limits,
          trailLimitWarning,
        );
      }
      return new FXEmitter(driver, material, options, world, trail, limits, trailLimitWarning);
    } catch (error) {
      trail?.destroy();
      driver.destroy();
      throw error;
    }
  }

  /**
   * Builds a trail, or skips it (`undefined`, with a warning once per emitter) when its material
   * takes more of any resource than `limits` - attributes, varying vectors, uniform vectors or
   * texture units of a stage: a program past them fails to link, so the trail would never draw
   * anyway, and the particles still do without it.
   */
  private static buildTrail(
    driver: FXEmitterDriver,
    options: FXTrailOptions,
    textures: FXFromArtifactsOptions["textures"],
    limits: FXRenderBudget | undefined,
    warning: { warned: boolean },
  ): FXTrail | undefined {
    assertValidTrailOptions(options, "FXEmitter.fromArtifacts.options.trail");
    const history = driver.createTrailHistory(trailReadFields(options.render), options.frames);
    let trail: FXTrail;
    try {
      trail = new FXTrail(history, options, textures);
    } catch (error) {
      history.destroy();
      throw error;
    }
    const overruns = limits === undefined ? [] : fxBudgetOverruns(trail.budget, limits);
    if (overruns.length > 0) {
      trail.destroy();
      if (!warning.warned) {
        warning.warned = true;
        const needs = overruns.map(
          (overrun) =>
            `${String(overrun.used)} ${overrun.resource} (the GPU offers ${String(overrun.limit)})`,
        );
        console.warn(`FXEmitter: the trail is skipped - its material needs ${needs.join(", ")}.`);
      }
      return undefined;
    }
    return trail;
  }

  /**
   * @internal Ticks this emitter one frame. Driven by {@link FXWorld.update}, which advances the
   * shared clock once and passes it in as `elapsedTime`.
   */
  public onWorldTick(deltaTime: number, elapsedTime: number): void {
    this.onRendering(deltaTime);
    // The pose the tick sampled (see worldTransform): the particles' mesh's, and the trail's own.
    this.advanceMaterial(
      this.artifactMaterial,
      deltaTime,
      elapsedTime,
      this.emitterTransform.worldMatrix,
    );
    if (this.trail !== undefined) {
      // Its parents' matrices are this tick's already (the tick sampled the emitter's motion).
      this.trail.mesh.updateWorldMatrix(false, false);
      this.advanceMaterial(
        this.trail.artifactMaterial,
        deltaTime,
        elapsedTime,
        this.trail.mesh.matrixWorld.elements,
      );
    }
  }

  /** Unregisters, removes from the scene, disposes mesh and material. Idempotent. */
  public destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;

    this.world.unregisterObject(this);

    // Drop scheduled work so nothing references the driver's buffers after teardown.
    this.pendingBursts.length = 0;
    this.activePlays.length = 0;
    this.dueBirths.length = 0;
    this.deathListeners.clear();
    this.pendingDeaths.length = 0;
    this.dispatchingDeaths.length = 0;

    // The material owns no per-emitter GPU resources; the driver teardown disposes the instanced
    // geometry and the mounted material (plus, for a GPU-driven emitter, the compiled program+VAO)
    // - not the depth material, which this emitter built and so releases itself.
    this.mesh.customDepthMaterial?.dispose();
    this.mesh.customDepthMaterial = undefined;
    this.artifactMaterial.destroy();
    this.trail?.destroy();
    this.trail = undefined;
    this.driver.destroy();

    this.removeFromParent();
  }

  /**
   * Spawns `count` particles on this emitter's next tick, or after `options.delay`. Every birth is
   * seeded in a tick, after its update: a newborn is not updated in the tick it is born in, on
   * either backend. An undelayed burst spawns from this emitter's pose at the moment of the call -
   * so moving the emitter between two bursts of one frame spawns them in two places - or from
   * `options.origin`; parameter values are those of the tick. A delayed burst spawns from the pose
   * of the tick it expires on, or from its origin.
   * @returns Handler for {@link stop} to cancel a pending delayed burst.
   */
  public burst(count: number, options: Partial<FXEmitterBurstOptions> = {}): number {
    // Whole particles only: a fractional count sets a fractional `instanceCount`.
    assertValidPositiveInteger(count, "FXEmitter.burst.count");
    this.assertCanSpawn("FXEmitter.burst");
    const delay = options.delay ?? 0;
    assertValidNonNegativeNumber(delay, "FXEmitter.burst.options.delay");
    if (options.origin !== undefined) {
      assertValidOrigin(options.origin, "FXEmitter.burst.options.origin");
    }
    if (this.destroyed) {
      return DEAD_HANDLER;
    }
    const handler = this.nextHandler++;
    const origin = options.origin === undefined ? undefined : this.originTransform(options.origin);

    if (delay <= 0) {
      this.dueBirths.push({
        count,
        matrix: origin === undefined ? [...this.worldTransform().worldMatrix] : undefined,
        origin,
      });
    } else {
      this.pendingBursts.push({ handler, count, delay, origin });
    }

    return handler;
  }

  /**
   * Starts continuous emission at `rate` particles per second, or per world unit the emitter
   * travels (`options.over`), from this emitter's pose as each tick finds it, or from
   * `options.origin` for the whole play.
   * @returns Handler for {@link stop} to cancel.
   */
  public play(rate: number, options: Partial<FXEmitterPlayOptions> = {}): number {
    assertValidPositiveNumber(rate, "FXEmitter.play.rate");
    if (options.delay !== undefined) {
      assertValidNonNegativeNumber(options.delay, "FXEmitter.play.options.delay");
    }
    // Checked at runtime too: a plain-JS host can pass any string.
    const over = asEmissionBasis(options.over ?? "time");
    if (over === undefined) {
      throw new Error(
        `FXEmitter.play.options.over: expected one of ${FX_EMISSION_BASES.map((basis) => `"${basis}"`).join(", ")}`,
      );
    }
    if (options.origin !== undefined) {
      if (over === "distance") {
        throw new Error(
          "FXEmitter.play: a play over distance follows the emitter's pose, so it takes no origin",
        );
      }
      assertValidOrigin(options.origin, "FXEmitter.play.options.origin");
    }
    this.assertCanSpawn("FXEmitter.play");
    if (this.destroyed) {
      return DEAD_HANDLER;
    }
    const handler = this.nextHandler++;

    this.activePlays.push({
      handler,
      rate,
      over,
      duration: options.duration ?? Infinity,
      elapsed: 0,
      accumulator: 0,
      delay: options.delay ?? 0,
      origin: options.origin === undefined ? undefined : this.originTransform(options.origin),
    });

    return handler;
  }

  /**
   * Calls `listener` for each of this emitter's particles that dies - of age, or killed by its
   * behavior's update (`kill`) - once per death, after every emitter of this world has ticked (so
   * a listener spawning elsewhere does it the same way whatever order the emitters tick in: the
   * births land on the next tick). A particle a birth
   * overwrites in a full ring, or one {@link reset} clears, does not die; nor do the particles of
   * {@link prewarm}. Watching costs a copy of the particle positions per tick while any listener
   * is attached.
   * @returns Detaches `listener`.
   * @throws On a GPU-driven emitter (see {@link reportsParticleDeaths}): its particles' ages live
   *   on the GPU, and reading them back would stall the pipeline. Build a death source without a
   *   GPU kernel.
   */
  public onParticleDeath(listener: FXParticleDeathListener): () => void {
    if (!this.driver.reportsDeaths) {
      throw new Error(
        "FXEmitter.onParticleDeath: a GPU-driven emitter cannot report its particles' deaths - " +
          "build it without a gpuKernel",
      );
    }
    if (this.destroyed) {
      return NO_OP;
    }
    this.deathListeners.add(listener);
    if (this.deathListeners.size === 1) {
      this.driver.watchDeaths(this.recordDeath);
    }
    return (): void => {
      // Deaths already queued are still handed to the listeners attached when they are (the
      // dispatch snapshots them); with none left, nothing new is queued.
      if (this.deathListeners.delete(listener) && this.deathListeners.size === 0) {
        this.driver.watchDeaths(undefined);
      }
    };
  }

  /**
   * @internal Hands this tick's deaths to the {@link onParticleDeath} listeners. Driven by
   * {@link FXWorld.update} after every object of the world ticked.
   */
  public afterWorldTick(): void {
    if (this.pendingDeaths.length === 0) {
      return;
    }
    const deaths = this.pendingDeaths;
    this.pendingDeaths = this.dispatchingDeaths;
    this.dispatchingDeaths = deaths;
    // A snapshot: a listener may detach itself (or another). Re-reading the length: a listener may
    // reset this emitter, which drops the deaths not handed out yet.
    const listeners = [...this.deathListeners];
    const death = this.deathScratch;
    try {
      for (let offset = 0; offset < deaths.length; offset += DEATH_STRIDE) {
        death.position[0] = deaths[offset];
        death.position[1] = deaths[offset + 1];
        death.position[2] = deaths[offset + 2];
        death.velocity[0] = deaths[offset + 3];
        death.velocity[1] = deaths[offset + 4];
        death.velocity[2] = deaths[offset + 5];
        for (const listener of listeners) {
          listener(death);
        }
      }
    } finally {
      deaths.length = 0;
    }
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
    // An undelayed burst is due already (dueBirths): there is nothing left of it to cancel.

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

    try {
      while (remaining > 0) {
        const deltaTime = Math.min(remaining, step);
        this.tick(deltaTime);
        remaining -= deltaTime;
      }
    } finally {
      // Outside the world's tick, so its reset is this call's to make.
      flushStateResets();
    }
    // Deaths of a simulated past are not events: nothing should spawn where they happened.
    this.pendingDeaths.length = 0;
  }

  /**
   * Kills all live particles and cancels all active plays and pending bursts. Until the next birth
   * the emitter then has nothing to simulate, and skips its ticks.
   */
  public reset(): void {
    if (this.destroyed) {
      return;
    }
    this.pendingBursts.length = 0;
    this.activePlays.length = 0;
    this.dueBirths.length = 0;
    this.pendingDeaths.length = 0;
    this.dispatchingDeaths.length = 0;
    this.settle();
    // A restarted effect should not report a teleport spike from wherever the emitter was last
    // posed - drop the velocity/angular-velocity baseline along with the particles.
    this.motionTracker.reset();
  }

  /**
   * For a timeline that loops back to its start - {@link FXEffect}'s own, or a tool's that drives
   * the emitter itself: cancels the active plays and pending bursts that follow this emitter's
   * pose, and forgets the motion baseline - the pose jumps from the lap's end to its start, which
   * is no motion - but leaves live particles to finish their lives, so the loop runs on seamlessly
   * (unlike {@link reset}, which clears them). Bursts already due, and plays and bursts at an
   * origin, do not depend on the emitter's pose and run on as well.
   */
  public loopTimeline(): void {
    if (this.destroyed) {
      return;
    }
    removeWhere(this.pendingBursts, (pending) => pending.origin === undefined);
    removeWhere(this.activePlays, (play) => play.origin === undefined);
    this.motionTracker.reset();
  }

  /**
   * Scrubs live parameter values into uniform/binding slots by name, picked up next frame - the
   * runtime's value channel for a non-structural edit. Unknown name = safe no-op; never recompiles.
   * A structural edit is instead a fresh {@link fromArtifacts} (the editor decides which).
   * @throws When an external texture is of a variant its slot was not built with (see
   * {@link FXExternalTexture}); the particles, the trail and the values a later trail starts from
   * are then all left as they were.
   */
  public applyValues(values: FXApplyValues): void {
    if (this.destroyed) {
      return;
    }
    const { uniforms, particleMaterial, trailMaterial } = values;
    // Both materials checked before either changes, and before the parameters are kept for a
    // later swap: a rejected edit must not leave the trail out of step or poison a swap.
    for (const own of [uniforms, particleMaterial]) {
      if (own !== undefined) {
        this.artifactMaterial.assertUniformValues(own);
      }
    }
    for (const own of [uniforms, trailMaterial]) {
      if (own !== undefined) {
        this.trail?.artifactMaterial.assertUniformValues(own);
      }
    }
    if (uniforms !== undefined) {
      Object.assign(this.appliedUniforms, uniforms);
      // One parameter namespace per emitter: a name the trail graph declares too drives both.
      this.artifactMaterial.applyUniformValues(uniforms);
      this.trail?.artifactMaterial.applyUniformValues(uniforms);
    }
    if (particleMaterial !== undefined) {
      this.artifactMaterial.applyUniformValues(particleMaterial);
    }
    if (trailMaterial !== undefined) {
      this.trail?.artifactMaterial.applyUniformValues(trailMaterial);
    }
    if (values.bindings !== undefined) {
      this.driver.applyBindingValues(values.bindings);
    }
  }

  /**
   * Swaps only this emitter's render half in place - a new shader, geometry primitive/mesh, or
   * shadow flags - leaving the behavior driver, particle buffers, instance count, and playback
   * schedule completely untouched (unlike a structural edit that reaches {@link fromArtifacts},
   * this never resets a running effect). The editor calls this instead of rebuilding whenever a
   * graph edit only changed the render half.
   *
   * The buffers depend on the behavior alone, so a render reading an attribute nothing writes
   * still applies in place (it reads as zero, with no buffer - see `particleLayout`).
   *
   * @throws If the new render artifact reads an attribute at another width than this emitter's
   * behavior writes it (see {@link FXEmitterDriver.applyRenderArtifact}). This emitter is left
   * exactly as it was before the call in that case.
   */
  public applyRenderArtifact(
    render: FXRenderArtifact,
    options: FXApplyRenderArtifactOptions = {},
  ): void {
    if (this.destroyed) {
      return;
    }
    const material = new FXArtifactMaterial(render, options.textures);
    this.carryParameters(material, render);
    const baseGeometry = resolveGeometrySource(render.geometry, options.geometries ?? {});
    // Throws (leaving this emitter untouched) before anything below mutates it - see this
    // method's own @throws doc.
    this.driver.applyRenderArtifact(material, baseGeometry);
    this.artifactMaterial = material;

    this.mesh.receiveShadow = options.receiveShadow ?? EMITTER_DEFAULT_RECEIVE_SHADOW;
    const previousDepthMaterial = this.mesh.customDepthMaterial;
    if (options.castShadow ?? EMITTER_DEFAULT_CAST_SHADOW) {
      this.mesh.castShadow = true;
      this.mesh.customDepthMaterial = material.buildThreeDepthMaterial(this.driver.layout);
    } else {
      this.mesh.castShadow = false;
      this.mesh.customDepthMaterial = undefined;
    }
    previousDepthMaterial?.dispose();
  }

  /**
   * Replaces this emitter's trail - or removes it (`undefined`) - leaving the particles, their
   * simulation and the playback schedule untouched. The new trail starts empty and fills in from
   * the next tick on, with every uniform value {@link applyValues} has set on this emitter (those
   * the new trail graph declares) carried over - a driven parameter keeps its value across the
   * swap, as the particle material's does (see {@link applyRenderArtifact}). For tooling (the
   * editor swaps the trail on a trail-graph edit); an exported effect builds its trail once in
   * {@link fromArtifacts}.
   * @throws When the new trail cannot be built; the current trail is then left in place.
   */
  public applyTrailArtifact(
    options: FXTrailOptions | undefined,
    textures: FXFromArtifactsOptions["textures"] = {},
  ): void {
    if (this.destroyed) {
      return;
    }
    // Built and started first: a throw leaves the current trail in place.
    let next: FXTrail | undefined;
    if (options !== undefined) {
      next = FXEmitter.buildTrail(
        this.driver,
        options,
        textures,
        this.limits,
        this.trailLimitWarning,
      );
      try {
        if (next !== undefined) {
          this.carryParameters(next.artifactMaterial, options.render);
        }
      } catch (error) {
        next?.destroy();
        throw error;
      }
    }
    this.trail?.destroy();
    this.trail = next;
    if (next !== undefined) {
      this.add(next.mesh);
    }
  }

  /**
   * Starts `material`, swapped in for `render`, from the parameters this emitter is driven with,
   * not the artifact's: a driven parameter keeps its value across the swap. Not its external
   * textures: the swap binds those afresh, and an older value of another variant (a region where a
   * whole texture is bound now) could not even be written.
   */
  private carryParameters(material: FXArtifactMaterial, render: FXRenderArtifact): void {
    material.applyUniformValues(withoutExternalUniforms(render, this.appliedUniforms));
  }

  /** This tick's draw inputs for one of this emitter's materials, drawn with `modelMatrix`. */
  private advanceMaterial(
    material: FXArtifactMaterial,
    deltaTime: number,
    elapsedTime: number,
    modelMatrix: ArrayLike<number>,
  ): void {
    const frame = this.drawFrame;
    frame.time = elapsedTime;
    frame.deltaTime = deltaTime;
    frame.modelMatrix = modelMatrix;
    // emitterTransform.velocity/angularVelocity are always length 3 (see its declaration) -
    // computed once per tick in onRendering -> tick.
    frame.objectVelocity = this.emitterTransform.velocity as [number, number, number];
    frame.objectAngularVelocity = this.emitterTransform.angularVelocity as [number, number, number];
    material.advance(frame);
  }

  private setSortFraction(value: number, context: string): void {
    assertValidNonNegativeNumber(value, context);
    // Clamp to [0, 1]: a value > 1 would grow `sortingAccumulator` without bound.
    this.sortFraction = Math.min(value, 1);
  }

  // Throws when the behavior artifact cannot seed births. Checked at the scheduling points, NOT in
  // the frame tick - a throw from the world tick would take the host's render loop down.
  private assertCanSpawn(context: string): void {
    if (!this.driver.canSpawn) {
      throw new Error(`${context}: this behavior artifact cannot seed births (update-only)`);
    }
  }

  // The emitter's world matrix as the reused snapshot the kernel reads: the mesh's `matrixWorld`,
  // the pose a graph places its particles by. `Matrix4.elements` is already column-major.
  private worldTransform(): FXEmitterTransform {
    this.mesh.updateWorldMatrix(true, false);
    return this.copyWorldMatrix();
  }

  // worldTransform without updating `matrixWorld`: for a caller that just did.
  private copyWorldMatrix(): FXEmitterTransform {
    const world = this.mesh.matrixWorld.elements;
    const transform = this.emitterTransform;
    for (let i = 0; i < 16; i += 1) {
      transform.worldMatrix[i] = world[i];
    }
    return transform;
  }

  private tick(deltaTime: number): void {
    // World-space velocity/angular velocity since the previous tick, computed once here and not
    // inside worldTransform() - the burst/play loops below and the update phase can each call
    // worldTransform() several times this tick, and diffing per-call instead of per-tick would
    // corrupt the value on a frame with more than one of those (each call would diff against a
    // baseline the previous call already advanced).
    const motion = sampleObjectMotion(this.motionTracker, this.mesh, deltaTime);
    this.emitterTransform.velocity[0] = motion.velocity[0];
    this.emitterTransform.velocity[1] = motion.velocity[1];
    this.emitterTransform.velocity[2] = motion.velocity[2];
    this.emitterTransform.angularVelocity[0] = motion.angularVelocity[0];
    this.emitterTransform.angularVelocity[1] = motion.angularVelocity[1];
    this.emitterTransform.angularVelocity[2] = motion.angularVelocity[2];
    // Sampling the motion updated `matrixWorld`; a settled emitter's draw stage reads the pose too.
    const transform = this.copyWorldMatrix();

    if (this.isSettled) {
      return;
    }

    // Paused (dt == 0): skip the simulation step entirely - no JS age/kernel update, no GPU
    // transform-feedback dispatch, no schedule advance - the emitter keeps rendering whatever
    // particle state the last active tick left behind. Births already due still land, each seeded
    // on its own outside a tick (a host's burst while paused shows at once).
    if (deltaTime <= 0) {
      for (const birth of this.dueBirths) {
        this.seed(birth.count, poseOf(birth, transform));
      }
      this.dueBirths.length = 0;
      return;
    }

    this.sinceLastBirth += deltaTime;

    // One order on both backends: update, then the births at this tick's pose (on the GPU, one
    // range of the tick's single pass), then every birth at another pose (one GPU pass each) -
    // so the two number their particles alike, and no newborn is updated in its own tick.
    this.driver.beginTick(deltaTime, transform);
    const elsewhere = this.birthsElsewhere;

    for (const birth of this.dueBirths) {
      if (birth.matrix !== undefined && sameMatrix(birth.matrix, transform.worldMatrix)) {
        this.seed(birth.count, transform);
      } else {
        elsewhere.push(birth);
      }
    }
    this.dueBirths.length = 0;

    for (let i = this.pendingBursts.length - 1; i >= 0; i--) {
      const pending = this.pendingBursts[i];
      pending.delay -= deltaTime;

      if (pending.delay <= 0) {
        this.pendingBursts.splice(i, 1);
        this.spawnScheduled(pending.count, pending.origin, transform);
      }
    }

    // The distance the emitter's world position travels per second this tick, for plays over
    // distance: the motion sampled above, so a reset or a loop's jump counts as no travel.
    const velocity = this.emitterTransform.velocity;
    const speed = Math.hypot(velocity[0], velocity[1], velocity[2]);

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
      play.accumulator +=
        play.rate * (play.over === "distance" ? speed * emitDeltaTime : emitDeltaTime);
      const particlesToSpawn = Math.floor(play.accumulator);

      if (particlesToSpawn > 0) {
        this.spawnScheduled(particlesToSpawn, play.origin, transform);
        play.accumulator -= particlesToSpawn;
      }

      if (expired) {
        this.activePlays.splice(i, 1);
      }
    }

    this.driver.endTick(deltaTime, transform);
    for (const birth of elsewhere) {
      this.seed(birth.count, poseOf(birth, transform));
    }
    elsewhere.length = 0;
    this.trail?.record(deltaTime);
    if (this.diedOut(deltaTime)) {
      this.settle();
    }
  }

  private seed(count: number, transform: FXEmitterTransform): void {
    this.settled = false;
    this.sinceLastBirth = 0;
    this.driver.spawn(count, transform);
  }

  private hasScheduledBirths(): boolean {
    return (
      this.dueBirths.length > 0 || this.pendingBursts.length > 0 || this.activePlays.length > 0
    );
  }

  // Every particle was already past `maxLifetime` a tick ago - a whole tick, so a float32 age that
  // rounded short of its lifetime is dead too - with nothing due to be born, and every point the
  // trail still draws was recorded after that: settling now cuts nothing visible.
  private diedOut(deltaTime: number): boolean {
    if (this.settled || this.maxLifetime === undefined || this.hasScheduledBirths()) {
      return false;
    }
    const sinceDeath = this.sinceLastBirth - deltaTime - this.maxLifetime;
    return sinceDeath >= 0 && (this.trail === undefined || this.trail.oldestPointAge <= sinceDeath);
  }

  // Deaths already found stay queued for afterWorldTick: settling is no death of its own.
  private settle(): void {
    this.driver.reset();
    this.trail?.reset();
    this.settled = true;
  }

  // A scheduled spawn (a delayed burst expiring, a play's accumulator) inside a tick: at the
  // tick's pose right away, or at its origin after the tick's pass.
  private spawnScheduled(
    count: number,
    origin: FXEmitterTransform | undefined,
    transform: FXEmitterTransform,
  ): void {
    if (origin === undefined) {
      this.seed(count, transform);
    } else {
      this.birthsElsewhere.push({ count, matrix: undefined, origin });
    }
  }

  // The pose a birth at `origin` spawns from: this emitter's, moved to the origin's position, with
  // the origin's velocity and no spin.
  private originTransform(origin: FXSpawnOrigin): FXEmitterTransform {
    const worldMatrix = [...this.worldTransform().worldMatrix];
    worldMatrix[12] = origin.position[0];
    worldMatrix[13] = origin.position[1];
    worldMatrix[14] = origin.position[2];
    const velocity = origin.velocity ?? ZERO_VECTOR;
    return {
      worldMatrix,
      velocity: [velocity[0], velocity[1], velocity[2]],
      angularVelocity: [0, 0, 0],
    };
  }

  // The driver's death sink: queues one death for afterWorldTick.
  private readonly recordDeath: FXParticleDeathSink = (
    positionX,
    positionY,
    positionZ,
    velocityX,
    velocityY,
    velocityZ,
  ) => {
    this.pendingDeaths.push(positionX, positionY, positionZ, velocityX, velocityY, velocityZ);
  };

  private readonly onRendering = (deltaTime: number): void => {
    this.tick(deltaTime);

    if (this.sortCamera === undefined) {
      return;
    }
    if (this.trail !== undefined) {
      // A sort moves particles between slots, and a trail's history is per slot - the editor
      // never exports the two together, so this is a host setting sortCamera by hand.
      if (!this.warnedAboutTrailSorting) {
        this.warnedAboutTrailSorting = true;
        console.warn(
          "FXEmitter: sortCamera has no effect on an emitter with a trail - sorting would " +
            "scramble the recorded particle paths.",
        );
      }
      return;
    }
    // `sortFraction` is public, so clamp here too: a direct assignment above 1 would grow the accumulator unbounded.
    this.sortingAccumulator += Math.min(Math.max(this.sortFraction, 0), 1);

    if (this.sortingAccumulator >= 1) {
      this.sortingAccumulator -= 1;
      this.sortCamera.getWorldPosition(this.sortingCameraWorldPosition);
      this.driver.sortByDistance(this.sortingCameraWorldPosition);
    }
  };
}

// Returned by post-destroy `burst`/`play` - never matches a scheduled handler.
const DEAD_HANDLER = -1;

// Returned by `onParticleDeath` on a destroyed emitter.
const NO_OP = (): void => undefined;

// Numbers per queued death: position xyz, velocity xyz.
const DEATH_STRIDE = 6;

const ZERO_VECTOR: readonly number[] = [0, 0, 0];

/** A birth that is due: `count` particles from the emitter's pose at the call (`matrix`, the tick
 *  supplies its motion), or from a full pose at an origin. */
interface FXDueBirth {
  readonly count: number;
  readonly matrix: readonly number[] | undefined;
  readonly origin: FXEmitterTransform | undefined;
}

function poseOf(birth: FXDueBirth, tick: FXEmitterTransform): FXEmitterTransform {
  if (birth.origin !== undefined) {
    return birth.origin;
  }
  return {
    worldMatrix: birth.matrix ?? tick.worldMatrix,
    velocity: tick.velocity,
    angularVelocity: tick.angularVelocity,
  };
}

function sameMatrix(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < 16; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function removeWhere<T>(items: T[], predicate: (item: T) => boolean): void {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (predicate(items[i])) {
      items.splice(i, 1);
    }
  }
}

function assertValidOrigin(origin: FXSpawnOrigin, subject: string): void {
  for (const [name, vector] of [
    ["position", origin.position],
    ["velocity", origin.velocity ?? ZERO_VECTOR],
  ] as const) {
    if (vector.length !== 3) {
      throw new Error(`${subject}.${name}: expected [x, y, z]`);
    }
    for (const component of vector) {
      assertValidNumber(component, `${subject}.${name}`);
    }
  }
}

/**
 * What `renderer`'s GPU offers a material, resource by resource (see {@link FXRenderBudget}), or
 * `undefined` without a renderer - nothing is checked then. A resource the renderer (or a
 * stand-in) does not report is not checked either.
 */
function deviceLimits(renderer: WebGLRenderer | undefined): FXRenderBudget | undefined {
  if (renderer === undefined) {
    return undefined;
  }
  const capabilities = renderer.capabilities as unknown as Record<string, unknown>;
  const limit = (name: string): number => {
    const value = capabilities[name];
    return typeof value === "number" ? value : Number.POSITIVE_INFINITY;
  };
  return {
    attributes: limit("maxAttributes"),
    varyingVectors: limit("maxVaryings"),
    vertexUniformVectors: limit("maxVertexUniforms"),
    fragmentUniformVectors: limit("maxFragmentUniforms"),
    vertexSamplers: limit("maxVertexTextures"),
    fragmentSamplers: limit("maxTextures"),
  };
}

/** `values` less those `render` binds to an external texture. */
function withoutExternalUniforms(
  render: FXRenderArtifact,
  values: Readonly<Record<string, FXUniformValue>>,
): Record<string, FXUniformValue> {
  const kept: Record<string, FXUniformValue> = {};
  for (const name in values) {
    const uniform = render.uniforms[name] as FXRenderArtifact["uniforms"][string] | undefined;
    if (uniform === undefined || !("external" in uniform)) {
      kept[name] = values[name];
    }
  }
  return kept;
}

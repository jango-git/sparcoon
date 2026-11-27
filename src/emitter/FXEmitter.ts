import type { Camera, Mesh, WebGLRenderer } from "three";
import { Object3D, Vector3 } from "three";

import type {
  FXBehaviorArtifact,
  FXEmitterTransform,
  FXParticleKernelArtifact,
  FXRenderArtifact,
} from "../artifact/FXArtifact.js";
import type { FXSlotLayout } from "../instancedParticle/FXParticleSlot.js";
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
import type { FXRenderBudget } from "../render/FXRenderBudget.js";
import { FXEmitterStrips } from "../strip/FXEmitterStrips.Internal.js";
import type { FXStripBirth } from "../strip/FXStrip.Internal.js";
import { FX_STRIP_KINDS, type FXStripKind, type FXStripOptions } from "../strip/FXStripOptions.js";
import { FXWorld } from "../world/FXWorld.js";
import type { FXApplyRenderArtifactOptions } from "./FXApplyRenderArtifactOptions.js";
import type { FXBirthAges } from "./FXBirthAges.Internal.js";
import { playBirthAges, spreadBirthAges } from "./FXBirthAges.Internal.js";
import { FXCameraView } from "./FXCameraView.Internal.js";
import type {
  FXApplyValues,
  FXEmissionBasis,
  FXEmitterBurstOptions,
  FXEmitterOptions,
  FXEmitterPlayOptions,
  FXEmitterSort,
  FXEmitterSortOptions,
  FXParticleEventKind,
  FXParticleEventListener,
  FXSpawnOrigin,
} from "./FXEmitter.Internal.js";
import {
  asEmissionBasis,
  asParticleEventKind,
  EMITTER_DEFAULT_CAST_SHADOW,
  EMITTER_DEFAULT_EXPECTED_CAPACITY,
  EMITTER_DEFAULT_PREWARM_MAX_STEP_COUNT,
  EMITTER_DEFAULT_PREWARM_MIN_STEP_DURATION,
  EMITTER_DEFAULT_RECEIVE_SHADOW,
  EMITTER_DEFAULT_SORT_FRACTION,
  FX_EMISSION_BASES,
  FX_PARTICLE_EVENT_KINDS,
} from "./FXEmitter.Internal.js";
import type { FXEmitterDriver, FXParticleDraw } from "./FXEmitterDriver.Internal.js";
import type { FXAppAssets, FXFromArtifactsOptions } from "./FXFromArtifactsOptions.js";
import { FXGPUEmitterDriver } from "./FXGPUEmitterDriver.Internal.js";
import { assertValidInherited, inheritDefaultsOf } from "./FXInheritance.js";
import { FXJSEmitterDriver } from "./FXJSEmitterDriver.Internal.js";
import { kernelResourcesOf } from "./FXKernelResources.Internal.js";
import type { FXLinkedProgram } from "./FXLinkedProgram.Internal.js";
import { FXObjectMotionTracker } from "./FXObjectMotion.Internal.js";
import { sampleObjectMotion } from "./FXObjectMotionSample.Internal.js";
import { FXParticleEventChannel } from "./FXParticleEventChannel.Internal.js";

/**
 * A particle emitter: one instanced draw. A behavior artifact simulates the particles and a render
 * artifact draws them (optional, an emitter may draw only a strip). Built and ticked by {@link
 * FXEffect}, reached through {@link FXEffect.getEmitter}.
 *
 * A facade over one {@link FXEmitterDriver}, JS or GPU, chosen once by {@link fromArtifacts}. It
 * owns the backend-independent parts: scheduling, the births queue, event listeners, sort timing,
 * motion tracking and the material. Its strips (a trail, a ribbon, each with its own material) are
 * an `FXEmitterStrips`. The material and each strip can be replaced in place with {@link
 * applyRenderArtifact} and {@link applyStripArtifact}.
 */
export class FXEmitter extends Object3D {
  /** The camera this emitter sorts from and reads the scene depth of (see
   *  {@link FXEmitterOptions.camera}). Without one it keeps its last order and reads no depth. */
  public camera: Camera | undefined;
  /** How this emitter sorts its particles back to front; `undefined` when it was built without
   *  `sort` (see {@link FXEmitterOptions.sort}). */
  public readonly sort: FXEmitterSort | undefined;

  private readonly world: FXWorld;
  private readonly driver: FXEmitterDriver;
  // The view of `camera` its GPU kernel reads the scene depth through; `undefined` when it reads
  // none.
  private readonly cameraView: FXCameraView | undefined;
  // Not readonly: applyRenderArtifact replaces it wholesale on a successful render-only swap.
  // Never name this `material`: `private` exists only in TypeScript, and three treats any object
  // in the scene with a truthy `.material` as drawable - `renderer.compile()` would try to build a
  // program for this non-three material on an object with no geometry, and crash.
  // `undefined` while the emitter does not draw its particles.
  private artifactMaterial: FXArtifactMaterial | undefined;
  // The optional strips through the particles; each replaced wholesale by applyStripArtifact.
  private readonly strips: FXEmitterStrips;
  // The last value applyValues set per parameter, for a material swapped in later
  // (applyRenderArtifact, applyStripArtifact) to start from the values its parameters are being
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
    origin: FXBirthOrigin | undefined;
  }[] = [];
  private readonly activePlays: {
    handler: number;
    rate: number;
    over: FXEmissionBasis;
    duration: number;
    elapsed: number;
    accumulator: number;
    delay: number;
    origin: FXBirthOrigin | undefined;
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

  // What a birth no reaction spawned inherits (see FXInheritLayout).
  private readonly defaultInherited: Float32Array;

  // Each kind of particle event: its listeners, and the events ticks found, handed out after the
  // whole world ticked (afterWorldTick).
  private readonly events: Readonly<Record<FXParticleEventKind, FXParticleEventChannel>>;
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

  // What each tick hands its strips, filled in place: a birth from this emitter's pose is always
  // from its transform, with what a play's births inherit.
  private readonly stripFrame: { deltaTime: number; birth: FXStripBirth | undefined } = {
    deltaTime: 0,
    birth: undefined,
  };
  private readonly stripBirth: FXStripBirth;

  private destroyed = false;

  /** @internal Use {@link FXEmitter.fromArtifacts}. */
  private constructor(
    driver: FXEmitterDriver,
    material: FXArtifactMaterial | undefined,
    options: Partial<FXEmitterOptions>,
    world: FXWorld,
    limits: FXRenderBudget | undefined,
    defaultInherited: Float32Array,
    cameraView: FXCameraView | undefined,
  ) {
    super();
    this.world = world;
    this.cameraView = cameraView;
    this.defaultInherited = defaultInherited;
    this.stripBirth = { transform: this.emitterTransform, inherited: defaultInherited };
    const channel = (kind: FXParticleEventKind): FXParticleEventChannel =>
      new FXParticleEventChannel(driver.slot, (sink) => {
        driver.watch(kind, sink);
      });
    this.events = { birth: channel("birth"), death: channel("death") };
    this.driver = driver;
    this.artifactMaterial = material;
    this.strips = new FXEmitterStrips(this, driver, limits);

    // Every check that can throw comes first, before this emitter owns anything of its own (the
    // caller, fromArtifacts, releases the driver it handed in).
    this.assertCanSpawn("FXEmitter.constructor");
    if (options.maxLifetime !== undefined) {
      assertValidNonNegativeNumber(
        options.maxLifetime,
        "FXEmitter.constructor.options.maxLifetime",
      );
    }
    this.maxLifetime = options.maxLifetime;
    this.camera = options.camera;
    this.sort = options.sort === undefined ? undefined : sortOf(options.sort);

    this.applyShadows(options);

    // The strips go after the particles (see FXEmitterStrips).
    this.add(this.mesh);
    this.world.registerObject(this);
  }

  /** Whether the emitter has nothing alive, drawn or scheduled, and skips its ticks until its next
   *  birth. */
  public get isSettled(): boolean {
    return this.settled && !this.hasScheduledBirths();
  }

  /**
   * Live particle count on the JS backend. On the GPU backend the live count is not visible to the
   * CPU, so this is `capacity`.
   */
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

  /**
   * What a birth of this emitter inherits when no reaction hands it anything (see
   * `FXSpawnOrigin.inherited`): the behavior's `inherit` defaults, as many floats as its layout.
   */
  public get inheritDefaults(): ArrayLike<number> {
    return this.defaultInherited;
  }

  /** The particle slot this emitter simulates: what {@link FXParticleEvent.slot} lays out. */
  public get particleSlot(): FXSlotLayout {
    return this.driver.slot;
  }

  /** Whether {@link onParticleEvent} works here: a CPU-driven emitter's particles' births and
   *  deaths are seen, a GPU-driven one's never leave the GPU. */
  public get reportsParticleEvents(): boolean {
    return this.driver.reportsEvents;
  }

  /** Whether this emitter draws its particles: built or swapped with a render artifact for them. */
  public get drawsParticles(): boolean {
    return this.artifactMaterial !== undefined;
  }

  /**
   * What the driver logged for a program of its GPU simulation it rejected, or `undefined` while
   * none is rejected or they are still building. Never waits for a build. Without its kernel the
   * emitter spawns and draws no particles; without its sort it draws them unsorted.
   */
  public get simulationFailure(): string | undefined {
    for (const program of this.driver.programs) {
      const failure = program.failure;
      if (failure !== undefined) {
        return failure;
      }
    }
    return undefined;
  }

  /** @internal The raw WebGL programs its simulation runs, building or built. */
  public get simulationPrograms(): readonly FXLinkedProgram[] {
    return this.driver.programs;
  }

  private get mesh(): Mesh {
    return this.driver.mesh;
  }

  /**
   * Builds an emitter into `world` from precompiled artifacts. For editor tooling
   * (`sparcoon/editor`). Games run whole projects through {@link FXEffect}.
   */
  public static fromArtifacts(
    behavior: FXBehaviorArtifact,
    options: FXFromArtifactsOptions = {},
    world: FXWorld = FXWorld.getDefault(),
  ): FXEmitter {
    const capacity = options.expectedCapacity ?? EMITTER_DEFAULT_EXPECTED_CAPACITY;
    const defaultInherited = inheritDefaultsOf(
      behavior.inherit,
      "FXEmitter.fromArtifacts.behavior.inherit",
    );
    // The fixed ring size on both backends, checked in every build (once per emitter, never per
    // frame): zero would wrap the cursor to NaN, and a fractional length is a RangeError far
    // from its cause.
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(
        `FXEmitter.fromArtifacts.options.expectedCapacity: expected an integer >= 1, got ${String(capacity)}`,
      );
    }

    if (options.sort !== undefined) {
      assertValidSort(options.sort, options);
    }
    const cameraUse = cameraUseOf(options);
    if (cameraUse !== undefined && options.camera === undefined) {
      throw new Error(
        `FXEmitter.fromArtifacts.options: an emitter that ${cameraUse} needs a camera`,
      );
    }
    const cameraView = readsSceneDepth(options) ? new FXCameraView() : undefined;

    // Before anything owns a GPU resource - a missing or unreadable asset throws on either backend.
    const geometries = options.geometries ?? {};
    const assets: FXAppAssets = {
      geometries,
      meshes: options.meshes ?? {},
      volumes: options.volumes ?? {},
    };
    const resources = kernelResourcesOf(behavior, assets);
    const gpuResources =
      options.gpuKernel === undefined ? {} : kernelResourcesOf(options.gpuKernel, assets);

    const draw = particleDrawOf(options.particles, options.textures, geometries);

    // The one place this emitter's backend is chosen, ever (never switched mid-playback). A GPU
    // that cannot hold the kernel (its slot, texture units or resources) falls back to the
    // mandatory JS artifact in place. A program the driver rejects is known only once it has
    // built, after this choice: that simulation then runs no pass (see simulationFailure).
    let driver: FXEmitterDriver | undefined;
    if (options.gpuKernel !== undefined && options.renderer !== undefined) {
      try {
        driver = new FXGPUEmitterDriver({
          kernel: options.gpuKernel,
          renderer: options.renderer,
          draw,
          capacity,
          resources: gpuResources,
          view: cameraView,
          sorted: options.sort !== undefined,
        });
      } catch (error) {
        console.warn(
          "FXEmitter: GPU (transform-feedback) behavior setup failed at runtime; falling back " +
            "to the JS behavior artifact for this emitter.",
          error,
        );
      }
    }
    driver ??= new FXJSEmitterDriver(behavior, draw, capacity, resources);

    // Everything built so far owns GPU resources: a throw from here on releases them.
    let emitter: FXEmitter;
    try {
      emitter = new FXEmitter(
        driver,
        draw?.material,
        options,
        world,
        deviceLimits(options.renderer),
        defaultInherited,
        cameraView,
      );
    } catch (error) {
      driver.destroy();
      throw error;
    }
    try {
      for (const kind of FX_STRIP_KINDS) {
        emitter.strips.replace(kind, options[kind], options.textures ?? {});
      }
    } catch (error) {
      emitter.destroy();
      throw error;
    }
    return emitter;
  }

  /**
   * Whether this emitter draws a strip of `kind` through its particles - not one it was given but
   * skipped, past what the renderer's GPU offers (see {@link fromArtifacts}).
   */
  public hasStrip(kind: FXStripKind): boolean {
    return this.strips.has(kind);
  }

  /**
   * @internal Ticks this emitter one frame. Driven by {@link FXWorld.update}, which advances the
   * shared clock once and passes it in as `elapsedTime`.
   */
  public onWorldTick(deltaTime: number, elapsedTime: number): void {
    this.onRendering(deltaTime);
    // The pose the tick sampled (see worldTransform): the particles' mesh's, and each strip's own.
    if (this.artifactMaterial !== undefined) {
      this.advanceMaterial(
        this.artifactMaterial,
        deltaTime,
        elapsedTime,
        this.emitterTransform.worldMatrix,
      );
    }
    for (const strip of this.strips.all) {
      // Its parents' matrices are this tick's already (the tick sampled the emitter's motion).
      strip.mesh.updateWorldMatrix(false, false);
      this.advanceMaterial(
        strip.artifactMaterial,
        deltaTime,
        elapsedTime,
        strip.mesh.matrixWorld.elements,
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
    for (const channel of Object.values(this.events)) {
      channel.destroy();
    }

    // The material owns no per-emitter GPU resources; the driver teardown disposes the instanced
    // geometry and the mounted material (plus, for a GPU-driven emitter, the compiled program+VAO)
    // - not the depth material, which this emitter built and so releases itself.
    this.mesh.customDepthMaterial?.dispose();
    this.mesh.customDepthMaterial = undefined;
    this.artifactMaterial?.destroy();
    this.strips.destroy();
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
      this.assertValidOrigin(options.origin, "FXEmitter.burst.options.origin");
    }
    if (this.destroyed) {
      return DEAD_HANDLER;
    }
    const handler = this.nextHandler++;
    const origin = options.origin === undefined ? undefined : this.birthOrigin(options.origin);

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
   * `options.origin` for the whole play. Following the pose, every tick after its first emitting
   * one spreads its births over it: each as old as how long before the tick's end it fell, from
   * where the emitter stood then, so a fast emitter leaves an even stream rather than one clump a
   * tick.
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
      this.assertValidOrigin(options.origin, "FXEmitter.play.options.origin");
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
      origin: options.origin === undefined ? undefined : this.birthOrigin(options.origin),
    });

    return handler;
  }

  /**
   * Calls `listener` for each `kind` event of this emitter's particles, after every emitter of
   * this world has ticked (so a listener spawning elsewhere does it the same way whatever order
   * the emitters tick in: the births land on the next tick). Watching costs a copy of each
   * event's slot, and for deaths also a copy of the particle positions per tick, while any
   * listener of that kind is attached.
   *
   * - `"birth"`: once per particle born alive, however its birth came about (a burst, a play, a
   *   death reaction).
   * - `"death"`: once per particle that dies of age or is killed by its behavior's update (`kill`).
   *   A particle a birth overwrites in a full ring, or one {@link reset} clears, does not die.
   *
   * Neither is reported for the particles of {@link prewarm}.
   * @returns Detaches `listener`.
   * @throws On a kind that is neither. On a GPU-driven emitter (see {@link reportsParticleEvents}):
   *   its particles' state lives on the GPU, and reading it back would stall the pipeline. Build
   *   an event source without a GPU kernel.
   */
  public onParticleEvent(kind: FXParticleEventKind, listener: FXParticleEventListener): () => void {
    // Checked at runtime too: a plain-JS host can pass any string.
    if (asParticleEventKind(kind) === undefined) {
      throw new Error(
        `FXEmitter.onParticleEvent: expected one of ${FX_PARTICLE_EVENT_KINDS.join(", ")}, ` +
          `got ${kind}`,
      );
    }
    if (!this.driver.reportsEvents) {
      throw new Error(
        `FXEmitter.onParticleEvent: a GPU-driven emitter cannot report its particles' ${kind}s - ` +
          "build it without a gpuKernel",
      );
    }
    if (this.destroyed) {
      return NO_OP;
    }
    return this.events[kind].listen(listener);
  }

  /**
   * @internal Hands this tick's particle events to their {@link onParticleEvent} listeners:
   * deaths, then births, as a tick produces them. Driven by {@link FXWorld.update} after every
   * object of the world ticked.
   */
  public afterWorldTick(): void {
    this.events.death.dispatch();
    this.events.birth.dispatch();
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
      this.afterTick();
    } finally {
      // Outside the world's tick, so its reset is this call's to make.
      flushStateResets();
    }
    // Births and deaths of a simulated past are not events: nothing should spawn where they
    // happened.
    for (const channel of Object.values(this.events)) {
      channel.clearPending();
    }
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
    for (const channel of Object.values(this.events)) {
      channel.clear();
    }
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
   * Sets parameter values by name in uniform and binding slots, read from the next frame. An
   * unknown name is ignored. Never recompiles: a structural edit needs a new {@link fromArtifacts}.
   *
   * @throws When an external texture is of a variant its slot was not built with (see {@link
   * FXExternalTexture}). The particles, the strips and the values a later material starts from are
   * then all left as they were.
   */
  public applyValues(values: FXApplyValues): void {
    if (this.destroyed) {
      return;
    }
    const { uniforms } = values;
    // Each material with its own values, by kind (particles, trail, ribbon).
    const owned: readonly (readonly [
      FXArtifactMaterial | undefined,
      FXApplyValues["particleMaterial"],
    ])[] = [
      [this.artifactMaterial, values.particleMaterial],
      [this.strips.material("trail"), values.trailMaterial],
      [this.strips.material("ribbon"), values.ribbonMaterial],
    ];
    // Every material checked before any changes, and before the parameters are kept for a later
    // swap: a rejected edit must not leave one material out of step or poison a swap.
    for (const [material, own] of owned) {
      for (const each of [uniforms, own]) {
        if (each !== undefined) {
          material?.assertUniformValues(each);
        }
      }
    }
    if (uniforms !== undefined) {
      Object.assign(this.appliedUniforms, uniforms);
    }
    for (const [material, own] of owned) {
      // One parameter namespace per emitter: a name several graphs declare drives them all.
      if (uniforms !== undefined) {
        material?.applyUniformValues(uniforms);
      }
      if (own !== undefined) {
        material?.applyUniformValues(own);
      }
    }
    if (values.bindings !== undefined) {
      this.driver.applyBindingValues(values.bindings);
    }
  }

  /**
   * Replaces the render half in place (shader, geometry, shadow flags), or stops (`undefined`) or
   * starts drawing the particles. The driver, particle buffers, instance count and schedule are
   * untouched, so a running effect is not reset.
   *
   * The buffers depend on the behavior alone, so a render reading an attribute nothing writes still
   * applies in place (it reads as zero, with no buffer - see `particleLayout`).
   *
   * @throws If the new render artifact reads an attribute at another width than this emitter's
   * behavior writes it (see {@link FXEmitterDriver.applyRenderArtifact}), or on `undefined` when
   * this emitter sorts. This emitter is left exactly as it was before the call in that case.
   */
  public applyRenderArtifact(
    render: FXRenderArtifact | undefined,
    options: FXApplyRenderArtifactOptions = {},
  ): void {
    if (this.destroyed) {
      return;
    }
    if (render === undefined && this.sort !== undefined) {
      throw new Error("FXEmitter.applyRenderArtifact: an emitter that sorts draws its particles");
    }
    const draw = particleDrawOf(render, options.textures, options.geometries ?? {});
    if (draw !== undefined && render !== undefined) {
      this.carryParameters(draw.material, render);
    }
    // Throws (leaving this emitter untouched) before anything below mutates it - see this
    // method's own @throws doc.
    this.driver.applyRenderArtifact(draw);
    this.artifactMaterial?.destroy();
    this.artifactMaterial = draw?.material;

    const previousDepthMaterial = this.mesh.customDepthMaterial;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.customDepthMaterial = undefined;
    this.applyShadows(options);
    previousDepthMaterial?.dispose();
  }

  /**
   * Replaces this emitter's strip of `kind` - or removes it (`undefined`) - leaving the particles,
   * their simulation and the playback schedule untouched. A new trail starts empty and fills in
   * from the next tick on; a new ribbon draws the particles alive from the next tick on. Either
   * starts with every uniform value {@link applyValues} has set on this emitter (those its graph
   * declares) carried over - a driven parameter keeps its value across the swap, as the particle
   * material's does (see {@link applyRenderArtifact}). For tooling (the editor swaps a strip on an
   * edit of its graph); an exported effect builds its strips once in {@link fromArtifacts}.
   * @throws On an emitter that sorts, or when the new strip cannot be built; the current strip is
   *   then left in place.
   */
  public applyStripArtifact<K extends FXStripKind>(
    kind: K,
    options: FXStripOptions[K] | undefined,
    textures: FXFromArtifactsOptions["textures"] = {},
  ): void {
    if (this.destroyed) {
      return;
    }
    if (options !== undefined && this.sort !== undefined) {
      throw new Error(`FXEmitter.applyStripArtifact: an emitter that sorts cannot have a ${kind}`);
    }
    this.strips.replace(kind, options, textures, (strip) => {
      if (options !== undefined) {
        this.carryParameters(strip.artifactMaterial, options.render);
      }
    });
  }

  // The shadow flags `options` ask for, on a mesh that has none yet. Only drawn particles cast or
  // receive one; the second (depth) ShaderMaterial is paid for only when a cast shadow is asked
  // for. `frustumCulled` is already false on the mesh, so the shadow pass's frustum check is a
  // no-op just like the color pass.
  private applyShadows(options: Partial<FXEmitterOptions>): void {
    if (this.artifactMaterial === undefined) {
      return;
    }
    this.mesh.receiveShadow = options.receiveShadow ?? EMITTER_DEFAULT_RECEIVE_SHADOW;
    if (options.castShadow ?? EMITTER_DEFAULT_CAST_SHADOW) {
      this.mesh.castShadow = true;
      this.mesh.customDepthMaterial = this.artifactMaterial.buildThreeDepthMaterial(
        this.driver.layout,
      );
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
    // Always length 3 (see its declaration).
    frame.objectVelocity = this.emitterTransform.velocity as [number, number, number];
    frame.objectAngularVelocity = this.emitterTransform.angularVelocity as [number, number, number];
    material.advance(frame);
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
    // Velocity is computed once per tick, not in worldTransform(): that runs several times per tick
    // and each call would diff against a baseline the previous call had already advanced.
    const motion = sampleObjectMotion(this.motionTracker, this.mesh, deltaTime);
    this.emitterTransform.velocity[0] = motion.velocity[0];
    this.emitterTransform.velocity[1] = motion.velocity[1];
    this.emitterTransform.velocity[2] = motion.velocity[2];
    this.emitterTransform.angularVelocity[0] = motion.angularVelocity[0];
    this.emitterTransform.angularVelocity[1] = motion.angularVelocity[1];
    this.emitterTransform.angularVelocity[2] = motion.angularVelocity[2];
    // Sampling the motion updated `matrixWorld`; a settled emitter's draw stage reads the pose too.
    const transform = this.copyWorldMatrix();
    this.driver.advance(deltaTime);

    if (this.isSettled) {
      return;
    }

    // Paused (dt == 0): skip the simulation step entirely - no JS age/kernel update, no GPU
    // transform-feedback dispatch, no schedule advance - the emitter keeps rendering whatever
    // particle state the last active tick left behind. Births already due still land, each seeded
    // on its own outside a tick (a host's burst while paused shows at once).
    if (deltaTime <= 0) {
      for (const birth of this.dueBirths) {
        this.seedDue(birth, transform);
      }
      this.dueBirths.length = 0;
      this.recordStrips(0);
      return;
    }

    this.sinceLastBirth += deltaTime;

    // One order on both backends: update, then the births at this tick's pose (on the GPU, one
    // range of the tick's single pass; the ones born through the tick last, its tail), then every
    // birth at another pose (one GPU pass each) - so the two number their particles alike, and no
    // newborn is updated in its own tick.
    this.driver.beginTick(deltaTime, transform);
    const elsewhere = this.birthsElsewhere;

    for (const birth of this.dueBirths) {
      if (birth.matrix !== undefined && sameMatrix(birth.matrix, transform.worldMatrix)) {
        this.seed(birth.count, transform, this.defaultInherited);
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

    // The births of plays that emitted through the tick before as well, at this tick's pose: born
    // through the tick, not at its end, so they spread along the way the emitter came (see
    // FXBirthAges). Gathered and seeded last, as one run - the tail of the GPU pass - so two such
    // plays in one tick share an even spread (`sweptAges` undefined) instead of each its own.
    let sweptCount = 0;
    let sweptAges: FXBirthAges | undefined;

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
      const carried = play.accumulator;
      const gained = play.rate * (play.over === "distance" ? speed * emitDeltaTime : emitDeltaTime);
      play.accumulator += gained;
      const particlesToSpawn = Math.floor(play.accumulator);

      if (particlesToSpawn > 0) {
        play.accumulator -= particlesToSpawn;
        // A play's first emitting tick is born at its end: where the emitter stood the tick
        // before is no way it came while this play emitted - a host moves an emitter into place
        // and starts it.
        if (play.origin === undefined && previousElapsed > 0) {
          sweptAges =
            sweptCount === 0 ? playBirthAges(carried, gained, emitDeltaTime, deltaTime) : undefined;
          sweptCount += particlesToSpawn;
        } else {
          this.spawnScheduled(particlesToSpawn, play.origin, transform);
        }
      }

      if (expired) {
        this.activePlays.splice(i, 1);
      }
    }

    if (sweptCount > 0) {
      this.seed(
        sweptCount,
        transform,
        this.defaultInherited,
        sweptAges ?? spreadBirthAges(sweptCount, deltaTime),
      );
    }

    this.driver.endTick(deltaTime, transform);
    for (const birth of elsewhere) {
      this.seedDue(birth, transform);
    }
    elsewhere.length = 0;
    this.recordStrips(deltaTime);
    if (this.diedOut(deltaTime)) {
      this.settle();
    }
  }

  /**
   * Records every strip after a tick of `deltaTime` seconds, with a birth from this emitter's pose
   * while a play emits from it (begun, not done, with no origin of its own) - so a ribbon's head
   * shows only while its next particle will be born there.
   */
  private recordStrips(deltaTime: number): void {
    const emitting = this.activePlays.some((play) => play.origin === undefined && play.delay <= 0);
    this.stripFrame.deltaTime = deltaTime;
    this.stripFrame.birth = emitting ? this.stripBirth : undefined;
    this.strips.record(this.stripFrame);
  }

  private seed(
    count: number,
    transform: FXEmitterTransform,
    inherited: Float32Array,
    ages?: FXBirthAges,
  ): void {
    this.settled = false;
    this.sinceLastBirth = 0;
    this.driver.spawn(count, transform, inherited, ages);
  }

  // A due birth seeded on its own: from its origin, or from the pose of its call at the tick's motion.
  private seedDue(birth: FXDueBirth, tick: FXEmitterTransform): void {
    if (birth.origin !== undefined) {
      this.seed(birth.count, birth.origin.pose, birth.origin.inherited);
      return;
    }
    this.seed(
      birth.count,
      {
        worldMatrix: birth.matrix ?? tick.worldMatrix,
        velocity: tick.velocity,
        angularVelocity: tick.angularVelocity,
      },
      this.defaultInherited,
    );
  }

  private hasScheduledBirths(): boolean {
    return (
      this.dueBirths.length > 0 || this.pendingBursts.length > 0 || this.activePlays.length > 0
    );
  }

  // Every particle was already past `maxLifetime` a tick ago - a whole tick, so a float32 age that
  // rounded short of its lifetime is dead too - with nothing due to be born, and no strip draws
  // anything from before that: settling now cuts nothing visible.
  private diedOut(deltaTime: number): boolean {
    if (this.settled || this.maxLifetime === undefined || this.hasScheduledBirths()) {
      return false;
    }
    const sinceDeath = this.sinceLastBirth - deltaTime - this.maxLifetime;
    return sinceDeath >= 0 && this.strips.fadedBy(sinceDeath);
  }

  // Events already found stay queued for afterWorldTick: settling is no death of its own.
  private settle(): void {
    this.driver.reset();
    this.strips.reset();
    this.settled = true;
  }

  // A scheduled spawn (a delayed burst expiring, a play's accumulator) inside a tick: at the
  // tick's pose right away, or at its origin after the tick's pass.
  private spawnScheduled(
    count: number,
    origin: FXBirthOrigin | undefined,
    transform: FXEmitterTransform,
  ): void {
    if (origin === undefined) {
      this.seed(count, transform, this.defaultInherited);
    } else {
      this.birthsElsewhere.push({ count, matrix: undefined, origin });
    }
  }

  // A birth at `origin`, copied at the call: the pose it spawns from - this emitter's, moved to the
  // origin's position, with the origin's velocity and no spin - and what it inherits.
  private birthOrigin(origin: FXSpawnOrigin): FXBirthOrigin {
    const worldMatrix = [...this.worldTransform().worldMatrix];
    worldMatrix[12] = origin.position[0];
    worldMatrix[13] = origin.position[1];
    worldMatrix[14] = origin.position[2];
    const velocity = origin.velocity ?? ZERO_VECTOR;
    return {
      pose: {
        worldMatrix,
        velocity: [velocity[0], velocity[1], velocity[2]],
        angularVelocity: [0, 0, 0],
      },
      inherited:
        origin.inherited === undefined
          ? this.defaultInherited
          : Float32Array.from(origin.inherited),
    };
  }

  private assertValidOrigin(origin: FXSpawnOrigin, subject: string): void {
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
    if (origin.inherited !== undefined) {
      assertValidInherited(origin.inherited, this.defaultInherited.length, `${subject}.inherited`);
    }
  }

  private readonly onRendering = (deltaTime: number): void => {
    this.tick(deltaTime);
    this.afterTick();
  };

  // After a tick, with the camera where the frame about to render sees it from: the depth the
  // next tick reads is that frame's, so its view is captured now. A sorted emitter then readies its
  // particles for the draw, sorting on the frames its fraction picks.
  private afterTick(): void {
    if (this.cameraView !== undefined && this.camera !== undefined) {
      this.cameraView.capture(this.camera);
    }
    if (this.sort === undefined || this.isSettled) {
      return;
    }
    // `fraction` is public, so clamped here: above 1 it would grow the accumulator unbounded.
    this.sortingAccumulator += Math.min(Math.max(this.sort.fraction, 0), 1);
    let cameraWorldPosition: Vector3 | undefined;
    if (this.sortingAccumulator >= 1) {
      this.sortingAccumulator -= 1;
      cameraWorldPosition = this.camera?.getWorldPosition(this.sortingCameraWorldPosition);
    }
    this.driver.prepareDraw(cameraWorldPosition);
  }
}

/** What an emitter draws `render` with, or `undefined` without one. */
function particleDrawOf(
  render: FXRenderArtifact | undefined,
  textures: FXFromArtifactsOptions["textures"],
  geometries: NonNullable<FXFromArtifactsOptions["geometries"]>,
): FXParticleDraw | undefined {
  if (render === undefined) {
    return undefined;
  }
  return {
    material: new FXArtifactMaterial(render, textures),
    baseGeometry: resolveGeometrySource(render.geometry, geometries),
  };
}

const DEAD_HANDLER = -1;

const NO_OP = (): void => undefined;

const ZERO_VECTOR: readonly number[] = [0, 0, 0];

/** A birth from somewhere else than the emitter's pose: its full pose, and what it inherits. Only
 *  such a birth inherits from a particle - one at the emitter's pose takes the defaults. */
interface FXBirthOrigin {
  readonly pose: FXEmitterTransform;
  readonly inherited: Float32Array;
}

/** A birth that is due: `count` particles from the emitter's pose at the call (`matrix`, the tick
 *  supplies its motion), or from an origin. */
interface FXDueBirth {
  readonly count: number;
  readonly matrix: readonly number[] | undefined;
  readonly origin: FXBirthOrigin | undefined;
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

function assertValidSort(sort: FXEmitterSortOptions, options: FXFromArtifactsOptions): void {
  if (sort.fraction !== undefined) {
    assertValidNonNegativeNumber(sort.fraction, "FXEmitter.fromArtifacts.options.sort.fraction");
  }
  if (options.particles === undefined) {
    throw new Error(
      "FXEmitter.fromArtifacts.options: an emitter that draws no particles cannot sort",
    );
  }
  for (const kind of FX_STRIP_KINDS) {
    if (options[kind] !== undefined) {
      throw new Error(`FXEmitter.fromArtifacts.options: an emitter with a ${kind} cannot sort`);
    }
  }
}

/** The options of an emitter that decide whether it needs a camera. */
interface FXCameraUseOptions {
  readonly sort?: FXEmitterSortOptions | undefined;
  readonly gpuKernel?: FXParticleKernelArtifact | undefined;
  readonly renderer?: WebGLRenderer | undefined;
}

/** Whether an emitter built with `options` reads the scene depth: only a GPU kernel does - the JS
 *  one finds no surface there. */
function readsSceneDepth(options: FXCameraUseOptions): boolean {
  return options.gpuKernel?.sceneDepth === true && options.renderer !== undefined;
}

/**
 * @internal What an emitter built with `options` needs its camera for, as a phrase ("sorts"), or
 * `undefined` when it needs none: a sort draws back to front from the camera, and a GPU kernel
 * reading the scene depth reads the camera's.
 */
export function cameraUseOf(options: FXCameraUseOptions): string | undefined {
  if (options.sort !== undefined) {
    return "sorts";
  }
  return readsSceneDepth(options) ? "reads the scene depth" : undefined;
}

function sortOf(options: FXEmitterSortOptions): FXEmitterSort {
  return {
    fraction: Math.min(options.fraction ?? EMITTER_DEFAULT_SORT_FRACTION, 1),
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

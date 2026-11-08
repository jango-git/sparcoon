import type { Camera, Mesh, Texture, WebGLRenderer } from "three";
import { Object3D, Quaternion, Vector3 } from "three";
import type { FXEmitterTransform } from "../artifact/FXArtifact.js";
import type { FXBehaviorArtifact, FXRenderArtifact } from "../artifact/FXArtifact.js";
import type { FXApplyRenderArtifactOptions } from "./FXApplyRenderArtifactOptions.js";
import type { FXFromArtifactsOptions } from "./FXFromArtifactsOptions.js";
import { FXWorld } from "../world/FXWorld.js";
import { FXObjectMotionTracker } from "./FXObjectMotion.Internal.js";
import { resolveGeometrySource } from "../instancedParticle/primitiveGeometry.js";
import {
  assertValidNonNegativeNumber,
  assertValidPositiveInteger,
  assertValidPositiveNumber,
} from "../miscellaneous/asserts.js";
import { FXArtifactMaterial } from "../render/FXArtifactMaterial.js";
import type { FXRenderBudget } from "../render/FXRenderBudget.js";
import type { FXTrailOptions } from "../trail/FXTrail.js";
import { assertValidTrailOptions, FXTrail } from "../trail/FXTrail.js";
import { trailReadFields } from "../trail/FXTrailFields.Internal.js";
import type { FXEmitterDriver } from "./FXEmitterDriver.Internal.js";
import { FXGPUEmitterDriver } from "./FXGPUEmitterDriver.Internal.js";
import { FXJSEmitterDriver } from "./FXJSEmitterDriver.Internal.js";
import type {
  FXApplyValues,
  FXEmitterBurstOptions,
  FXEmitterOptions,
  FXEmitterPlayOptions,
} from "./FXEmitter.Internal.js";
import {
  EMITTER_DEFAULT_CAST_SHADOW,
  EMITTER_DEFAULT_EXPECTED_CAPACITY,
  EMITTER_DEFAULT_PREWARM_MAX_STEP_COUNT,
  EMITTER_DEFAULT_PREWARM_MIN_STEP_DURATION,
  EMITTER_DEFAULT_RECEIVE_SHADOW,
  EMITTER_DEFAULT_SORT_FRACTION,
} from "./FXEmitter.Internal.js";

/**
 * Particle emitter - one instanced billboard/mesh draw call, per-particle state driven by a
 * precompiled behavior artifact and appearance by a precompiled render artifact spliced into a
 * Three material. Built and ticked by {@link FXEffect} through an {@link FXWorld}. Not exported from
 * the package (the runtime path is running artifacts, not hand-building emitters); reached only as
 * the live handle returned by {@link FXEffect.getEmitter}.
 *
 * A thin facade over one {@link FXEmitterDriver} (JS or GPU - see `FXEmitterDriver.Internal.ts`),
 * chosen once by {@link fromArtifacts} and never switched mid-playback. This class itself owns only
 * what is genuinely backend-independent: play/burst/stop/prewarm scheduling, sort-fraction timing,
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
  // The last value applyValues set per uniform name, for a trail built later (applyTrailArtifact)
  // to start from the values its parameters are being driven with, not its baked ones.
  private readonly appliedUniforms: Record<string, number | readonly number[] | Texture> = {};

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
   * takes more attributes or varying vectors than `limits` - a program past them fails to link,
   * so the trail would never draw anyway, and the particles still do without it.
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
    if (
      limits !== undefined &&
      (trail.budget.attributes > limits.attributes ||
        trail.budget.varyingVectors > limits.varyingVectors)
    ) {
      trail.destroy();
      if (!warning.warned) {
        warning.warned = true;
        console.warn(
          `FXEmitter: the trail is skipped - its material needs ${String(trail.budget.attributes)} ` +
            `vertex attributes and ${String(trail.budget.varyingVectors)} varying vectors, the ` +
            `GPU offers ${String(limits.attributes)} and ${String(limits.varyingVectors)}.`,
        );
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
    this.pushFrameUniforms(this.artifactMaterial, deltaTime, elapsedTime);
    if (this.trail !== undefined) {
      this.pushFrameUniforms(this.trail.artifactMaterial, deltaTime, elapsedTime);
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
   * Spawns `count` particles immediately, or after `options.delay`. An immediate burst seeds its
   * particles from this emitter's pose and parameter values at the moment of the call, on either
   * backend - so moving the emitter between two bursts of one frame spawns them in two places.
   * A delayed burst spawns from the pose and values of the tick it expires on.
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

  /**
   * Kills all live particles and cancels all active plays and pending bursts. For a GPU-driven
   * emitter this is a known-narrower reset (see the mesh's own `drop()` doc comment): there is no
   * CPU-visible per-particle state to instantly zero, so already-alive particles keep aging out
   * naturally rather than vanishing on this call's own frame - only the spawn cursor and pending
   * schedule reset immediately.
   */
  public reset(): void {
    if (this.destroyed) {
      return;
    }
    this.pendingBursts.length = 0;
    this.activePlays.length = 0;
    this.driver.reset();
    this.trail?.reset();
    // A restarted effect should not report a teleport spike from wherever the emitter was last
    // posed - drop the velocity/angular-velocity baseline along with the particles.
    this.motionTracker.reset();
  }

  /**
   * For a timeline that loops back to its start - {@link FXEffect}'s own, or a tool's that drives
   * the emitter itself: cancels the active plays and pending bursts, as {@link stop} does, and
   * forgets the motion baseline - the pose jumps from the lap's end to its start, which is no
   * motion - but leaves live particles to finish their lives, so the loop runs on seamlessly.
   * Unlike {@link reset}, which clears them.
   */
  public loopTimeline(): void {
    if (this.destroyed) {
      return;
    }
    this.stop();
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
      Object.assign(this.appliedUniforms, values.uniforms);
      this.artifactMaterial.applyUniformValues(values.uniforms);
      // One parameter namespace per emitter: a name the trail graph declares too drives both.
      this.trail?.artifactMaterial.applyUniformValues(values.uniforms);
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
   * swap, as the particle material keeps it. For tooling (the editor swaps the trail on a
   * trail-graph edit); an exported effect builds its trail once in {@link fromArtifacts}.
   * @throws When the new trail cannot be built; the current trail is then left in place.
   */
  public applyTrailArtifact(
    options: FXTrailOptions | undefined,
    textures: FXFromArtifactsOptions["textures"] = {},
  ): void {
    if (this.destroyed) {
      return;
    }
    // Built first: a throw leaves the current trail in place.
    const next =
      options === undefined
        ? undefined
        : FXEmitter.buildTrail(this.driver, options, textures, this.limits, this.trailLimitWarning);
    next?.artifactMaterial.applyUniformValues(this.appliedUniforms);
    this.trail?.destroy();
    this.trail = next;
    if (next !== undefined) {
      this.add(next.mesh);
    }
  }

  // The clock and this tick's object motion, for one of this emitter's materials.
  private pushFrameUniforms(
    material: FXArtifactMaterial,
    deltaTime: number,
    elapsedTime: number,
  ): void {
    material.setElapsedTime(elapsedTime);
    material.setDeltaTime(deltaTime);
    // emitterTransform.velocity/angularVelocity are always length 3 (see its declaration) -
    // computed once per tick in onRendering -> tick.
    material.setObjectVelocity(this.emitterTransform.velocity as [number, number, number]);
    material.setObjectAngularVelocity(
      this.emitterTransform.angularVelocity as [number, number, number],
    );
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

    // Paused (dt == 0): skip the simulation step entirely - no JS age/kernel update, no GPU
    // transform-feedback dispatch, no schedule advance - the emitter keeps rendering whatever
    // particle state the last active tick left behind.
    if (deltaTime <= 0) {
      return;
    }

    this.driver.beginTick(deltaTime, this.worldTransform());

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

    this.driver.endTick(deltaTime, this.worldTransform());
    this.trail?.record(deltaTime);
  }

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

  private spawnBurst(count: number): void {
    this.driver.spawn(count, this.worldTransform());
  }
}

// Returned by post-destroy `burst`/`play` - never matches a scheduled handler.
const DEAD_HANDLER = -1;

/**
 * What `renderer`'s GPU offers a material: its vertex attribute and varying vector counts, or
 * `undefined` without a renderer (or a stand-in that reports neither) - nothing is checked then.
 */
function deviceLimits(renderer: WebGLRenderer | undefined): FXRenderBudget | undefined {
  const capabilities = renderer?.capabilities as
    { maxAttributes?: unknown; maxVaryings?: unknown } | undefined;
  const attributes = capabilities?.maxAttributes;
  const varyingVectors = capabilities?.maxVaryings;
  if (typeof attributes !== "number" || typeof varyingVectors !== "number") {
    return undefined;
  }
  return { attributes, varyingVectors };
}

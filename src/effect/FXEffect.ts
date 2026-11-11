import {
  Group,
  Mesh,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type Camera,
  type Material,
  type Object3D,
  type WebGLRenderer,
} from "three";
import type { FXExternalTexture } from "../render/FXExternalTexture.js";
import { checkRuntimeVersion } from "./FXRuntimeVersion.Internal.js";
import type {
  FXBehaviorArtifact,
  FXRenderArtifact,
  FXRenderArtifactsByGLSLTier,
} from "../artifact/FXArtifact.js";
import { FXEmitter } from "../emitter/FXEmitter.js";
import { FXObjectMotionTracker } from "../emitter/FXObjectMotion.Internal.js";
import { resolveGeometrySource } from "../instancedParticle/primitiveGeometry.js";
import { warnInDevelopment } from "../miscellaneous/asserts.js";
import { FXMeshMaterial } from "../render/FXMeshMaterial.js";
import { compilePrograms } from "../render/FXProgramCompile.Internal.js";
import { FXWorld } from "../world/FXWorld.js";
import {
  assertDeathReactionAction,
  connectDeathReaction,
  fireSpawnAction,
} from "./FXSpawnAction.js";
import type {
  FXEffectEventMap,
  FXEffectOptions,
  FXEffectPlayOptions,
  FXEffectSpec,
  FXTransform,
  FXTransformChannel,
} from "./FXEffectSpec.js";
import {
  frameOfTime,
  normalizeQuaternion,
  sampleTracks,
  sampleTransform,
  timeOfFrame,
} from "./FXEffectSampling.Internal.js";

const VECTOR_COMPONENTS: readonly ["x", "y", "z", "w"] = ["x", "y", "z", "w"];
const PARAMETER_UNIFORM_PREFIX = "u_param_";
const PARAMETER_BINDING_PREFIX = "b_param_";

/**
 * Writes `transform` onto `object`, skipping any channel in `liveChannels` - a "fake" channel the
 * editor excludes from the exported keyframe data, left for the consumer to drive directly through
 * the returned runtime object's own `position`/`quaternion`/`scale`.
 */
function applyTransform(
  object: Object3D,
  transform: FXTransform,
  liveChannels?: readonly FXTransformChannel[],
): void {
  if (liveChannels?.includes("position") !== true) {
    object.position.set(transform.position[0], transform.position[1], transform.position[2]);
  }
  if (liveChannels?.includes("rotation") !== true) {
    const quaternion = normalizeQuaternion(transform.rotation);
    object.quaternion.set(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
  }
  if (liveChannels?.includes("scale") !== true) {
    object.scale.set(transform.scale[0], transform.scale[1], transform.scale[2]);
  }
}

/** Materializes a possibly-readonly keyframe value into the mutable shape the value writers expect. */
function materializeValue(value: number | readonly number[]): number | number[] {
  return typeof value === "number" ? value : [...value];
}

/** Picks one emitter/mesh's compiled artifact by render target (see {@link FXEffectOptions.renderer}). */
function resolveRenderArtifact(
  render: FXRenderArtifactsByGLSLTier,
  isWebGL2: boolean,
): FXRenderArtifact {
  return render[isWebGL2 ? "standard" : "baseline"];
}

/** One asset slot: an external texture (whole, or a region of one) OR (per
 *  {@link FXGeometrySource}) an external geometry, keyed by the same flat `assets` namespace. */
type FXEffectAsset = FXExternalTexture | BufferGeometry;

// Duck-typed, not `instanceof`: the app's `three` and this package's peer-dep `three` can be two
// separate module instances (e.g. hoisted differently across a workspace), which would make
// `instanceof Texture`/`instanceof BufferGeometry` false for a perfectly good asset. Every `three`
// object of these kinds carries this own-property flag regardless of which module instance built it.
function isBufferGeometry(asset: FXEffectAsset): asset is BufferGeometry {
  return (asset as { isBufferGeometry?: boolean }).isBufferGeometry === true;
}

function texturesForSlots(
  slots: readonly string[],
  assets: Record<string, FXEffectAsset>,
): Record<string, FXExternalTexture> {
  const textures: Record<string, FXExternalTexture> = {};
  for (const name of slots) {
    const asset = assets[name];
    // Anything but a geometry: a whole texture or a region of one.
    if (!isBufferGeometry(asset)) {
      textures[PARAMETER_UNIFORM_PREFIX + name] = asset;
    }
  }
  return textures;
}

/** Every `BufferGeometry`-typed entry in `assets`, for {@link resolveGeometrySource}'s lookup - a
 *  custom geometry slot is a single name, not a per-shader-uniform slot list like textures. */
function geometriesFromAssets(
  assets: Record<string, FXEffectAsset>,
): Record<string, BufferGeometry> {
  const geometries: Record<string, BufferGeometry> = {};
  for (const name in assets) {
    const asset = assets[name];
    if (isBufferGeometry(asset)) {
      geometries[name] = asset;
    }
  }
  return geometries;
}

/**
 * Writes one parameter's sampled value into whichever render uniforms / behavior bindings declare
 * it - `renders` are every render artifact of one entity (an emitter's particles and trail share
 * its parameter names).
 */
function writeParameterSlots(
  renders: readonly FXRenderArtifact[],
  behavior: FXBehaviorArtifact,
  name: string,
  value: number | number[],
  uniforms: Record<string, number | number[]>,
  bindings: Record<string, number | Float32Array>,
): void {
  const uniformKey = PARAMETER_UNIFORM_PREFIX + name;
  if (renders.some((render) => uniformKey in render.uniforms)) {
    uniforms[uniformKey] = value;
  }
  const bindingKey = PARAMETER_BINDING_PREFIX + name;
  if (bindingKey in behavior.bindings) {
    bindings[bindingKey] = typeof value === "number" ? value : (value[0] ?? 0);
    return;
  }
  const vector = typeof value === "number" ? [value] : value;
  for (let i = 0; i < VECTOR_COMPONENTS.length; i += 1) {
    const key = bindingKey + "_" + VECTOR_COMPONENTS[i];
    if (key in behavior.bindings) {
      bindings[key] = vector[i] ?? 0;
    }
  }
}

/** A value slot (render uniform or behavior binding) whose `value` the value drive overwrites. */
interface FXBakedSlot {
  value?: unknown;
}

// Each slot's value as baked into the artifact, captured before anything drives it: the value
// drive writes into the artifact's own slot (see FXArtifactMaterial.applyUniformValues), so the
// slot itself only holds the last driven value. Keyed by slot, so every effect built from one
// (module-scoped, shared) artifact restores the same baked value - the first one seen.
const BAKED_VALUES = new WeakMap<FXBakedSlot, unknown>();

/** A copy of `value` no later write can reach into (an array value is replaced, never mutated). */
function copyValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return [...(value as unknown[])] as T;
  }
  return value instanceof Float32Array ? (new Float32Array(value) as T) : value;
}

/** Captures the baked value of every uniform of `render` and binding of `behavior` not yet seen. */
function snapshotBakedValues(
  renders: readonly FXRenderArtifact[],
  behavior: FXBehaviorArtifact,
): void {
  const slots: FXBakedSlot[] = [
    ...renders.flatMap((render) => Object.values(render.uniforms) as FXBakedSlot[]),
    ...(Object.values(behavior.bindings) as FXBakedSlot[]),
  ];
  for (const slot of slots) {
    if (!BAKED_VALUES.has(slot)) {
      BAKED_VALUES.set(slot, copyValue(slot.value));
    }
  }
}

/** `slot`'s baked value - see {@link snapshotBakedValues} - as a fresh copy. */
function bakedValue(slot: FXBakedSlot): unknown {
  return copyValue(BAKED_VALUES.has(slot) ? BAKED_VALUES.get(slot) : slot.value);
}

/** Restores one parameter's baked baseline (a parameter that stopped being driven this frame). */
function writeParameterBaseline(
  renders: readonly FXRenderArtifact[],
  behavior: FXBehaviorArtifact,
  name: string,
  uniforms: Record<string, number | number[]>,
  bindings: Record<string, number | Float32Array>,
): void {
  const uniformKey = PARAMETER_UNIFORM_PREFIX + name;
  // The first graph declaring the name bakes the baseline - the editor gives every declaration of
  // one name the same type and value.
  for (const render of renders) {
    const uniform = render.uniforms[uniformKey] as (typeof render.uniforms)[string] | undefined;
    // Types say `value` is defined once `"value" in uniform`, but guard the runtime
    // `{ external, value: undefined }` case so we never bake an undefined baseline.
    if (uniform === undefined || !("value" in uniform)) {
      continue;
    }
    const baked = bakedValue(uniform);
    if (baked !== undefined) {
      uniforms[uniformKey] = baked as number | number[];
      break;
    }
  }
  const bindingKey = PARAMETER_BINDING_PREFIX + name;
  for (const key in behavior.bindings) {
    if (key === bindingKey || key.startsWith(bindingKey + "_")) {
      bindings[key] = bakedValue(behavior.bindings[key]) as number | Float32Array;
    }
  }
}

// A VFX mesh has no behavior, so its value drive addresses render uniforms only; this stand-in
// makes the shared slot writer a no-op on the binding side.
const NO_BEHAVIOR_BINDINGS = { bindings: {} } as unknown as FXBehaviorArtifact;

/**
 * Runtime for a whole exported Sparcoon project: a `Group` that builds every emitter + VFX mesh
 * from precompiled artifacts and drives the shared timeline. Add it to your scene, call `play()`,
 * and `update(deltaSeconds)` each frame. Lit graphs read the scene's lights, so a lit effect needs
 * a light probe + directional light in the host scene (studio lighting is not part of the export).
 * An editor-emitted module supplies only the data (`FXEffectSpec` + a scene name) and a thin named
 * subclass; this base class is identical for every export.
 *
 * The timeline drive mirrors the editor's own transport: burst/play events fire across the
 * continuous swept interval, and while playing, transform tracks are sampled at the continuous time
 * too - a pose that held still between two frames would read as no motion on every tick between
 * them, and as a jump on the next, to anything reading the object's velocity. Value tracks are
 * frame-stepped onto the `fps` grid.
 */
export abstract class FXEffect extends Group<FXEffectEventMap> {
  private readonly specification: FXEffectSpec;
  private readonly world: FXWorld;
  private readonly emitters: FXEmitter[] = [];
  // The render artifacts resolved (by render target) from each emitter/mesh spec's
  // FXRenderArtifactsByGLSLTier - parallel to `emitters`/`meshes`, read by the parameter-drive path
  // instead of re-resolving the spec's map on every call. An emitter has its particles' artifact,
  // then its trail's when it has one; a mesh has one.
  private readonly emitterRenders: FXRenderArtifact[][] = [];
  private readonly meshRenders: FXRenderArtifact[] = [];
  private readonly meshMaterials: FXMeshMaterial[] = [];
  private readonly meshes: Mesh[] = [];
  // World-space velocity/angular-velocity tracker per mesh, parallel to `meshes`.
  private readonly meshMotionTrackers: FXObjectMotionTracker[] = [];
  private readonly emitterDriven: Set<string>[] = [];
  private readonly meshDriven: Set<string>[] = [];
  // Name -> index, for the live-update API (getEmitter/getMesh/setEmitterParam/setMeshParam). A
  // name the editor duplicated across entities resolves to the last one built (Map.set overwrites).
  private readonly emitterIndexByName = new Map<string, number>();
  private readonly meshIndexByName = new Map<string, number>();
  private time = 0;
  private lastTime = 0;
  private lastFrame = -1;
  private meshClock = 0;
  private playing = false;
  // This playback's loop choice (see play()), and whether a once-through timeline has ended: its
  // timeline then holds the last frame while particles and mesh clocks run on.
  private looping = true;
  private ended = false;
  private disposed = false;

  // Reused decompose scratch for the per-mesh motion diff (avoids a per-tick allocation); scale
  // is discarded.
  private readonly meshPositionScratch = new Vector3();
  private readonly meshQuaternionScratch = new Quaternion();
  private readonly meshScaleScratch = new Vector3();

  protected constructor(
    specification: FXEffectSpec,
    assets: Record<string, FXEffectAsset>,
    options: FXEffectOptions = {},
  ) {
    super();
    checkRuntimeVersion(specification);
    this.specification = specification;
    this.world = options.world ?? FXWorld.getDefault();
    applyTransform(this, specification.transform);
    const geometries = geometriesFromAssets(assets);
    const isWebGL2 = options.renderer?.capabilities.isWebGL2 ?? false;
    // Checked before anything is built: a throw past here would leave emitters registered in
    // the world with no effect to dispose them.
    const deathSources = deathReactionSources(specification);

    for (const [index, emitterSpec] of specification.emitters.entries()) {
      const textures = texturesForSlots(emitterSpec.externalSlots, assets);
      const render = resolveRenderArtifact(emitterSpec.render, isWebGL2);
      const trail =
        emitterSpec.trail === undefined
          ? undefined
          : {
              render: resolveRenderArtifact(emitterSpec.trail.render, isWebGL2),
              frames: emitterSpec.trail.frames,
              sampleInterval: emitterSpec.trail.sampleInterval,
            };
      const renders = trail === undefined ? [render] : [render, trail.render];
      // Before anything below drives a value into these artifacts' slots.
      snapshotBakedValues(renders, emitterSpec.behavior);
      const emitter = FXEmitter.fromArtifacts(
        render,
        emitterSpec.behavior,
        {
          textures,
          geometries,
          expectedCapacity: emitterSpec.expectedCapacity,
          castShadow: emitterSpec.castShadow ?? false,
          receiveShadow: emitterSpec.receiveShadow ?? false,
          // Only offered on an actual WebGL2 negotiation - the same `isWebGL2` signal already
          // picking `render`'s "standard" tier above. FXEmitter itself decides whether GPU setup
          // then actually succeeds, falling back to `emitterSpec.behavior` in place if not - this
          // effect never needs to know which one ends up driving a given emitter.
          gpuKernel: isWebGL2 && !deathSources.has(index) ? emitterSpec.gpuBehavior : undefined,
          renderer: options.renderer,
          trail,
        },
        this.world,
      );
      if (emitterSpec.sortInterval > 0 && trail !== undefined) {
        // The editor never exports the two together (sorting would scramble the trail's per-slot
        // history), so this is a hand-edited or mismatched spec: the trail wins.
        warnInDevelopment(
          `FXEffect: emitter "${emitterSpec.name}" has both a trail and a sortInterval - ` +
            "depth sorting is skipped on an emitter with a trail.",
        );
      } else if (options.camera !== undefined && emitterSpec.sortInterval > 0) {
        emitter.sortCamera = options.camera;
        emitter.sortFraction = 1 / emitterSpec.sortInterval;
      }
      applyTransform(emitter, emitterSpec.transform);
      this.add(emitter);
      this.emitterIndexByName.set(emitterSpec.name, this.emitters.length);
      this.emitters.push(emitter);
      this.emitterRenders.push(renders);
      this.emitterDriven.push(new Set<string>());
    }

    // Once every emitter exists: a reaction may name any of them as its source.
    for (const [index, emitterSpec] of specification.emitters.entries()) {
      for (const reaction of emitterSpec.reactions ?? []) {
        connectDeathReaction(this.emitters[reaction.source], this.emitters[index], reaction);
      }
    }

    for (const meshSpec of specification.meshes) {
      const textures = texturesForSlots(meshSpec.externalSlots, assets);
      const render = resolveRenderArtifact(meshSpec.render, isWebGL2);
      const material = new FXMeshMaterial(render, textures);
      const mesh = new Mesh(
        resolveGeometrySource(meshSpec.geometry, geometries),
        material.buildThreeMaterial(),
      );
      if (meshSpec.receiveShadow ?? false) {
        mesh.receiveShadow = true;
      }
      if (meshSpec.castShadow ?? false) {
        mesh.castShadow = true;
        mesh.customDepthMaterial = material.buildThreeDepthMaterial();
      }
      applyTransform(mesh, meshSpec.transform);
      this.add(mesh);
      this.meshIndexByName.set(meshSpec.name, this.meshes.length);
      this.meshes.push(mesh);
      snapshotBakedValues([render], NO_BEHAVIOR_BINDINGS);
      this.meshRenders.push(render);
      this.meshMaterials.push(material);
      this.meshMotionTrackers.push(new FXObjectMotionTracker());
      this.meshDriven.push(new Set<string>());
    }

    // Pose + value drive at the timeline start, so the effect shows its authored frame-0 state
    // before playback begins.
    this.driveFrame(0);

    // Self-subscribe: from here the world drives this effect every frame; dispose() unsubscribes.
    this.world.registerEffect(this);
  }

  /**
   * Restarts the timeline from the top: clears live particles and begins playback - looping, or
   * once through as authored ({@link FXEffectSpec.loop}) unless `options.loop` says otherwise. A
   * once-through timeline holds its last frame at the end and dispatches `"finished"`.
   */
  public play(options: FXEffectPlayOptions = {}): void {
    if (this.disposed) {
      return;
    }
    this.resetTransport();
    this.looping = options.loop ?? this.specification.loop ?? true;
    this.playing = true;
    this.driveFrame(0);
  }

  /** Halts playback and clears live particles, returning to the authored frame-0 state. */
  public stop(): void {
    if (this.disposed) {
      return;
    }
    this.playing = false;
    this.resetTransport();
    this.driveFrame(0);
  }

  /**
   * @internal Advances this effect one frame; driven by {@link FXWorld.update}. Drives only the
   * timeline and the meshes - the world ticks the shared particle pool separately, exactly once.
   * A stopped effect stays frozen.
   */
  public advanceFrame(deltaSeconds: number): void {
    if (this.disposed) {
      return;
    }
    // Gate the simulation on playback, exactly like the editor's transport: stopped => 0, so live
    // particles and mesh clocks hold instead of drifting while the effect is not playing.
    const simulationDelta = this.playing ? deltaSeconds : 0;
    if (this.playing && !this.ended) {
      this.advance(deltaSeconds);
    }
    this.meshClock += simulationDelta;
    for (let i = 0; i < this.meshes.length; i += 1) {
      const mesh = this.meshes[i];
      // World-space velocity/angular velocity since the previous frame, from the mesh's own
      // matrixWorld (posed by `advance()` -> `poseAt()` above, or by a host live-driving it
      // directly through `getMesh()`) - never from PARTICLE_POSITION-style local state, since a
      // mesh is a single non-instanced object with no such thing.
      mesh.updateWorldMatrix(true, false);
      mesh.matrixWorld.decompose(
        this.meshPositionScratch,
        this.meshQuaternionScratch,
        this.meshScaleScratch,
      );
      const motion = this.meshMotionTrackers[i].sample(
        {
          position: [
            this.meshPositionScratch.x,
            this.meshPositionScratch.y,
            this.meshPositionScratch.z,
          ],
          quaternion: [
            this.meshQuaternionScratch.x,
            this.meshQuaternionScratch.y,
            this.meshQuaternionScratch.z,
            this.meshQuaternionScratch.w,
          ],
        },
        simulationDelta,
      );
      const material = this.meshMaterials[i];
      material.setElapsedTime(this.meshClock);
      material.setDeltaTime(simulationDelta);
      material.setObjectVelocity(motion.velocity);
      material.setObjectAngularVelocity(motion.angularVelocity);
    }
  }

  /**
   * The runtime emitter named `name` (its `FXEmitter`, an `Object3D`) - for a live channel the
   * editor marked "fake" (see {@link FXEffectSpec}), pose it directly through its own
   * `position`/`quaternion`/`scale`; `driveFrame` never touches that channel again. `undefined`
   * for an unknown name or once disposed (matching {@link dispose}'s emptied index).
   */
  public getEmitter(name: string): FXEmitter | undefined {
    if (this.disposed) {
      return undefined;
    }
    const index = this.emitterIndexByName.get(name);
    return index === undefined ? undefined : this.emitters[index];
  }

  /** The runtime mesh named `name` (a `three.Mesh`), for the same live-channel posing as {@link getEmitter}. */
  public getMesh(name: string): Mesh | undefined {
    if (this.disposed) {
      return undefined;
    }
    const index = this.meshIndexByName.get(name);
    return index === undefined ? undefined : this.meshes[index];
  }

  /**
   * Pushes `value` into emitter `name`'s Timeline Value `parameter` (a uniform/binding slot the
   * editor marked "fake", so it is never sampled from baked keyframes). No-op for an unknown
   * emitter, or once disposed - the underlying slot writer already no-ops for an unknown parameter.
   */
  public setEmitterParam(name: string, parameter: string, value: number | readonly number[]): void {
    if (this.disposed) {
      return;
    }
    const index = this.emitterIndexByName.get(name);
    if (index === undefined) {
      return;
    }
    const specification = this.specification.emitters[index];
    const uniforms: Record<string, number | number[]> = {};
    const bindings: Record<string, number | Float32Array> = {};
    writeParameterSlots(
      this.emitterRenders[index],
      specification.behavior,
      parameter,
      materializeValue(value),
      uniforms,
      bindings,
    );
    if (Object.keys(uniforms).length > 0 || Object.keys(bindings).length > 0) {
      this.emitters[index].applyValues({ uniforms, bindings });
    }
  }

  /** Pushes `value` into mesh `name`'s Timeline Value `parameter`. See {@link setEmitterParam}. */
  public setMeshParam(name: string, parameter: string, value: number | readonly number[]): void {
    if (this.disposed) {
      return;
    }
    const index = this.meshIndexByName.get(name);
    if (index === undefined) {
      return;
    }
    const uniforms: Record<string, number | number[]> = {};
    const bindings: Record<string, number | Float32Array> = {};
    writeParameterSlots(
      [this.meshRenders[index]],
      NO_BEHAVIOR_BINDINGS,
      parameter,
      materializeValue(value),
      uniforms,
      bindings,
    );
    if (Object.keys(uniforms).length > 0) {
      this.meshMaterials[index].applyUniformValues(uniforms);
    }
  }

  /**
   * Compiles this effect's shader programs ahead of its first frame, lit by `scene`'s lights and
   * fog. Resolves once they are ready. See the README's "Compiling shaders ahead" for what it does
   * not cover and how to keep the programs compiled.
   */
  public compile(renderer: WebGLRenderer, camera: Camera, scene?: Object3D): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    return compilePrograms(renderer, this, camera, scene);
  }

  /**
   * Unsubscribes from its world, destroys every emitter, and disposes mesh resources; the group
   * empties itself from its parent. Idempotent.
   */
  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.playing = false;
    this.world.unregisterEffect(this);
    for (const emitter of this.emitters) {
      emitter.destroy();
    }
    this.emitters.length = 0;
    for (let i = 0; i < this.meshes.length; i += 1) {
      const mesh = this.meshes[i];
      // A "custom" geometry is the app's own `assets` object - only a primitive built
      // by `resolveGeometrySource` is ours to dispose.
      if (this.specification.meshes[i].geometry.type === "primitive") {
        mesh.geometry.dispose();
      }
      (mesh.material as Material).dispose();
      // Built here for a shadow caster, like the material above.
      mesh.customDepthMaterial?.dispose();
    }
    this.meshes.length = 0;
    this.meshMaterials.length = 0;
    this.removeFromParent();
  }

  private resetTransport(): void {
    this.time = 0;
    this.lastTime = 0;
    this.lastFrame = -1;
    this.ended = false;
    // meshClock is deliberately NOT reset: a mesh's time-driven shader runs on monotonic sim time,
    // decoupled from the timeline playhead, so a replay does not snap its phase back. The motion
    // trackers ARE reset - unlike meshClock's phase, a restarted effect should not report a
    // teleport-spike velocity from wherever a mesh was last posed.
    for (const emitter of this.emitters) {
      emitter.stop();
      emitter.reset();
    }
    for (const tracker of this.meshMotionTrackers) {
      tracker.reset();
    }
  }

  private advance(deltaSeconds: number): void {
    const duration = this.specification.duration;
    let now = this.time + deltaSeconds;
    if (duration > 0 && now >= duration) {
      // The end of the timeline: finish the tail from the pose at its end.
      this.poseAt(duration);
      this.fire(this.lastTime, duration);
      if (!this.looping) {
        // Once through: hold the last frame. Nothing is cleared - what is alive flies on.
        this.lastTime = duration;
        this.time = duration;
        this.ended = true;
        this.dispatchEvent({ type: "finished" });
        return;
      }
      // Loop wrap: run on into the next lap without clearing what is alive - a looping effect
      // never pops at the seam. The pose jumps back to the start, which is no motion: every motion
      // baseline is dropped, or the jump would read as a one-frame velocity spike.
      for (const emitter of this.emitters) {
        emitter.loopTimeline();
      }
      for (const tracker of this.meshMotionTrackers) {
        tracker.reset();
      }
      now = now % duration;
      this.lastTime = 0;
      this.lastFrame = -1;
    }

    // Pose and values first, events second: a burst spawns from the emitter's pose and parameters
    // at the moment it is called, so this frame's bursts must see this frame's pose - not the one
    // the previous frame left behind.
    this.poseAt(now);
    this.fire(this.lastTime, now);
    this.lastTime = now;
    this.time = now;
  }

  /** Poses every entity at `time` itself, and drives the values of the frame it falls in unless
   *  they already are. */
  private poseAt(time: number): void {
    this.poseEntities(time);
    const frame = frameOfTime(time, this.specification.fps);
    if (frame !== this.lastFrame) {
      this.lastFrame = frame;
      this.driveValues(timeOfFrame(frame, this.specification.fps));
    }
  }

  /** Fires burst/play events whose time lies in `[from, to)` on their owning emitter. */
  private fire(from: number, to: number): void {
    if (to <= from) {
      return;
    }
    for (let i = 0; i < this.specification.emitters.length; i += 1) {
      const emitter = this.emitters[i];
      for (const event of this.specification.emitters[i].events) {
        if (event.time < from || event.time >= to) {
          continue;
        }
        fireSpawnAction(emitter, event);
      }
    }
  }

  /**
   * Poses every entity and scrubs its sampled parameter values into the runtime at time `time`. The
   * root itself is never re-posed here (see {@link FXEffectSpec.transformTracks}) - only
   * emitters/meshes, and only their non-live channels/parameters.
   */
  /** Poses every entity and drives every value at `time`. */
  private driveFrame(time: number): void {
    this.poseEntities(time);
    this.driveValues(time);
  }

  private poseEntities(time: number): void {
    for (let i = 0; i < this.specification.emitters.length; i += 1) {
      const emitterSpec = this.specification.emitters[i];
      applyTransform(
        this.emitters[i],
        sampleTransform(emitterSpec.transform, emitterSpec.transformTracks, time),
        emitterSpec.liveChannels,
      );
    }
    for (let i = 0; i < this.specification.meshes.length; i += 1) {
      const meshSpec = this.specification.meshes[i];
      applyTransform(
        this.meshes[i],
        sampleTransform(meshSpec.transform, meshSpec.transformTracks, time),
        meshSpec.liveChannels,
      );
    }
  }

  private driveValues(time: number): void {
    for (let i = 0; i < this.specification.emitters.length; i += 1) {
      this.driveEmitterValues(i, sampleTracks(this.specification.emitters[i].tracks, time));
    }
    for (let i = 0; i < this.specification.meshes.length; i += 1) {
      this.driveMeshValues(i, sampleTracks(this.specification.meshes[i].tracks, time));
    }
  }

  private driveEmitterValues(index: number, values: Map<string, number | number[]>): void {
    const specification = this.specification.emitters[index];
    const renders = this.emitterRenders[index];
    const driven = this.emitterDriven[index];
    const uniforms: Record<string, number | number[]> = {};
    const bindings: Record<string, number | Float32Array> = {};
    for (const [name, value] of values) {
      writeParameterSlots(renders, specification.behavior, name, value, uniforms, bindings);
      driven.add(name);
    }
    for (const name of [...driven]) {
      if (!values.has(name)) {
        writeParameterBaseline(renders, specification.behavior, name, uniforms, bindings);
        driven.delete(name);
      }
    }
    if (Object.keys(uniforms).length > 0 || Object.keys(bindings).length > 0) {
      this.emitters[index].applyValues({ uniforms, bindings });
    }
  }

  private driveMeshValues(index: number, values: Map<string, number | number[]>): void {
    const render = this.meshRenders[index];
    const driven = this.meshDriven[index];
    const uniforms: Record<string, number | number[]> = {};
    const bindings: Record<string, number | Float32Array> = {};
    for (const [name, value] of values) {
      writeParameterSlots([render], NO_BEHAVIOR_BINDINGS, name, value, uniforms, bindings);
      driven.add(name);
    }
    for (const name of [...driven]) {
      if (!values.has(name)) {
        writeParameterBaseline([render], NO_BEHAVIOR_BINDINGS, name, uniforms, bindings);
        driven.delete(name);
      }
    }
    if (Object.keys(uniforms).length > 0) {
      this.meshMaterials[index].applyUniformValues(uniforms);
    }
  }
}

/**
 * The indices of the emitters some reaction in `specification` listens to - built on the CPU, the
 * only simulation that sees deaths.
 * @throws On a reaction naming an emitter the effect does not have, or one that cannot be fired by
 *   a death (see {@link assertDeathReactionAction}).
 */
function deathReactionSources(specification: FXEffectSpec): ReadonlySet<number> {
  const sources = new Set<number>();
  for (const emitter of specification.emitters) {
    for (const reaction of emitter.reactions ?? []) {
      if (
        !Number.isInteger(reaction.source) ||
        reaction.source < 0 ||
        reaction.source >= specification.emitters.length
      ) {
        throw new RangeError(
          `FXEffect: emitter "${emitter.name}" reacts to emitter #${String(reaction.source)}, ` +
            "which does not exist",
        );
      }
      assertDeathReactionAction(reaction, `FXEffect: emitter "${emitter.name}"`);
      sources.add(reaction.source);
    }
  }
  return sources;
}

import {
  Group,
  Mesh,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type Material,
  type Object3D,
  type Texture,
} from "three";
import type { FXBehaviorArtifact, FXRenderArtifact } from "../artifact/FXArtifact.js";
import { FXEmitter } from "../emitter/FXEmitter.js";
import { FXObjectMotionTracker } from "../emitter/FXObjectMotion.Internal.js";
import { resolveGeometrySource } from "../instancedParticle/primitiveGeometry.js";
import { FXMeshMaterial } from "../render/FXMeshMaterial.js";
import { FXWorld } from "../world/FXWorld.js";
import type {
  FXEffectOptions,
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

/** One asset slot: an external texture OR (per {@link FXGeometrySource}) an external geometry, keyed by the same flat `assets` namespace. */
type FXEffectAsset = Texture | BufferGeometry;

// Duck-typed, not `instanceof`: the app's `three` and this package's peer-dep `three` can be two
// separate module instances (e.g. hoisted differently across a workspace), which would make
// `instanceof Texture`/`instanceof BufferGeometry` false for a perfectly good asset. Every `three`
// object of these kinds carries this own-property flag regardless of which module instance built it.
function isTexture(asset: FXEffectAsset): asset is Texture {
  return (asset as { isTexture?: boolean }).isTexture === true;
}

function isBufferGeometry(asset: FXEffectAsset): asset is BufferGeometry {
  return (asset as { isBufferGeometry?: boolean }).isBufferGeometry === true;
}

function texturesForSlots(
  slots: readonly string[],
  assets: Record<string, FXEffectAsset>,
): Record<string, Texture> {
  const textures: Record<string, Texture> = {};
  for (const name of slots) {
    const asset = assets[name];
    if (isTexture(asset)) {
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

/** Writes one parameter's sampled value into whichever render uniform / behavior bindings it declares. */
function writeParameterSlots(
  render: FXRenderArtifact,
  behavior: FXBehaviorArtifact,
  name: string,
  value: number | number[],
  uniforms: Record<string, number | number[]>,
  bindings: Record<string, number | Float32Array>,
): void {
  const uniformKey = PARAMETER_UNIFORM_PREFIX + name;
  if (uniformKey in render.uniforms) {
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

/** Restores one parameter's baked baseline (a parameter that stopped being driven this frame). */
function writeParameterBaseline(
  render: FXRenderArtifact,
  behavior: FXBehaviorArtifact,
  name: string,
  uniforms: Record<string, number | number[]>,
  bindings: Record<string, number | Float32Array>,
): void {
  const uniformKey = PARAMETER_UNIFORM_PREFIX + name;
  const uniform = render.uniforms[uniformKey];
  // Types say `value` is defined once `"value" in uniform`, but guard the runtime
  // `{ external, value: undefined }` case so we never bake an undefined baseline.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (uniform !== undefined && "value" in uniform && uniform.value !== undefined) {
    uniforms[uniformKey] = uniform.value as number | number[];
  }
  const bindingKey = PARAMETER_BINDING_PREFIX + name;
  for (const key in behavior.bindings) {
    if (key === bindingKey || key.startsWith(bindingKey + "_")) {
      bindings[key] = behavior.bindings[key].value;
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
 * continuous swept interval, while value + transform tracks are frame-stepped onto the `fps` grid.
 */
export abstract class FXEffect extends Group {
  private readonly specification: FXEffectSpec;
  private readonly world: FXWorld;
  private readonly emitters: FXEmitter[] = [];
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
    this.specification = specification;
    this.world = options.world ?? FXWorld.getDefault();
    applyTransform(this, specification.transform);
    const geometries = geometriesFromAssets(assets);

    for (const emitterSpec of specification.emitters) {
      const textures = texturesForSlots(emitterSpec.externalSlots, assets);
      const emitter = FXEmitter.fromArtifacts(
        emitterSpec.render,
        emitterSpec.behavior,
        {
          textures,
          geometries,
          expectedCapacity: emitterSpec.expectedCapacity,
          castShadow: emitterSpec.castShadow ?? false,
          receiveShadow: emitterSpec.receiveShadow ?? false,
        },
        this.world,
      );
      if (options.camera !== undefined && emitterSpec.sortInterval > 0) {
        emitter.sortCamera = options.camera;
        emitter.sortFraction = 1 / emitterSpec.sortInterval;
      }
      applyTransform(emitter, emitterSpec.transform);
      this.add(emitter);
      this.emitterIndexByName.set(emitterSpec.name, this.emitters.length);
      this.emitters.push(emitter);
      this.emitterDriven.push(new Set<string>());
    }

    for (const meshSpec of specification.meshes) {
      const textures = texturesForSlots(meshSpec.externalSlots, assets);
      const material = new FXMeshMaterial(meshSpec.render, textures);
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

  /** Restarts the timeline from the top: clears live particles and begins playback. */
  public play(): void {
    if (this.disposed) {
      return;
    }
    this.resetTransport();
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
    if (this.playing) {
      this.advance(deltaSeconds);
    }
    this.meshClock += simulationDelta;
    for (let i = 0; i < this.meshes.length; i += 1) {
      const mesh = this.meshes[i];
      // World-space velocity/angular velocity since the previous frame, from the mesh's own
      // matrixWorld (posed by `advance()` -> `driveFrame()` above, or by a host live-driving it
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
      specification.render,
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
    const specification = this.specification.meshes[index];
    const uniforms: Record<string, number | number[]> = {};
    const bindings: Record<string, number | Float32Array> = {};
    writeParameterSlots(
      specification.render,
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
    }
    this.meshes.length = 0;
    this.meshMaterials.length = 0;
    this.removeFromParent();
  }

  private resetTransport(): void {
    this.time = 0;
    this.lastTime = 0;
    this.lastFrame = -1;
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
      // Loop wrap: finish this lap's tail, reset, then replay from the remainder.
      this.fire(this.lastTime, duration);
      for (const emitter of this.emitters) {
        emitter.stop();
        emitter.reset();
      }
      now = now % duration;
      this.lastTime = 0;
      this.lastFrame = -1;
    }
    this.fire(this.lastTime, now);
    this.lastTime = now;
    this.time = now;

    const frame = frameOfTime(now, this.specification.fps);
    if (frame !== this.lastFrame) {
      this.lastFrame = frame;
      this.driveFrame(timeOfFrame(frame, this.specification.fps));
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
        // Guard degenerate authored counts/rates: FXEmitter asserts a positive count/rate and would
        // throw straight out of the host's frame loop, so a zero-count burst is a no-op here.
        if (event.kind === "burst") {
          if (event.count > 0) {
            emitter.burst(event.count);
          }
        } else if (event.rate > 0) {
          emitter.play(event.rate, event.duration > 0 ? { duration: event.duration } : {});
        }
      }
    }
  }

  /**
   * Poses every entity and scrubs its sampled parameter values into the runtime at time `time`. The
   * root itself is never re-posed here (see {@link FXEffectSpec.transformTracks}) - only
   * emitters/meshes, and only their non-live channels/parameters.
   */
  private driveFrame(time: number): void {
    for (let i = 0; i < this.specification.emitters.length; i += 1) {
      const emitterSpec = this.specification.emitters[i];
      applyTransform(
        this.emitters[i],
        sampleTransform(emitterSpec.transform, emitterSpec.transformTracks, time),
        emitterSpec.liveChannels,
      );
      this.driveEmitterValues(i, sampleTracks(emitterSpec.tracks, time));
    }

    for (let i = 0; i < this.specification.meshes.length; i += 1) {
      const meshSpec = this.specification.meshes[i];
      applyTransform(
        this.meshes[i],
        sampleTransform(meshSpec.transform, meshSpec.transformTracks, time),
        meshSpec.liveChannels,
      );
      this.driveMeshValues(i, sampleTracks(meshSpec.tracks, time));
    }
  }

  private driveEmitterValues(index: number, values: Map<string, number | number[]>): void {
    const specification = this.specification.emitters[index];
    const driven = this.emitterDriven[index];
    const uniforms: Record<string, number | number[]> = {};
    const bindings: Record<string, number | Float32Array> = {};
    for (const [name, value] of values) {
      writeParameterSlots(
        specification.render,
        specification.behavior,
        name,
        value,
        uniforms,
        bindings,
      );
      driven.add(name);
    }
    for (const name of [...driven]) {
      if (!values.has(name)) {
        writeParameterBaseline(
          specification.render,
          specification.behavior,
          name,
          uniforms,
          bindings,
        );
        driven.delete(name);
      }
    }
    if (Object.keys(uniforms).length > 0 || Object.keys(bindings).length > 0) {
      this.emitters[index].applyValues({ uniforms, bindings });
    }
  }

  private driveMeshValues(index: number, values: Map<string, number | number[]>): void {
    const specification = this.specification.meshes[index];
    const driven = this.meshDriven[index];
    const uniforms: Record<string, number | number[]> = {};
    const bindings: Record<string, number | Float32Array> = {};
    for (const [name, value] of values) {
      writeParameterSlots(
        specification.render,
        NO_BEHAVIOR_BINDINGS,
        name,
        value,
        uniforms,
        bindings,
      );
      driven.add(name);
    }
    for (const name of [...driven]) {
      if (!values.has(name)) {
        writeParameterBaseline(
          specification.render,
          NO_BEHAVIOR_BINDINGS,
          name,
          uniforms,
          bindings,
        );
        driven.delete(name);
      }
    }
    if (Object.keys(uniforms).length > 0) {
      this.meshMaterials[index].applyUniformValues(uniforms);
    }
  }
}

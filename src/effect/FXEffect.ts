import {
  type BufferGeometry,
  type Camera,
  type Data3DTexture,
  Group,
  type Material,
  Mesh,
  type Object3D,
  type WebGLRenderer,
} from "three";

import type {
  FXBehaviorArtifact,
  FXRenderArtifact,
  FXRenderArtifactsByGLSLTier,
} from "../artifact/FXArtifact.js";
import { ownValue } from "../artifact/FXValueSlots.Internal.js";
import type { FXEmitterSortOptions } from "../emitter/FXEmitter.Internal.js";
import { asParticleEventKind } from "../emitter/FXEmitter.Internal.js";
import { cameraUseOf, FXEmitter } from "../emitter/FXEmitter.js";
import type { FXAppAssets } from "../emitter/FXFromArtifactsOptions.js";
import { assertValidInheritCopies } from "../emitter/FXInheritance.js";
import { whenProgramsSettle } from "../emitter/FXLinkedProgram.Internal.js";
import { FXObjectMotionTracker } from "../emitter/FXObjectMotion.Internal.js";
import { particleSlotLayout } from "../instancedParticle/FXParticleSlot.js";
import { resolveGeometrySource } from "../instancedParticle/primitiveGeometry.js";
import { warnInDevelopment } from "../miscellaneous/asserts.js";
import {
  createDrawFrame,
  fillObjectDrawFrame,
  type FXDrawFrame,
  nextObjectSeed,
} from "../render/FXDrawFrame.Internal.js";
import type { FXExternalTexture } from "../render/FXExternalTexture.js";
import { FXMeshMaterial } from "../render/FXMeshMaterial.js";
import { compilePrograms } from "../render/FXProgramCompile.Internal.js";
import { FX_STRIP_KINDS, type FXStripKind, type FXStripOptions } from "../strip/FXStripOptions.js";
import { FXWorld } from "../world/FXWorld.js";
import {
  frameOfTime,
  normalizeQuaternion,
  sampleTracks,
  sampleTransform,
  timeOfFrame,
} from "./FXEffectSampling.Internal.js";
import type {
  FXEffectEmitterSpec,
  FXEffectEventMap,
  FXEffectOptions,
  FXEffectPlayOptions,
  FXEffectSpec,
  FXEffectStripSpec,
  FXTransform,
  FXTransformChannel,
} from "./FXEffectSpec.js";
import { checkRuntimeVersion } from "./FXRuntimeVersion.Internal.js";
import { assertReactionAction, connectReaction, fireSpawnAction } from "./FXSpawnAction.js";

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

/** One asset slot, one of: an external texture (whole, or a region of one), an external geometry (per
 *  {@link FXGeometrySource}, or a mesh surface sampled as a shape), a mesh of the scene a behavior
 *  samples, or a 3D texture, keyed by the same flat `assets` namespace. */
type FXEffectAsset = FXExternalTexture | BufferGeometry | Mesh | Data3DTexture;

/**
 * Where `asset` is looked up from: a texture is none of these. Duck-typed, not `instanceof`: the
 * app's `three` and this package's peer-dep `three` can be two separate module instances (e.g.
 * hoisted differently across a workspace), which would make `instanceof` false for a perfectly
 * good asset. Every `three` object of these kinds carries its own-property flag regardless of which
 * module instance built it.
 */
function namedKindOf(asset: FXEffectAsset): keyof FXAppAssets | undefined {
  const flags = asset as {
    isBufferGeometry?: boolean;
    isMesh?: boolean;
    isData3DTexture?: boolean;
  };
  if (flags.isBufferGeometry === true) {
    return "geometries";
  }
  if (flags.isMesh === true) {
    return "meshes";
  }
  return flags.isData3DTexture === true ? "volumes" : undefined;
}

function texturesForSlots(
  slots: readonly string[],
  assets: Record<string, FXEffectAsset>,
): Record<string, FXExternalTexture> {
  const textures: Record<string, FXExternalTexture> = {};
  for (const name of slots) {
    const asset = assets[name];
    if (namedKindOf(asset) === undefined) {
      textures[PARAMETER_UNIFORM_PREFIX + name] = asset as FXExternalTexture;
    }
  }
  return textures;
}

/** The geometries, meshes and 3D textures of `assets`, each by its name - what a geometry source and
 *  a behavior's resources look up - by a single name, not a per-shader-uniform slot list like
 *  textures. A mesh's geometry is among the geometries under its name. */
function namedAssets(assets: Record<string, FXEffectAsset>): FXAppAssets {
  const named: FXAppAssets = { geometries: {}, meshes: {}, volumes: {} };
  for (const name in assets) {
    const asset = assets[name];
    const kind = namedKindOf(asset);
    if (kind !== undefined) {
      (named[kind] as Record<string, FXEffectAsset>)[name] = asset;
    }
    if (kind === "meshes") {
      named.geometries[name] = (asset as Mesh).geometry;
    }
  }
  return named;
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
    const baked: unknown = ownValue(uniform.value);
    if (baked !== undefined) {
      uniforms[uniformKey] = baked as number | number[];
      break;
    }
  }
  const bindingKey = PARAMETER_BINDING_PREFIX + name;
  for (const key in behavior.bindings) {
    if (key === bindingKey || key.startsWith(bindingKey + "_")) {
      bindings[key] = ownValue(behavior.bindings[key].value);
    }
  }
}

// A VFX mesh has no behavior, so its value drive addresses render uniforms only; this stand-in
// makes the shared slot writer a no-op on the binding side.
const NO_BEHAVIOR_BINDINGS = { bindings: {} } as unknown as FXBehaviorArtifact;

// Effects draw with `ShaderMaterial`s and drive raw WebGL2 buffers, which `WebGPURenderer` does not
// run, even on its WebGL2 backend. Refused up front, so the caller gets this message and not a
// TypeError or a blank frame.
function requireWebGLRenderer(renderer: WebGLRenderer): void {
  if ((renderer as { isWebGLRenderer?: unknown }).isWebGLRenderer !== true) {
    throw new Error("FXEffect: needs a WebGLRenderer - WebGPURenderer is not supported");
  }
}

/**
 * Checks the renderer of an effect built without `options.renderer` on its first draw: three calls
 * every drawn object's `onBeforeRender` with the renderer drawing it. Once one mesh passed, the
 * check is removed from every mesh that still has it, so later frames pay nothing and a hook the
 * caller set in the meantime stays. A failing check stays and throws every frame.
 */
function checkRendererOnFirstDraw(effect: Object3D): void {
  const meshes: Object3D[] = [];
  effect.traverse((object) => {
    if (object instanceof Mesh) {
      meshes.push(object);
    }
  });
  const check = (renderer: WebGLRenderer): void => {
    requireWebGLRenderer(renderer);
    for (const mesh of meshes) {
      if (mesh.onBeforeRender === check) {
        Reflect.deleteProperty(mesh, "onBeforeRender");
      }
    }
  };
  for (const mesh of meshes) {
    mesh.onBeforeRender = check;
  }
}

/**
 * A `Group` that builds every emitter and VFX mesh of an exported project and drives the shared
 * timeline. Add it to the scene, call `play()` and `update(deltaSeconds)`. A lit effect needs a
 * light probe and a directional light in the host scene.
 *
 * Burst and play events fire across the swept interval, and transform tracks are sampled at
 * continuous time while playing, so a pose that held still between two frames does not read as no
 * motion and then a jump. Value tracks are stepped onto the `fps` grid.
 */
export abstract class FXEffect extends Group<FXEffectEventMap> {
  private readonly specification: FXEffectSpec;
  private readonly world: FXWorld;
  private readonly emitters: FXEmitter[] = [];
  // The render artifacts resolved (by render target) from each emitter/mesh spec's
  // FXRenderArtifactsByGLSLTier - parallel to `emitters`/`meshes`, read by the parameter-drive path
  // instead of re-resolving the spec's map on every call. An emitter has its particles' artifact,
  // its trail's and its ribbon's, each when it has one; a mesh has one.
  private readonly emitterRenders: FXRenderArtifact[][] = [];
  private readonly meshRenders: FXRenderArtifact[] = [];
  private readonly meshMaterials: FXMeshMaterial[] = [];
  private readonly meshes: Mesh[] = [];
  // World-space velocity/angular-velocity tracker per mesh, parallel to `meshes`.
  private readonly meshMotionTrackers: FXObjectMotionTracker[] = [];
  // Each mesh's own seed (see FXDrawInputs.seed), taken as it is built.
  private readonly meshSeeds: number[] = [];
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
  // Filled in place for each mesh each frame (see advanceFrame).
  private readonly meshDrawFrame: FXDrawFrame = createDrawFrame();
  private playing = false;
  // This playback's loop choice (see play()), and whether a once-through timeline has ended: its
  // timeline then holds the last frame while particles and mesh clocks run on.
  private looping = true;
  private ended = false;
  // `"drained"` went out for this playback.
  private drained = false;
  private disposed = false;

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
    const { geometries, meshes, volumes } = namedAssets(assets);
    if (options.renderer !== undefined) {
      requireWebGLRenderer(options.renderer);
    }
    const isWebGL2 = options.renderer?.capabilities.isWebGL2 ?? false;
    // Checked before anything is built: a throw past here would leave emitters registered in
    // the world with no effect to dispose them.
    const eventSources = reactionSources(specification);
    // The GPU behavior is offered only on WebGL2. FXEmitter decides whether GPU setup succeeds and
    // falls back to `behavior` if not.
    const gpuKernels = specification.emitters.map((emitterSpec, index) =>
      isWebGL2 && !eventSources.has(index) ? emitterSpec.gpuBehavior : undefined,
    );
    const sorts = specification.emitters.map((emitterSpec, index) => {
      const sort = sortOptionsOf(emitterSpec);
      // Checked here, before anything is built: FXEmitter.fromArtifacts would throw only after
      // earlier emitters joined the world.
      const cameraUse = cameraUseOf({
        sort,
        gpuKernel: gpuKernels[index],
        renderer: options.renderer,
      });
      if (cameraUse !== undefined && options.camera === undefined) {
        throw new Error(
          `FXEffect: emitter "${emitterSpec.name}" ${cameraUse} from a camera - pass options.camera`,
        );
      }
      return sort;
    });

    for (const [index, emitterSpec] of specification.emitters.entries()) {
      const textures = texturesForSlots(emitterSpec.externalSlots, assets);
      const render =
        emitterSpec.render === undefined
          ? undefined
          : resolveRenderArtifact(emitterSpec.render, isWebGL2);
      const strips = stripOptionsOf(emitterSpec, isWebGL2);
      const renders = [render, ...FX_STRIP_KINDS.map((kind) => strips[kind]?.render)].filter(
        (each): each is FXRenderArtifact => each !== undefined,
      );
      const sort = sorts[index];
      const emitter = FXEmitter.fromArtifacts(
        emitterSpec.behavior,
        {
          ...(render === undefined ? {} : { particles: render }),
          textures,
          geometries,
          meshes,
          volumes,
          expectedCapacity: emitterSpec.expectedCapacity,
          ...(emitterSpec.maxLifetime === undefined
            ? {}
            : { maxLifetime: emitterSpec.maxLifetime }),
          castShadow: emitterSpec.castShadow ?? false,
          receiveShadow: emitterSpec.receiveShadow ?? false,
          gpuKernel: gpuKernels[index],
          renderer: options.renderer,
          ...(options.camera === undefined ? {} : { camera: options.camera }),
          ...strips,
          ...(sort === undefined ? {} : { sort }),
        },
        this.world,
      );
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
        connectReaction(
          this.emitters[reaction.source],
          reaction.on ?? "death",
          this.emitters[index],
          reaction,
          reaction.copies,
        );
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
      this.meshRenders.push(render);
      this.meshMaterials.push(material);
      this.meshMotionTrackers.push(new FXObjectMotionTracker());
      this.meshSeeds.push(nextObjectSeed());
      this.meshDriven.push(new Set<string>());
    }

    // Pose + value drive at the timeline start, so the effect shows its authored frame-0 state
    // before playback begins.
    this.driveFrame(0);

    // Self-subscribe: from here the world drives this effect every frame; dispose() unsubscribes.
    this.world.registerEffect(this);
    if (options.renderer === undefined) {
      checkRendererOnFirstDraw(this);
    }
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
    // The emitters tick after this, so a drain shows here a frame late.
    if (this.ended && !this.drained && this.emitters.every((emitter) => emitter.isSettled)) {
      this.drained = true;
      this.dispatchEvent({ type: "drained" });
    }
    this.meshClock += simulationDelta;
    for (let i = 0; i < this.meshes.length; i += 1) {
      const mesh = this.meshes[i];
      // World-space velocity and angular velocity since the previous frame, from the mesh's
      // `matrixWorld`.
      this.meshMaterials[i].advance(
        fillObjectDrawFrame(
          this.meshDrawFrame,
          this.meshMotionTrackers[i],
          mesh,
          this.meshClock,
          simulationDelta,
          this.meshSeeds[i],
        ),
      );
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
   * fog, and waits for its GPU simulation ({@link simulationReady}). Resolves once both are ready.
   * See the README's "Compiling ahead" for what it does not cover and how to keep the programs
   * compiled.
   */
  public compile(renderer: WebGLRenderer, camera: Camera, scene?: Object3D): Promise<void> {
    try {
      requireWebGLRenderer(renderer);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.disposed) {
      return Promise.resolve();
    }
    const drawPrograms = compilePrograms(renderer, this, camera, scene);
    return Promise.all([drawPrograms, this.simulationReady()]).then(() => undefined);
  }

  /**
   * Resolves once the programs of its GPU simulation have built: the ones sparcoon builds itself,
   * sent off when the effect was created. The draw programs three builds are not among them -
   * {@link compile} covers both. A program that failed to build resolves it as well, and the
   * failure is logged (see {@link FXEmitter.simulationFailure}).
   */
  public simulationReady(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    return whenProgramsSettle(this.emitters.flatMap((emitter) => emitter.simulationPrograms));
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
    this.drained = false;
    // meshClock is not reset: a mesh's shader runs on monotonic time, so a replay does not jump its
    // phase. The motion trackers are reset, so a restart reports no velocity spike.
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

/** The options of each strip `emitterSpec` has, its render artifact resolved for the tier. */
function stripOptionsOf(
  emitterSpec: FXEffectEmitterSpec,
  isWebGL2: boolean,
): { readonly [K in FXStripKind]?: FXStripOptions[K] } {
  const { trail, ribbon } = emitterSpec;
  return {
    ...(trail === undefined ? {} : { trail: resolveStrip<"trail">(trail, isWebGL2) }),
    ...(ribbon === undefined ? {} : { ribbon: resolveStrip<"ribbon">(ribbon, isWebGL2) }),
  };
}

/** A strip's options from its spec: the same fields, with the render artifact of the tier. */
function resolveStrip<K extends FXStripKind>(
  spec: FXEffectStripSpec<K>,
  isWebGL2: boolean,
): FXStripOptions[K] {
  // `Omit<options, "render">` plus a render artifact is the options, which TypeScript cannot follow
  // through the generic `K`.
  return { ...spec, render: resolveRenderArtifact(spec.render, isWebGL2) } as FXStripOptions[K];
}

/**
 * How the emitter of `emitterSpec` sorts: not at all without a sort interval, nor without drawn
 * particles or with a trail or a ribbon, which win - the editor never exports them together (on
 * the CPU a sort moves particles between the slots a strip follows), so that is a hand-edited or
 * mismatched spec.
 */
function sortOptionsOf(emitterSpec: FXEffectEmitterSpec): FXEmitterSortOptions | undefined {
  if (emitterSpec.sortInterval <= 0) {
    return undefined;
  }
  const conflict =
    emitterSpec.render === undefined
      ? "draws no particles"
      : emitterSpec.trail !== undefined
        ? "has a trail"
        : emitterSpec.ribbon !== undefined
          ? "has a ribbon"
          : undefined;
  if (conflict !== undefined) {
    warnInDevelopment(
      `FXEffect: emitter "${emitterSpec.name}" ${conflict} and has a sortInterval - ` +
        "depth sorting is skipped.",
    );
    return undefined;
  }
  return { fraction: 1 / emitterSpec.sortInterval };
}

/**
 * The indices of the emitters some reaction in `specification` listens to - built on the CPU, the
 * only simulation that sees its particles' births and deaths.
 * @throws On a reaction naming an emitter the effect does not have, one naming no particle event,
 *   one that cannot be fired by a particle event (see {@link assertReactionAction}), or one whose
 *   copies do not fit its source's slot and its emitter's inherit layout (see
 *   {@link assertValidInheritCopies}).
 */
function reactionSources(specification: FXEffectSpec): ReadonlySet<number> {
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
      if (reaction.on !== undefined && asParticleEventKind(reaction.on) === undefined) {
        throw new Error(
          `FXEffect: emitter "${emitter.name}" reacts on ${reaction.on}, which is no ` +
            "particle event",
        );
      }
      assertReactionAction(reaction, `FXEffect: emitter "${emitter.name}"`);
      // A source is built on the CPU, so its slot is its JS behavior's.
      assertValidInheritCopies(
        reaction.copies ?? [],
        particleSlotLayout(specification.emitters[reaction.source].behavior.buffers).stride,
        emitter.behavior.inherit?.stride ?? 0,
        `FXEffect: emitter "${emitter.name}" reaction copies`,
      );
      sources.add(reaction.source);
    }
  }
  return sources;
}

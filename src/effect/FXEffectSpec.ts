import type { Camera, Object3DEventMap, WebGLRenderer } from "three";
import type {
  FXBehaviorArtifact,
  FXGeometrySource,
  FXParticleKernelArtifact,
  FXRenderArtifactsByGLSLTier,
} from "../artifact/FXArtifact.js";
import type { FXWorld } from "../world/FXWorld.js";

/**
 * Data shapes for {@link FXEffect}: a whole exported project (every emitter + VFX mesh, its
 * timeline and transforms) as plain, JSON-serializable data. The editor emits an `FXEffectSpec`
 * literal into every project module; this file plus {@link FXEffect} is the runtime that plays it
 * back, so the editor no longer needs to emit this scaffolding itself.
 *
 * Everything here is `readonly` so it structurally matches the editor's own `Transform` /
 * `TransformTrack` / `AnimationTrack` model types - the editor's richer `Keyframe` (which also
 * carries a UI-only `id`) is a valid `FXKeyframe` too, so the sampling functions in
 * {@link FXEffectSampling.Internal.ts} serve both.
 */

export type FXVec3 = readonly [number, number, number];
export type FXQuat = readonly [number, number, number, number];

export interface FXTransform {
  readonly position: FXVec3;
  readonly rotation: FXQuat;
  readonly scale: FXVec3;
}

/**
 * How a value moves from a key to the next one: at a constant rate (`"linear"`), or easing in
 * (starting slow), out (arriving slow) or both - cubic curves, as animation tools usually offer.
 */
export type FXKeyEase = "linear" | "in" | "out" | "inOut";

export interface FXKeyframe {
  readonly time: number;
  readonly value: number | readonly number[];
  /** The curve from this key to the next; `"linear"` when absent. */
  readonly ease?: FXKeyEase;
}

/** A named value track (drives a render uniform / behavior binding by parameter name). */
export interface FXTrack {
  readonly name: string;
  readonly keys: readonly FXKeyframe[];
}

export type FXTransformChannel = "position" | "rotation" | "scale";

export interface FXTransformTrack {
  readonly channel: FXTransformChannel;
  readonly keys: readonly FXKeyframe[];
}

/** A timeline event: an instantaneous burst or a sustained emission rate over a window. */
export type FXEffectEvent =
  | { readonly kind: "burst"; readonly time: number; readonly count: number }
  | {
      readonly kind: "play";
      readonly time: number;
      readonly rate: number;
      readonly duration: number;
    };

/** One emitter's precompiled artifacts, transform, and timeline. */
export interface FXEffectEmitterSpec {
  /** The editor-authored name, addressing this emitter through {@link FXEffect.getEmitter} etc. */
  readonly name: string;
  readonly render: FXRenderArtifactsByGLSLTier;
  readonly behavior: FXBehaviorArtifact;
  /**
   * The standard-tier (WebGL2, transform-feedback) behavior artifact - present only when this
   * emitter's spawn node had "Try GPU simulation" on and the graph compiled to GLSL. `behavior`
   * above is always present regardless - the mandatory JS fallback, including for the
   * WebGL2->WebGL1 emergency downgrade - so a spec is never left with only this field and no JS
   * twin. {@link FXEffect} passes this to
   * `FXEmitter.fromArtifacts` only when the live renderer actually negotiated WebGL2 (the same
   * `isWebGL2` signal that already picks `render`'s "standard" tier); the runtime decides for
   * itself whether GPU setup then actually succeeds, falling back to `behavior` in place if not.
   */
  readonly gpuBehavior?: FXParticleKernelArtifact;
  readonly expectedCapacity: number;
  readonly sortInterval: number;
  /**
   * A trail behind every particle (the emitter's trail graph), absent when the emitter has none.
   * Its Timeline Values share the emitter's parameter names: one name drives every graph that
   * declares it. Never exported together with a `sortInterval` above zero.
   */
  readonly trail?: FXEffectTrailSpec;
  /** Casts a shape-aware shadow; omitted (treated as false) by pre-shadow exports. */
  readonly castShadow?: boolean;
  /** Receives shadows; omitted (treated as false) by pre-shadow exports. */
  readonly receiveShadow?: boolean;
  /**
   * The external texture slots this emitter binds from the effect's `assets` - those of its render
   * graph and, when it has a {@link trail}, its trail graph's too: both materials are built from
   * this one list.
   */
  readonly externalSlots: readonly string[];
  readonly transform: FXTransform;
  readonly transformTracks: readonly FXTransformTrack[];
  readonly tracks: readonly FXTrack[];
  readonly events: readonly FXEffectEvent[];
  /** Transform channels the editor marked "fake": never sampled from `transformTracks`, left for
   * {@link FXEffect.getEmitter} to drive directly. */
  readonly liveChannels: readonly FXTransformChannel[];
  /** Timeline Value names the editor marked "fake": excluded from `tracks`, driven only through
   * {@link FXEffect.setEmitterParam}. */
  readonly liveParams: readonly string[];
}

/** An emitter's trail: its render artifact per GLSL tier and how much path it keeps. */
export interface FXEffectTrailSpec {
  readonly render: FXRenderArtifactsByGLSLTier;
  /** Recorded points per particle. */
  readonly frames: number;
  /** Seconds between two recorded points. */
  readonly sampleInterval: number;
}

/** One VFX mesh's precompiled render artifact, transform, and value tracks (no behavior/events). */
export interface FXEffectMeshSpec {
  /** The editor-authored name, addressing this mesh through {@link FXEffect.getMesh} etc. */
  readonly name: string;
  readonly render: FXRenderArtifactsByGLSLTier;
  readonly geometry: FXGeometrySource;
  /** See {@link FXEffectEmitterSpec.castShadow}. */
  readonly castShadow?: boolean;
  /** See {@link FXEffectEmitterSpec.receiveShadow}. */
  readonly receiveShadow?: boolean;
  readonly externalSlots: readonly string[];
  readonly transform: FXTransform;
  readonly transformTracks: readonly FXTransformTrack[];
  readonly tracks: readonly FXTrack[];
  /** See {@link FXEffectEmitterSpec.liveChannels}. */
  readonly liveChannels: readonly FXTransformChannel[];
  /** See {@link FXEffectEmitterSpec.liveParams}. */
  readonly liveParams: readonly string[];
}

/** A whole exported project: duration/fps, root transform, and every emitter + mesh. */
export interface FXEffectSpec {
  readonly duration: number;
  readonly fps: number;
  /**
   * Whether the timeline loops (the default, and what a module exported before this field existed
   * does) or plays once and holds its last frame. `FXEffect.play` can override it per playback.
   */
  readonly loop?: boolean;
  readonly transform: FXTransform;
  /**
   * Always empty: the editor forces every root transform channel "fake", so the root pose is
   * never sampled after construction (see {@link FXEffect}) - the consumer poses the effect
   * instance itself through the inherited `Object3D` position/quaternion/scale, like any other
   * `Group` added to a scene.
   */
  readonly transformTracks: readonly FXTransformTrack[];
  readonly emitters: readonly FXEffectEmitterSpec[];
  readonly meshes: readonly FXEffectMeshSpec[];
}

/** How one {@link FXEffect.play} plays the timeline. */
export interface FXEffectPlayOptions {
  /** Overrides the authored {@link FXEffectSpec.loop} for this playback. */
  readonly loop?: boolean;
}

/** The events an {@link FXEffect} dispatches, on top of three's own `Object3D` ones. */
export interface FXEffectEventMap extends Object3DEventMap {
  /**
   * A timeline that does not loop reached its end: every event has fired and the last frame is
   * posed. Particles already alive keep flying until their lifetimes run out - the effect is not
   * cleared, so hide or dispose it when they are done. Never dispatched by a looping timeline, or
   * by one of zero duration.
   */
  finished: object;
}

/** Options shared by every {@link FXEffect}. */
export interface FXEffectOptions {
  /** Camera enabling per-emitter depth sorting (only emitters authored with a sort interval sort). */
  readonly camera?: Camera;
  /**
   * The tick domain this effect joins. Omit to join the lazily created default world, which the
   * static {@link FXWorld.update} advances. Pass an {@link FXWorld} to isolate the effect in its
   * own clock and particle pool (an independent time scale, or a group you tick separately).
   */
  readonly world?: FXWorld;
  /**
   * The renderer this effect will draw through: `renderer.capabilities.isWebGL2` picks each
   * emitter/mesh's `"standard"` or `"baseline"` artifact (see {@link FXRenderArtifactsByGLSLTier}).
   * Omit to get the `"baseline"` artifact unconditionally (the pre-split behavior).
   */
  readonly renderer?: WebGLRenderer;
}

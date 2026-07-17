import type { Camera } from "three";
import type {
  FXBehaviorArtifact,
  FXGeometrySource,
  FXRenderArtifact,
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

export interface FXKeyframe {
  readonly time: number;
  readonly value: number | readonly number[];
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
  readonly render: FXRenderArtifact;
  readonly behavior: FXBehaviorArtifact;
  readonly expectedCapacity: number;
  readonly sortInterval: number;
  /** Casts a shape-aware shadow; omitted (treated as false) by pre-shadow exports. */
  readonly castShadow?: boolean;
  /** Receives shadows; omitted (treated as false) by pre-shadow exports. */
  readonly receiveShadow?: boolean;
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

/** One VFX mesh's precompiled render artifact, transform, and value tracks (no behavior/events). */
export interface FXEffectMeshSpec {
  /** The editor-authored name, addressing this mesh through {@link FXEffect.getMesh} etc. */
  readonly name: string;
  readonly render: FXRenderArtifact;
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
}

import type { BufferGeometry, Texture } from "three";
import { FXEffect } from "../../src/effect/FXEffect";
import type {
  FXEffectEmitterSpec,
  FXEffectMeshSpec,
  FXEffectOptions,
  FXEffectSpec,
  FXTransform,
} from "../../src/effect/FXEffectSpec";
import { behaviorArtifact, renderForBothTargets, unlitArtifact } from "./artifacts";

/** Hand-written effect specs - what an editor-emitted module hands `FXEffect` - for the effect tests. */

export const IDENTITY_TRANSFORM: FXTransform = {
  position: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
};

/** An unlit emitter with long-lived particles and nothing on its timeline. Override any field. */
export function emitterSpec(
  name: string,
  over: Partial<FXEffectEmitterSpec> = {},
): FXEffectEmitterSpec {
  return {
    name,
    render: renderForBothTargets(unlitArtifact()),
    behavior: behaviorArtifact({ lifetime: 100 }),
    expectedCapacity: 64,
    sortInterval: 0,
    externalSlots: [],
    transform: IDENTITY_TRANSFORM,
    transformTracks: [],
    tracks: [],
    events: [],
    liveChannels: [],
    liveParams: [],
    ...over,
  };
}

/** An unlit plane mesh with nothing on its timeline. Override any field. */
export function meshSpec(name: string, over: Partial<FXEffectMeshSpec> = {}): FXEffectMeshSpec {
  return {
    name,
    render: renderForBothTargets(unlitArtifact()),
    geometry: { type: "primitive", primitive: "plane" },
    externalSlots: [],
    transform: IDENTITY_TRANSFORM,
    transformTracks: [],
    tracks: [],
    liveChannels: [],
    liveParams: [],
    ...over,
  };
}

/** A zero-length effect at the origin, with no emitters or meshes. Override any field. */
export function effectSpec(over: Partial<FXEffectSpec> = {}): FXEffectSpec {
  return {
    duration: 0,
    fps: 30,
    transform: IDENTITY_TRANSFORM,
    transformTracks: [],
    emitters: [],
    meshes: [],
    ...over,
  };
}

/** `FXEffect` with a public constructor, standing in for an editor-emitted module's subclass. */
export class TestEffect extends FXEffect {
  public constructor(
    specification: FXEffectSpec,
    options: FXEffectOptions = {},
    assets: Record<string, Texture | BufferGeometry> = {},
  ) {
    super(specification, assets, options);
  }
}

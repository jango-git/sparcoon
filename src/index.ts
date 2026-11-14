// Public surface of the thin runtime: an editor-emitted module subclasses FXEffect, joins an
// FXWorld, and is driven by a single FXWorld.update per frame - plus the runtime-owned types the
// editor imports (artifact contracts and the core layout). No graph, compiler, validator, or live
// protocol lives here.

export type {
  FXAttributeDecl,
  FXBehaviorArtifact,
  FXBufferLayout,
  FXFragmentStageSource,
  FXGeometrySource,
  FXInheritLayout,
  FXKernelDrawInputs,
  FXKernelUniformValue,
  FXParticleKernelArtifact,
  FXParticleReads,
  FXRenderArtifact,
  FXRenderProgram,
  FXShaderStageSource,
  FXSurfaceReads,
  FXUniformInit,
  FXValueSlot,
  FXVaryingDecl,
} from "./artifact/FXArtifact.js";
export type { FXGeometryPrimitive } from "./artifact/FXArtifact.js";
export {
  FX_TRANSFORM_FEEDBACK_BIRTH_AGE_COUNT_UNIFORM,
  FX_TRANSFORM_FEEDBACK_BIRTH_AGES_UNIFORM,
  FX_TRANSFORM_FEEDBACK_CAPACITY_UNIFORM,
  FX_TRANSFORM_FEEDBACK_DELTA_TIME_UNIFORM,
  FX_TRANSFORM_FEEDBACK_INHERITED_UNIFORM,
  FX_TRANSFORM_FEEDBACK_MODEL_MATRIX_UNIFORM,
  FX_TRANSFORM_FEEDBACK_OBJECT_ANGULAR_VELOCITY_UNIFORM,
  FX_TRANSFORM_FEEDBACK_OBJECT_VELOCITY_UNIFORM,
  FX_TRANSFORM_FEEDBACK_RAND_SEED_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SPAWN_ID_BASE_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_COUNT_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_START_UNIFORM,
} from "./behaviorTransformFeedbackLayout.js";
export {
  FX_AGE,
  FX_CORE_BUFFERS,
  FX_CORE_LIFECYCLE,
  FX_CORE_LIFECYCLE_STRIDE,
  FX_CORE_LIFECYCLE_VARYING,
  FX_CORE_PARTICLE_DEFINES,
  FX_CORE_POSITION,
  FX_CORE_POSITION_STRIDE,
  FX_CORE_POSITION_VARYING,
  FX_ID,
  FX_LIFETIME,
  FX_POSITION_X,
  FX_POSITION_Y,
  FX_POSITION_Z,
} from "./coreLayout.js";
export type { FXDrawInputs } from "./render/FXDrawInputs.js";
export type {
  FXGraphLambertMaterialOptions,
  FXGraphUnlitMaterialOptions,
  FXRenderMode,
} from "./render/FXMaterialOptions.js";

// Whole-project playback: the generic runtime behind every editor-emitted project module (base
// class + scene specification). An emitted module supplies only its `FXEffectSpec` data and a thin subclass.
export { FXEffect } from "./effect/FXEffect.js";
export type {
  FXEffectEvent,
  FXEffectEventMap,
  FXEffectOptions,
  FXEffectPlayOptions,
  FXEffectReaction,
  FXEffectSpec,
  FXEffectTrailSpec,
  FXKeyEase,
} from "./effect/FXEffectSpec.js";
export type { FXSpawnAction } from "./effect/FXSpawnAction.js";
export type { FXInheritCopies } from "./emitter/FXInheritance.js";

// Type-only: the return type of `FXEffect.getEmitter`. Exported so an emitted module can name it in
// a typed `getEmitter` override; the emitter cannot be constructed from the main surface (its
// factory lives in the `sparcoon/editor` entry).
export type {
  FXEmissionBasis,
  FXEmitterBurstOptions,
  FXEmitterPlayOptions,
  FXParticleEvent,
  FXParticleEventKind,
  FXParticleEventListener,
  FXSpawnOrigin,
} from "./emitter/FXEmitter.Internal.js";
export type { FXEmitter } from "./emitter/FXEmitter.js";

// The tick domain: an effect joins one on construction; a single FXWorld.update per frame drives
// every effect's timeline and the shared particle pool.
export { fxFract, fxMix, fxMod, fxSampleLut, fxSmoothstep } from "./miscellaneous/fxMath.js";
export { fxCurl2, fxCurl3 } from "./miscellaneous/noise/fxCurlNoise.js";
export {
  fxFbm,
  fxFbm3,
  fxFractal1,
  fxFractal2,
  fxFractal3,
} from "./miscellaneous/noise/fxFractalNoise.js";
export {
  fxSeedHash1,
  fxSeedHash2,
  fxSeedHash3,
  fxSeedHash4,
} from "./miscellaneous/noise/fxSeedHash.js";
export { fxNoise1, fxNoise2, fxNoise3 } from "./miscellaneous/noise/fxValueNoise.js";
export { fxVoronoi2, fxVoronoi3 } from "./miscellaneous/noise/fxVoronoiNoise.js";
export type { FXDataTextureOptions } from "./miscellaneous/texture/fxDataTexture.js";
export { fxDataTexture } from "./miscellaneous/texture/fxDataTexture.js";
export { FXWorld } from "./world/FXWorld.js";

// External textures: a slot binds a whole Texture or a region (a window) of one; fxAtlasRegion builds
// the region of a packed atlas sprite from its frame values (parsing the atlas file is the app's job).
export type {
  FXAtlasRect,
  FXAtlasSize,
  FXAtlasSprite,
} from "./miscellaneous/texture/fxAtlasRegion.js";
export { fxAtlasRegion } from "./miscellaneous/texture/fxAtlasRegion.js";
export type {
  FXExternalTexture,
  FXTextureRegion,
  FXUniformValue,
} from "./render/FXExternalTexture.js";

// Scene depth is the camera's, not the world's or the effect's: give each camera the depth of what
// it sees, and every graph with Depth Fade it draws fades against it (hard without one).
export { fxSetCameraDepth } from "./render/FXCameraDepth.js";

// This runtime's version - the one an exported effect module is checked against.
export { FX_RUNTIME_VERSION } from "./version.js";

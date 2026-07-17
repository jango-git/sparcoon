// Public surface of the thin runtime: an editor-emitted module subclasses FXEffect, joins an
// FXWorld, and is driven by a single FXWorld.update per frame - plus the runtime-owned types the
// editor imports (artifact contracts and the core layout). No graph, compiler, validator, or live
// protocol lives here.

export type {
  FXAttributeDecl,
  FXBehaviorArtifact,
  FXBufferLayout,
  FXGeometrySource,
  FXKernelBuffers,
  FXRenderArtifact,
  FXShaderStageSource,
  FXUniformInit,
  FXValueSlot,
} from "./artifact/FXArtifact.js";

export {
  FX_AGE,
  FX_CORE_LIFECYCLE,
  FX_CORE_LIFECYCLE_STRIDE,
  FX_CORE_LIFECYCLE_VARYING,
  FX_CORE_PARTICLE_DEFINES,
  FX_CORE_POSITION,
  FX_CORE_POSITION_STRIDE,
  FX_CORE_POSITION_VARYING,
  FX_LIFETIME,
  FX_POSITION_X,
  FX_POSITION_Y,
  FX_POSITION_Z,
} from "./coreLayout.js";

export type {
  FXGraphLambertMaterialOptions,
  FXGraphUnlitMaterialOptions,
  FXRenderMode,
} from "./render/FXMaterialOptions.js";
export type { FXGeometryPrimitive } from "./artifact/FXArtifact.js";

// Whole-project playback: the generic runtime behind every editor-emitted project module (base
// class + scene specification). An emitted module supplies only its `FXEffectSpec` data and a thin subclass.
export { FXEffect } from "./effect/FXEffect.js";
export type { FXEffectOptions, FXEffectSpec } from "./effect/FXEffectSpec.js";

// Type-only: the return type of `FXEffect.getEmitter`. Exported so an emitted module can name it in
// a typed `getEmitter` override; the emitter cannot be constructed from the main surface (its
// factory lives in the `sparcoon/editor` entry).
export type { FXEmitter } from "./emitter/FXEmitter.js";

// The tick domain: an effect joins one on construction; a single FXWorld.update per frame drives
// every effect's timeline and the shared particle pool.
export { FXWorld } from "./world/FXWorld.js";

export {
  fxFbm,
  fxFract,
  fxHash,
  fxMix,
  fxMod,
  fxSampleLut,
  fxSmoothstep,
  fxSnoise2,
  fxSnoise3,
  fxValueNoise,
} from "./miscellaneous/fxMath.js";
export { fxDataTexture } from "./miscellaneous/texture/fxDataTexture.js";
export type { FXDataTextureOptions } from "./miscellaneous/texture/fxDataTexture.js";

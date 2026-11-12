// Editor-tooling surface: `import ... from "sparcoon/editor"`.
//
// UNSTABLE - no semver guarantees. These are the low-level building blocks the Sparcoon Editor's
// live preview needs (rebuild a single emitter/mesh from freshly compiled artifacts on every graph
// edit), plus the keyframe-sampling math the editor and runtime must share so a baked preview and
// runtime playback never drift. Regular game/scene hosts use the main "sparcoon" entry
// (FXEffect + FXWorld); they should not reach for anything here.

export type { FXApplyRenderArtifactOptions } from "../emitter/FXApplyRenderArtifactOptions.js";
export type {
  FXApplyValues,
  FXEmissionBasis,
  FXEmitterBurstOptions,
  FXEmitterOptions,
  FXEmitterPlayOptions,
  FXParticleDeath,
  FXParticleDeathListener,
  FXSpawnOrigin,
} from "../emitter/FXEmitter.Internal.js";
export { FXEmitter } from "../emitter/FXEmitter.js";
export type { FXFromArtifactsOptions } from "../emitter/FXFromArtifactsOptions.js";

// What makes an emitter spawn - the timeline's events and the death reactions - fired the same way
// by the runtime's FXEffect and the editor's preview.
export type { FXDeathSource, FXSpawnAction, FXSpawnTarget } from "../effect/FXSpawnAction.js";
export { connectDeathReaction, fireSpawnAction } from "../effect/FXSpawnAction.js";

// Self-contained VFX mesh (the mesh twin of FXEmitter): build one from a render artifact and let
// FXWorld.update drive it, including the object velocity/angular velocity a mesh render graph reads.
export type { FXFromMeshArtifactOptions } from "../render/FXMesh.js";
export { FXMesh } from "../render/FXMesh.js";

// Lower-level pieces FXMesh is built from - kept for tooling that assembles a mesh by hand.
export { resolveGeometrySource } from "../instancedParticle/primitiveGeometry.js";
export { FX_DRAW_INPUTS, type FXDrawInput } from "../render/FXDrawInputs.js";
export { FXMeshMaterial } from "../render/FXMeshMaterial.js";

// What a play's rate counts per, for the editor's inspector, loader and agent to offer and read.
export { asEmissionBasis, FX_EMISSION_BASES } from "../emitter/FXEmitter.Internal.js";

// Shared keyframe/transform sampling: the editor bakes keyframes and the runtime samples them, so
// both sides must sample identically - a frozen contract, never a one-sided edit.
export {
  asKeyEase,
  frameOfTime,
  FX_KEY_EASES,
  keyframeSegment,
  normalizeQuaternion,
  quaternionFromValue,
  sampleTrack,
  sampleTracks,
  sampleTransform,
  slerpQuaternion,
  timeOfFrame,
  vectorFromValue,
} from "../effect/FXEffectSampling.Internal.js";

// What a render artifact's materials take of a GPU's attributes, varyings, uniforms and texture
// units, against the least each tier guarantees - so the editor can refuse an effect some GPUs could not draw.
export type { FXGLSLRenderTier } from "../artifact/FXArtifact.js";
export type {
  FXEmitterRenderBudgetOptions,
  FXRenderBudget,
  FXTrailRenderBudgetOptions,
} from "../render/FXRenderBudget.js";
export {
  FX_RENDER_BUDGET_MINIMUMS,
  fxEmitterRenderBudget,
  fxGraphUniformAllowance,
  fxGraphVaryingAllowance,
  fxMeshRenderBudget,
  type FXPackedShape,
  fxPackedShape,
  fxTrailRenderBudget,
  packedVectors,
} from "../render/FXRenderBudget.js";

// Attribute packing: the order the editor lays a particle slot out in (packingOrder), how a slot
// lies in memory (slotLayout - the offsets a JS kernel bakes in), and how the runtime groups any
// layout into vertex attributes (packConsecutive) - one implementation both sides use, so a
// kernel's slot and the views bound over it agree by construction.
export type { FXSlotField, FXSlotLayout } from "../instancedParticle/FXParticleSlot.js";
export { slotLayout } from "../instancedParticle/FXParticleSlot.js";
export type {
  FXPackConsecutiveOptions,
  FXPackedAttribute,
  FXPackedMember,
  FXPackingField,
  FXPlacedField,
} from "../render/FXAttributePacking.js";
export {
  floatGLSLType,
  FX_ATTRIBUTE_MAX_COMPONENTS,
  packConsecutive,
  packingOrder,
} from "../render/FXAttributePacking.js";

// Particle trails: the options an emitter's trail is built from, and the most history frames one
// may keep.
export type { FXTrailOptions } from "../trail/FXTrail.js";
export { FX_TRAIL_MAX_FRAMES } from "../trail/FXTrail.js";

// External texture sampling: the function a graph calls to sample an external texture uniform -
// the runtime defines it per slot from how the host bound it (a whole texture or a region).
export { fxExternalSampleFunction } from "../render/FXExternalTexture.Internal.js";

// The lighting intrinsics a lighting node calls; the runtime defines those an artifact lists.
export type { FXLightingIntrinsicName } from "../render/FXLightingIntrinsics.Internal.js";
export { FX_LIGHTING_INTRINSIC } from "../render/FXLightingIntrinsics.Internal.js";

// The runtime version the editor stamps into every exported module (`FXEffectSpec.runtime`).
export { FX_RUNTIME_VERSION } from "../version.js";

// Editor-tooling surface: `import ... from "sparcoon/editor"`.
//
// UNSTABLE - no semver guarantees. These are the low-level building blocks the Sparcoon Editor's
// live preview needs (rebuild a single emitter/mesh from freshly compiled artifacts on every graph
// edit), plus the keyframe-sampling math the editor and runtime must share so a baked preview and
// runtime playback never drift. Regular game/scene hosts use the main "sparcoon" entry
// (FXEffect + FXWorld); they should not reach for anything here.

export { FXEmitter } from "../emitter/FXEmitter.js";
export type { FXFromArtifactsOptions } from "../emitter/FXFromArtifactsOptions.js";
export type { FXApplyRenderArtifactOptions } from "../emitter/FXApplyRenderArtifactOptions.js";
export type {
  FXApplyValues,
  FXEmitterOptions,
  FXEmitterBurstOptions,
  FXEmitterPlayOptions,
  FXParticleDeath,
  FXParticleDeathListener,
  FXSpawnOrigin,
} from "../emitter/FXEmitter.Internal.js";

// What makes an emitter spawn - the timeline's events and the death reactions - fired the same way
// by the runtime's FXEffect and the editor's preview.
export { connectDeathReaction, fireSpawnAction } from "../effect/FXSpawnAction.js";
export type { FXDeathSource, FXSpawnAction, FXSpawnTarget } from "../effect/FXSpawnAction.js";

// Self-contained VFX mesh (the mesh twin of FXEmitter): build one from a render artifact and let
// FXWorld.update drive it, including the object velocity/angular velocity a mesh render graph reads.
export { FXMesh } from "../render/FXMesh.js";
export type { FXFromMeshArtifactOptions } from "../render/FXMesh.js";

// Lower-level pieces FXMesh is built from - kept for tooling that assembles a mesh by hand.
export { FXMeshMaterial } from "../render/FXMeshMaterial.js";
export { resolveGeometrySource } from "../instancedParticle/primitiveGeometry.js";

// Shared keyframe/transform sampling: the editor bakes keyframes and the runtime samples them, so
// both sides must sample identically - a frozen contract, never a one-sided edit.
export {
  asKeyEase,
  FX_KEY_EASES,
  frameOfTime,
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

// What a render artifact's materials take of a GPU's vertex attributes and varyings, against the
// least each tier guarantees - so the editor can refuse an effect some GPUs could not draw.
export {
  FX_RENDER_BUDGET_MINIMUMS,
  fxEmitterRenderBudget,
  fxGraphVaryingAllowance,
  fxMeshRenderBudget,
  fxTrailRenderBudget,
  fxVaryingShape,
  packedVaryingVectors,
} from "../render/FXRenderBudget.js";
export type { FXGLSLRenderTier } from "../artifact/FXArtifact.js";
export type {
  FXEmitterRenderBudgetOptions,
  FXRenderBudget,
  FXTrailRenderBudgetOptions,
} from "../render/FXRenderBudget.js";

// Attribute packing: the order the editor lays a GPU kernel's buffers out in (packingOrder), and
// how the runtime groups any layout into vertex attributes (packConsecutive) - one implementation
// both sides use, so a kernel slot and the views bound over it agree by construction.
export {
  FX_ATTRIBUTE_MAX_COMPONENTS,
  floatGLSLType,
  packConsecutive,
  packingOrder,
  unpackedAttributes,
} from "../render/FXAttributePacking.js";
export type {
  FXPackConsecutiveOptions,
  FXPackedAttribute,
  FXPackedMember,
  FXPackingField,
  FXPlacedField,
} from "../render/FXAttributePacking.js";

// Particle trails: the options an emitter's trail is built from, and the most history frames one
// may keep.
export { FX_TRAIL_MAX_FRAMES } from "../trail/FXTrail.js";
export type { FXTrailOptions } from "../trail/FXTrail.js";

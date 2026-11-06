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
} from "../emitter/FXEmitter.Internal.js";

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
  fxMeshRenderBudget,
} from "../render/FXRenderBudget.js";
export type { FXRenderBudget } from "../render/FXRenderBudget.js";

/**
 * Uniform names that every fused spawn+update program declares, whether or not the graph reads
 * them. Shared by the editor's assembler and the transform-feedback driver. Dependency-free, the
 * editor imports it.
 *
 * Attributes and varyings are not listed: attribute locations follow the artifact's `buffers` order
 * and varying names travel with the artifact
 * (`FXParticleKernelArtifact.transformFeedbackVaryings`).
 */

export const FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_START_UNIFORM = "u_fxSpawnRangeStart";
export const FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_COUNT_UNIFORM = "u_fxSpawnRangeCount";
export const FX_TRANSFORM_FEEDBACK_SPAWN_ID_BASE_UNIFORM = "u_fxSpawnIdBase";
export const FX_TRANSFORM_FEEDBACK_CAPACITY_UNIFORM = "u_fxCapacity";
export const FX_TRANSFORM_FEEDBACK_RAND_SEED_UNIFORM = "u_fxRandSeed";
export const FX_TRANSFORM_FEEDBACK_DELTA_TIME_UNIFORM = "u_fxDt";
export const FX_TRANSFORM_FEEDBACK_MODEL_MATRIX_UNIFORM = "u_fxModelMatrix";
export const FX_TRANSFORM_FEEDBACK_OBJECT_VELOCITY_UNIFORM = "u_fxObjectVelocity";
export const FX_TRANSFORM_FEEDBACK_OBJECT_ANGULAR_VELOCITY_UNIFORM = "u_fxObjectAngularVelocity";
// The tail of a pass's spawn range born earlier in its tick: how many of its births (an int), and
// their ages as `vec2(first, step)` - birth `k` of the tail is `first + k * step` seconds old.
export const FX_TRANSFORM_FEEDBACK_BIRTH_AGE_COUNT_UNIFORM = "u_fxBirthAgeCount";
export const FX_TRANSFORM_FEEDBACK_BIRTH_AGES_UNIFORM = "u_fxBirthAges";
// What the pass's births take from the particle whose birth or death spawned them
// (`FXInheritLayout`), as `vec4[max(1, ceil(stride / 4))]`: float `k` of the layout is component
// `k % 4` of element `k / 4`.
export const FX_TRANSFORM_FEEDBACK_INHERITED_UNIFORM = "u_fxInherited";
// The scene depth a Depth Sample reads (see `fxSetCameraDepth`): the camera's depth texture, the
// view-projection it was drawn with and its inverse (mat4), and `vec3(1 / width, 1 / height, 1)`
// for the texture's texels - its last component 0 while there is no depth to read.
export const FX_TRANSFORM_FEEDBACK_SCENE_DEPTH_UNIFORM = "u_fxSceneDepth";
export const FX_TRANSFORM_FEEDBACK_VIEW_PROJECTION_UNIFORM = "u_fxViewProjection";
export const FX_TRANSFORM_FEEDBACK_INVERSE_VIEW_PROJECTION_UNIFORM = "u_fxInverseViewProjection";
export const FX_TRANSFORM_FEEDBACK_SCENE_DEPTH_FRAME_UNIFORM = "u_fxSceneDepthFrame";

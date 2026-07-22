/**
 * Frozen transform-feedback (WebGL2, standard-tier behavior) uniform-name contract, shared by the
 * editor's standard-tier behavior assembler (`FXKernelBuildStandard.Internal.ts`) and the
 * runtime's transform-feedback driver. Every fused spawn+update program declares all of these
 * uniforms unconditionally, regardless of whether a given graph actually reads them - fixed,
 * literal names both sides import instead of independently deriving, the same reasoning as
 * `coreLayout.ts`'s `PARTICLE_AGE`-style macros. Dependency-free (the editor imports this too), so
 * keep it three-free and portable.
 *
 * Buffer-backed `in` attributes and `out` (transform-feedback) varyings are NOT listed here: a
 * compiled program binds attributes by explicit `layout(location = N)` index (N = the buffer's
 * position in the artifact's own `buffers` array), and transform-feedback varying names travel
 * with the artifact itself (`FXParticleKernelArtifact.transformFeedbackVaryings`) - neither needs
 * a shared naming scheme, only these truly fixed, graph-independent uniforms do.
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

/**
 * Frozen per-particle ABI shared by the runtime loop and every editor-emitted module.
 * Two GPU-mirrored core buffers only: `position` (vec3) and `lifecycle` (vec3 [age, lifetime, id]);
 * a particle is dead once `age >= lifetime`. Everything else (velocity, scale, ...) is an ordinary
 * node-declared `a_fx_<name>` attribute, not core.
 *
 * Split into two buffers because a Three instanced attribute is at most a vec4 - a 6-float core
 * cannot be one attribute, whereas vec3 + vec3 are two clean varyings. Dependency-free (the editor's
 * module emitter imports this too), so keep it three-free and portable.
 */

export const FX_CORE_POSITION = "position";
export const FX_CORE_LIFECYCLE = "lifecycle";

export const FX_CORE_POSITION_STRIDE = 3;
export const FX_CORE_LIFECYCLE_STRIDE = 3;

export const FX_POSITION_X = 0;
export const FX_POSITION_Y = 1;
export const FX_POSITION_Z = 2;

export const FX_AGE = 0;
export const FX_LIFETIME = 1;
export const FX_ID = 2;

export const FX_CORE_POSITION_VARYING = "p_position";
export const FX_CORE_LIFECYCLE_VARYING = "p_lifecycle";

// A kernel-compiled buffer name (e.g. "velocity", as authored/compiled - always unprefixed) to its
// mesh property-buffer key: unchanged for the two core buffers, `fx_<name>` for every attribute.
// The one place this mapping is defined - every mesh/simulation-holder pairing (JS or GPU) must
// go through this, not re-derive the prefix locally, or the two sides can silently drift apart.
export const ATTRIBUTE_BUFFER_PREFIX = "fx_";

export function isCoreBufferName(bufferName: string): boolean {
  return bufferName === FX_CORE_POSITION || bufferName === FX_CORE_LIFECYCLE;
}

export function meshPropertyKeyFor(bufferName: string): string {
  return isCoreBufferName(bufferName) ? bufferName : `${ATTRIBUTE_BUFFER_PREFIX}${bufferName}`;
}

// Stable macro names so emitted render GLSL reads PARTICLE_POSITION_X / PARTICLE_AGE etc. instead
// of hardcoding the varying names this module owns.
export const FX_CORE_PARTICLE_DEFINES = `
  #define PARTICLE_POSITION_X ${FX_CORE_POSITION_VARYING}.x
  #define PARTICLE_POSITION_Y ${FX_CORE_POSITION_VARYING}.y
  #define PARTICLE_POSITION_Z ${FX_CORE_POSITION_VARYING}.z
  #define PARTICLE_POSITION ${FX_CORE_POSITION_VARYING}

  #define PARTICLE_AGE ${FX_CORE_LIFECYCLE_VARYING}.x
  #define PARTICLE_LIFETIME ${FX_CORE_LIFECYCLE_VARYING}.y
  #define PARTICLE_ID ${FX_CORE_LIFECYCLE_VARYING}.z
`;

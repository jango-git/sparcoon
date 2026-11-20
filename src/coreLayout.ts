/**
 * Per-particle layout shared by the runtime and editor-emitted modules. Two core fields per slot:
 * `position` (vec3) and `lifecycle` (vec3: age, lifetime, id). A particle is dead once `age >=
 * lifetime`. Every other field is a node-declared `fx_<name>` field (see FXParticleSlot.ts).
 *
 * Two fields, not one, because a vertex attribute is at most a vec4: a 6-float core cannot be one
 * view, while vec3 + vec3 are two clean varyings. Dependency-free, the editor imports it.
 */

export const FX_CORE_POSITION = "position";
export const FX_CORE_LIFECYCLE = "lifecycle";

export const FX_CORE_POSITION_STRIDE = 3;
export const FX_CORE_LIFECYCLE_STRIDE = 3;

/** The two core buffers every particle slot holds, as a behavior or kernel declares its buffers. */
export const FX_CORE_BUFFERS: readonly { readonly name: string; readonly stride: number }[] = [
  { name: FX_CORE_POSITION, stride: FX_CORE_POSITION_STRIDE },
  { name: FX_CORE_LIFECYCLE, stride: FX_CORE_LIFECYCLE_STRIDE },
];

export const FX_POSITION_X = 0;
export const FX_POSITION_Y = 1;
export const FX_POSITION_Z = 2;

export const FX_AGE = 0;
export const FX_LIFETIME = 1;
export const FX_ID = 2;

/**
 * How many particle ids there are: an id is the emitter's birth count modulo this, so the next
 * birth's id is one more, wrapping from the last back to 0. The most a float32 counts exactly - past
 * it two consecutive ids would read as one.
 */
export const FX_PARTICLE_ID_RANGE = 16_777_216;

export const FX_CORE_POSITION_VARYING = "p_position";
export const FX_CORE_LIFECYCLE_VARYING = "p_lifecycle";

// Maps a compiled buffer name ("velocity") to its mesh property key: unchanged for the two core
// buffers, `fx_<name>` otherwise. Every mesh and simulation pairing goes through this.
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
  #define RANDOM_SEED PARTICLE_ID
`;

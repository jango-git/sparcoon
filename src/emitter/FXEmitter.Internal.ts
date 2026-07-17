import type { Camera, Texture } from "three";

/**
 * Argument to {@link FXEmitter.applyValues}: values to scrub into uniform/binding slots by name.
 * Both maps optional; an unknown name is a safe no-op. Only reaches parameters the compiled
 * GLSL/kernel already declared - a structural edit is a fresh {@link FXEmitter.fromArtifacts}.
 */
export interface FXApplyValues {
  /** Scalar/vector, or a `Texture` for a `sampler2D`. Mutates the shared artifact slot, or this emitter's own slot for an `external` texture. */
  readonly uniforms?: Readonly<Record<string, number | readonly number[] | Texture>>;
  /** A `number`, or a `Float32Array` curve LUT. */
  readonly bindings?: Readonly<Record<string, number | Float32Array>>;
}

export interface FXEmitterOptions {
  /** Initial buffer size in particles; grows automatically. default 32 */
  expectedCapacity: number;
  /** Growth increment when capacity is reached. default 32 */
  capacityStep: number;
  /** default false */
  receiveShadow: boolean;
  /** Casts a shape-aware shadow (a customDepthMaterial built from the render artifact). default false */
  castShadow: boolean;
  /** Camera for back-to-front depth sorting; omit to disable sorting. */
  sortCamera: Camera;
  /** Fraction of frames sorting runs on (`1` = every frame, `0.1` = ~every 10th). default 0.1 */
  sortFraction: number;
}

export interface FXEmitterBurstOptions {
  /** Delay in seconds before spawning. default 0 */
  delay: number;
}

export interface FXEmitterPlayOptions {
  /** Delay in seconds before emission starts. default 0 */
  delay: number;
  /** Total emission duration in seconds. default Infinity */
  duration: number;
}

export const EMITTER_DEFAULT_EXPECTED_CAPACITY = 32;
export const EMITTER_DEFAULT_CAPACITY_STEP = 32;
export const EMITTER_DEFAULT_RECEIVE_SHADOW = false;
export const EMITTER_DEFAULT_CAST_SHADOW = false;
export const EMITTER_DEFAULT_SORT_FRACTION = 1 / 10;
export const EMITTER_DEFAULT_PREWARM_MIN_STEP_DURATION = 1 / 60;

// A float32 `u_time` accumulated forever quantizes to multi-millisecond steps after hours; wrapping
// keeps it small. A large multiple of 2pi (~1 hour) keeps unit-frequency sin/cos continuous across
// the wrap - other frequencies see at most one negligible seam per hour.
export const EMITTER_TIME_WRAP_PERIOD = 573 * 2 * Math.PI;

// Runaway guard, not a quality knob. High enough that a normal `prewarm(duration)` at the default
// `1/60` step honors its step size instead of being silently coarsened.
export const EMITTER_DEFAULT_PREWARM_MAX_STEP_COUNT = 1000;

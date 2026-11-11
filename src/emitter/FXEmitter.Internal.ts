import type { Camera } from "three";
import type { FXUniformValue } from "../render/FXExternalTexture.js";

/**
 * Argument to {@link FXEmitter.applyValues}: values to scrub into uniform/binding slots by name.
 * Both maps optional; an unknown name is a safe no-op. Only reaches parameters the compiled
 * GLSL/kernel already declared - a structural edit is a fresh {@link FXEmitter.fromArtifacts}.
 */
export interface FXApplyValues {
  /**
   * Scalar/vector, or a `Texture` for a `sampler2D`. Mutates the shared artifact slot, or this
   * emitter's own slot for an `external` texture - which also takes a region when it was bound to
   * one (see {@link FXExternalTexture}).
   */
  readonly uniforms?: Readonly<Record<string, FXUniformValue>>;
  /** A `number`, or a `Float32Array` curve LUT. */
  readonly bindings?: Readonly<Record<string, number | Float32Array>>;
}

export interface FXEmitterOptions {
  /**
   * Particle capacity: a fixed ring on both backends, never grown - a birth overwrites the slot at
   * the cursor whether its particle is live or not. So it must cover the spawn rate times the
   * longest lifetime, bursts included; a nonzero `particleOverflowCount` means particles died
   * early because it did not. An integer >= 1, checked in every build. default 256
   */
  expectedCapacity: number;
  /** default false */
  receiveShadow: boolean;
  /** Casts a shape-aware shadow (a customDepthMaterial built from the render artifact). default false */
  castShadow: boolean;
  /** Camera for back-to-front depth sorting; omit to disable sorting. */
  sortCamera: Camera;
  /** Fraction of frames sorting runs on (`1` = every frame, `0.1` = ~every 10th). default 0.1 */
  sortFraction: number;
  /**
   * The longest lifetime any particle can be born with, in seconds. Given it, the emitter settles
   * by itself - no simulation, nothing drawn - once that long has passed since its last birth,
   * nothing is scheduled and its trail shows nothing older. Without it only `reset` settles it.
   */
  maxLifetime: number;
}

/**
 * Where a burst or play spawns when not from the emitter's own pose: as if the emitter stood at
 * `position`, keeping its own rotation and scale, and moved at `velocity` - what its spawn graph
 * then reads through `world-matrix` and `object-velocity`. A graph that reads neither spawns where
 * it would from the emitter's own pose. Values are copied at the call.
 */
export interface FXSpawnOrigin {
  /** `[x, y, z]`, in the same numbers as particle positions. */
  readonly position: readonly number[];
  /** `[x, y, z]` per second. default `[0, 0, 0]` */
  readonly velocity?: readonly number[];
}

export interface FXEmitterBurstOptions {
  /** Delay in seconds before spawning. default 0 */
  delay: number;
  /** Spawn from this point instead of the emitter's pose. */
  origin: FXSpawnOrigin;
}

/**
 * What a play's `rate` counts particles per: a second of its time (`"time"`), or a world unit of the
 * distance the emitter's world position travels (`"distance"`).
 */
export type FXEmissionBasis = "time" | "distance";

// Keyed by the type itself, so a basis added to FXEmissionBasis cannot be left out of the list.
const EMISSION_BASIS_SET: Readonly<Record<FXEmissionBasis, true>> = { time: true, distance: true };

/** Every basis a play's rate can count per, for tools that offer them. */
export const FX_EMISSION_BASES = Object.keys(EMISSION_BASIS_SET) as readonly FXEmissionBasis[];

/** `value` as an emission basis, or `undefined` when it names none (a tool's or a file's raw input). */
export function asEmissionBasis(value: unknown): FXEmissionBasis | undefined {
  return FX_EMISSION_BASES.find((basis) => basis === value);
}

export interface FXEmitterPlayOptions {
  /** Delay in seconds before emission starts. default 0 */
  delay: number;
  /** Total emission duration in seconds, whatever `over` is. default Infinity */
  duration: number;
  /**
   * What `rate` counts per (see {@link FXEmissionBasis}). Over distance, a play spawns nothing
   * while the emitter stands still, and takes no `origin`: an origin does not move. Distance is
   * measured in world units, so a parent's scale does not change the count. default "time"
   */
  over: FXEmissionBasis;
  /**
   * Emit from this point for the whole play instead of following the emitter's pose. Such a play
   * belongs to whoever started it, not to the emitter's timeline: {@link FXEmitter.loopTimeline}
   * leaves it running. Not with `over: "distance"`.
   */
  origin: FXSpawnOrigin;
}

/**
 * One particle that just died (of age, or killed), handed to {@link FXEmitter.onParticleDeath}
 * listeners. The same object is reused for every death: read it during the call, copy what you
 * keep.
 */
export interface FXParticleDeath {
  /** `[x, y, z]`: the particle's position after its last update. */
  readonly position: readonly number[];
  /** `[x, y, z]` per second: how far it moved over its last tick. */
  readonly velocity: readonly number[];
}

/** Receives the deaths of an emitter's particles; see {@link FXEmitter.onParticleDeath}. */
export type FXParticleDeathListener = (death: FXParticleDeath) => void;

export const EMITTER_DEFAULT_EXPECTED_CAPACITY = 256;
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

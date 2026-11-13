import type {
  FXEmissionBasis,
  FXEmitterBurstOptions,
  FXEmitterPlayOptions,
  FXParticleDeathListener,
  FXSpawnOrigin,
} from "../emitter/FXEmitter.Internal.js";
import {
  assertValidInheritCopies,
  type FXInheritCopies,
  inheritFrom,
} from "../emitter/FXInheritance.js";
import type { FXSlotLayout } from "../instancedParticle/FXParticleSlot.js";

/**
 * What makes an emitter spawn, whatever triggers it - a timeline event at a time, or a death
 * reaction to another emitter's particles: `count` particles at once, or `rate` particles per second
 * - or per world unit the emitter travels, `over: "distance"` (a timeline event only) - for
 * `duration` seconds (`0` = without end, a timeline event only).
 */
export type FXSpawnAction =
  | { readonly kind: "burst"; readonly count: number }
  | {
      readonly kind: "play";
      readonly rate: number;
      readonly duration: number;
      /** default "time" */
      readonly over?: FXEmissionBasis;
    };

/** What a {@link FXSpawnAction} is fired on - an emitter, or anything spawning through one. */
export interface FXSpawnTarget {
  /** What its births inherit when nothing is handed to them (`FXEmitter.inheritDefaults`). */
  readonly inheritDefaults: ArrayLike<number>;
  burst(count: number, options?: Partial<FXEmitterBurstOptions>): number;
  play(rate: number, options?: Partial<FXEmitterPlayOptions>): number;
}

/** What a death reaction listens to - an emitter, or anything forwarding one's deaths. */
export interface FXDeathSource {
  /** The slot its particles' deaths hand out (`FXEmitter.particleSlot`). */
  readonly particleSlot: FXSlotLayout;
  onParticleDeath(listener: FXParticleDeathListener): () => void;
}

/**
 * Fires `action` on `target`, from `origin` when given. A zero count or rate is a no-op rather than
 * the emitter's throw: authored data reaches this from a frame loop, which must not throw.
 */
export function fireSpawnAction(
  target: FXSpawnTarget,
  action: FXSpawnAction,
  origin?: FXSpawnOrigin,
): void {
  const at = origin === undefined ? {} : { origin };
  if (action.kind === "burst") {
    if (action.count > 0) {
      target.burst(action.count, at);
    }
  } else if (action.rate > 0) {
    target.play(action.rate, {
      ...at,
      ...(action.duration > 0 ? { duration: action.duration } : {}),
      ...(action.over === undefined ? {} : { over: action.over }),
    });
  }
}

/**
 * Throws when `action` cannot be fired by a death: a play without end would pile up, one per death,
 * and a play over distance would never spawn - it spawns from where the particle died, which does
 * not move.
 */
export function assertDeathReactionAction(action: FXSpawnAction, subject: string): void {
  if (action.kind !== "play") {
    return;
  }
  if (!(action.duration > 0)) {
    throw new Error(`${subject}: a play fired by a death needs a finite duration`);
  }
  if (action.over === "distance") {
    throw new Error(`${subject}: a play fired by a death cannot count over distance`);
  }
}

/**
 * Fires `action` on `target` at every death of `source`'s particles, from where the particle died
 * and moving as it moved, its births inheriting what `copies` take of it (see
 * {@link FXSpawnOrigin}). Both sides' layouts are read at the call: a source or target rebuilt
 * with another one is connected afresh.
 * @returns Disconnects the two.
 * @throws When `action` is a play without end: one per death would pile up without bound. When
 *   `copies` do not fit the two layouts (see {@link assertValidInheritCopies}).
 */
export function connectDeathReaction(
  source: FXDeathSource,
  target: FXSpawnTarget,
  action: FXSpawnAction,
  copies: FXInheritCopies = [],
): () => void {
  assertDeathReactionAction(action, "connectDeathReaction");
  const defaults = Float32Array.from(target.inheritDefaults);
  assertValidInheritCopies(
    copies,
    source.particleSlot.stride,
    defaults.length,
    "connectDeathReaction.copies",
  );
  // Copied by the target at the call, so one array serves every death.
  const inherited = new Float32Array(defaults.length);
  const origin: {
    position: readonly number[];
    velocity: readonly number[];
    inherited: Float32Array;
  } = { position: [], velocity: [], inherited };
  return source.onParticleDeath((death) => {
    origin.position = death.position;
    origin.velocity = death.velocity;
    inheritFrom(death.slot, copies, defaults, inherited);
    fireSpawnAction(target, action, origin);
  });
}

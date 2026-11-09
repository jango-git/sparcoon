import type {
  FXEmitterBurstOptions,
  FXEmitterPlayOptions,
  FXParticleDeathListener,
  FXSpawnOrigin,
} from "../emitter/FXEmitter.Internal.js";

/**
 * What makes an emitter spawn, whatever triggers it - a timeline event at a time, or a death
 * reaction to another emitter's particles: `count` particles at once, or `rate` particles per second
 * for `duration` seconds (`0` = without end, a timeline event only).
 */
export type FXSpawnAction =
  | { readonly kind: "burst"; readonly count: number }
  | { readonly kind: "play"; readonly rate: number; readonly duration: number };

/** What a {@link FXSpawnAction} is fired on - an emitter, or anything spawning through one. */
export interface FXSpawnTarget {
  burst(count: number, options?: Partial<FXEmitterBurstOptions>): number;
  play(rate: number, options?: Partial<FXEmitterPlayOptions>): number;
}

/** What a death reaction listens to - an emitter, or anything forwarding one's deaths. */
export interface FXDeathSource {
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
    target.play(action.rate, action.duration > 0 ? { ...at, duration: action.duration } : at);
  }
}

/** Throws when `action` cannot be fired by a death: a play without end would pile up, one per death. */
export function assertDeathReactionAction(action: FXSpawnAction, subject: string): void {
  if (action.kind === "play" && !(action.duration > 0)) {
    throw new Error(`${subject}: a play fired by a death needs a finite duration`);
  }
}

/**
 * Fires `action` on `target` at every death of `source`'s particles, from where the particle died
 * and moving as it moved (see {@link FXSpawnOrigin}).
 * @returns Disconnects the two.
 * @throws When `action` is a play without end: one per death would pile up without bound.
 */
export function connectDeathReaction(
  source: FXDeathSource,
  target: FXSpawnTarget,
  action: FXSpawnAction,
): () => void {
  assertDeathReactionAction(action, "connectDeathReaction");
  return source.onParticleDeath((death) => {
    fireSpawnAction(target, action, death);
  });
}

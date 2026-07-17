import type { FXEffect } from "../effect/FXEffect.js";
import type { FXEmitter } from "../emitter/FXEmitter.js";
import { EMITTER_TIME_WRAP_PERIOD } from "../emitter/FXEmitter.Internal.js";

/**
 * The tick domain that drives effects. A world owns a pool of emitters, a registry of effects, and
 * a single monotonic clock; one {@link FXWorld.update} call per frame advances every playing
 * effect's timeline and then ticks the shared particle pool exactly once.
 *
 * An {@link FXEffect} subscribes to a world on construction and unsubscribes on
 * {@link FXEffect.dispose} - the host never wires that up by hand. Pass a world through
 * `FXEffectOptions.world` to place an effect in a specific world; omit it and the effect joins the
 * lazily created default world, which the static {@link FXWorld.update} ticks.
 *
 * A world is only a tick/clock domain, NOT a scene graph: an effect is still a `THREE.Object3D` you
 * add to your own scene. Two worlds give two independent clocks (for an independent time scale or an
 * isolated group); within one world every effect shares the clock and one delta per frame, so
 * {@link FXEffect.stop} clears rather than freezes - freeze one effect independently by giving it
 * its own world.
 */
export class FXWorld {
  private static defaultInstance: FXWorld | undefined;

  private readonly emitters: FXEmitter[] = [];
  private readonly effects: FXEffect[] = [];
  private elapsedTime = 0;
  private disposed = false;

  /**
   * The lazily created default world - the one an effect joins when its options carry no `world`.
   * Nothing is allocated until the first effect or the first {@link FXWorld.update}.
   */
  public static getDefault(): FXWorld {
    if (FXWorld.defaultInstance === undefined || FXWorld.defaultInstance.disposed) {
      FXWorld.defaultInstance = new FXWorld();
    }
    return FXWorld.defaultInstance;
  }

  /** Advances the default world by `deltaTime`; call once per frame. See {@link update}. */
  public static update(deltaTime: number): void {
    FXWorld.getDefault().update(deltaTime);
  }

  /**
   * Advances this world by `deltaTime` seconds: every playing effect drives its own timeline and
   * meshes, then the shared particle pool ticks once. Call exactly once per frame, before rendering.
   * A disposed world is a no-op.
   */
  public update(deltaTime: number): void {
    if (this.disposed) {
      return;
    }
    for (const effect of this.effects) {
      effect.advanceFrame(deltaTime);
    }
    // Wrap the clock so a float32 `u_time` keeps sub-millisecond resolution in long sessions, then
    // tick the whole pool once with the shared clock.
    this.elapsedTime = (this.elapsedTime + deltaTime) % EMITTER_TIME_WRAP_PERIOD;
    for (const emitter of this.emitters) {
      emitter.onWorldTick(deltaTime, this.elapsedTime);
    }
  }

  /**
   * Disposes every effect registered in this world (each frees its emitters and mesh resources),
   * then drops any remaining emitters. Idempotent. After this the world's {@link update} is a
   * no-op; disposing the default world simply makes the next {@link getDefault} create a fresh one.
   */
  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    // dispose() unregisters each effect from this world, so iterate a snapshot.
    for (const effect of [...this.effects]) {
      effect.dispose();
    }
    for (const emitter of [...this.emitters]) {
      emitter.destroy();
    }
    this.effects.length = 0;
    this.emitters.length = 0;
    if (FXWorld.defaultInstance === this) {
      FXWorld.defaultInstance = undefined;
    }
  }

  /** @internal Called by {@link FXEffect}'s constructor. */
  public registerEffect(effect: FXEffect): void {
    this.effects.push(effect);
  }

  /** @internal Called by {@link FXEffect.dispose}. */
  public unregisterEffect(effect: FXEffect): void {
    const index = this.effects.indexOf(effect);
    if (index !== -1) {
      this.effects.splice(index, 1);
    }
  }

  /** @internal Called by {@link FXEmitter}'s constructor. */
  public registerEmitter(emitter: FXEmitter): void {
    this.emitters.push(emitter);
  }

  /** @internal Called by {@link FXEmitter.destroy}. */
  public unregisterEmitter(emitter: FXEmitter): void {
    const index = this.emitters.indexOf(emitter);
    if (index !== -1) {
      this.emitters.splice(index, 1);
    }
  }
}

import type { FXEffect } from "../effect/FXEffect.js";
import { EMITTER_TIME_WRAP_PERIOD } from "../emitter/FXEmitter.Internal.js";
import { flushStateResets } from "../render/FXDeferredStateReset.Internal.js";

/**
 * A world-registered renderable driven once per frame: an emitter or a VFX mesh. `onWorldTick` reads
 * the object's own `matrixWorld` and pushes the shared clock plus its world-space motion; `destroy`
 * frees its GPU resources and unregisters it.
 */
export interface FXWorldObject {
  onWorldTick(deltaTime: number, elapsedTime: number): void;
  /**
   * Runs once every object of the world has ticked: an emitter hands out the particle births and
   * deaths its tick found here, so whatever a listener spawns lands on the next tick whichever
   * order the objects tick in.
   */
  afterWorldTick?(): void;
  destroy(): void;
}

/**
 * The tick domain of effects and their emitters and meshes: one {@link FXWorld.update} per frame
 * advances every playing timeline, then ticks every registered object once with the shared clock.
 * Effects and objects join a world on construction and leave on disposal.
 *
 * A world is a clock domain, not a scene graph: add renderables to your own scene. Two worlds have
 * two clocks, so an effect that must freeze on its own needs its own world.
 */
export class FXWorld {
  private static defaultInstance: FXWorld | undefined;

  private readonly objects: FXWorldObject[] = [];
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
   * meshes, then every registered emitter and mesh ticks once, then the particle births and deaths
   * of that tick reach their listeners. Call exactly once per frame, before rendering. A disposed
   * world is a no-op.
   */
  public update(deltaTime: number): void {
    if (this.disposed) {
      return;
    }
    for (const effect of this.effects) {
      effect.advanceFrame(deltaTime);
    }
    // Wrap the clock so a float32 `u_time` keeps sub-millisecond resolution in long sessions, then
    // tick every registered object once with the shared clock.
    this.elapsedTime = (this.elapsedTime + deltaTime) % EMITTER_TIME_WRAP_PERIOD;
    try {
      for (const object of this.objects) {
        object.onWorldTick(deltaTime, this.elapsedTime);
      }
    } finally {
      // Before any listener below runs host code that may draw; also after a throw, or the next
      // frame would draw through three's stale state.
      flushStateResets();
    }
    // Iterated live: an event listener may dispose an object (or the whole world). One skipped
    // that way hands its events out next frame - nothing is lost.
    for (const object of this.objects) {
      object.afterWorldTick?.();
    }
  }

  /**
   * Disposes every effect in this world, then drops the remaining objects. Idempotent. After this
   * {@link update} is a no-op, and disposing the default world makes the next {@link getDefault}
   * create a new one.
   */
  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    // Each disposal unregisters from this world, so iterate snapshots.
    for (const effect of [...this.effects]) {
      effect.dispose();
    }
    for (const object of [...this.objects]) {
      object.destroy();
    }
    this.effects.length = 0;
    this.objects.length = 0;
    if (FXWorld.defaultInstance === this) {
      FXWorld.defaultInstance = undefined;
    }
  }

  /** @internal */
  public registerEffect(effect: FXEffect): void {
    this.effects.push(effect);
  }

  /** @internal */
  public unregisterEffect(effect: FXEffect): void {
    const index = this.effects.indexOf(effect);
    if (index !== -1) {
      this.effects.splice(index, 1);
    }
  }

  /** @internal */
  public registerObject(object: FXWorldObject): void {
    this.objects.push(object);
  }

  /** @internal */
  public unregisterObject(object: FXWorldObject): void {
    const index = this.objects.indexOf(object);
    if (index !== -1) {
      this.objects.splice(index, 1);
    }
  }
}

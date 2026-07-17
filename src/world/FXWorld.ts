import type { FXEffect } from "../effect/FXEffect.js";
import { EMITTER_TIME_WRAP_PERIOD } from "../emitter/FXEmitter.Internal.js";

/**
 * A world-registered renderable driven once per frame: an emitter or a VFX mesh. `onWorldTick` reads
 * the object's own `matrixWorld` and pushes the shared clock plus its world-space motion; `destroy`
 * frees its GPU resources and unregisters it.
 */
export interface FXWorldObject {
  onWorldTick(deltaTime: number, elapsedTime: number): void;
  destroy(): void;
}

/**
 * The tick domain that drives effects and their renderables. A world owns a registry of effects, a
 * pool of world objects (emitters and meshes), and a single monotonic clock; one
 * {@link FXWorld.update} call per frame advances every playing effect's timeline, then ticks every
 * registered emitter and mesh exactly once with the shared clock.
 *
 * An {@link FXEffect} (and each standalone emitter/mesh it or the editor builds) subscribes to a
 * world on construction and unsubscribes on disposal - the host never wires that up by hand. Pass a
 * world through `FXEffectOptions.world` to place an effect in a specific world; omit it and it joins
 * the lazily created default world, which the static {@link FXWorld.update} ticks.
 *
 * A world is only a tick/clock domain, NOT a scene graph: a renderable is still a `THREE.Object3D`
 * you add to your own scene. Two worlds give two independent clocks (for an independent time scale or
 * an isolated group); within one world every effect shares the clock and one delta per frame, so
 * {@link FXEffect.stop} clears rather than freezes - freeze one effect independently by giving it its
 * own world.
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
   * meshes, then every registered emitter and mesh ticks once. Call exactly once per frame, before
   * rendering. A disposed world is a no-op.
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
    for (const object of this.objects) {
      object.onWorldTick(deltaTime, this.elapsedTime);
    }
  }

  /**
   * Disposes every effect registered in this world (each frees its emitters and mesh resources),
   * then drops any remaining objects. Idempotent. After this the world's {@link update} is a no-op;
   * disposing the default world simply makes the next {@link getDefault} create a fresh one.
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

  /** @internal Called by an emitter's or mesh's constructor. */
  public registerObject(object: FXWorldObject): void {
    this.objects.push(object);
  }

  /** @internal Called on an emitter's or mesh's destroy. */
  public unregisterObject(object: FXWorldObject): void {
    const index = this.objects.indexOf(object);
    if (index !== -1) {
      this.objects.splice(index, 1);
    }
  }
}

import type { Camera, Group, Scene, Vector3, WebGLRenderer } from "three";
import type { FXEffect } from "sparcoon";

import type { Example } from "./catalog";
import type { Media } from "./media";

/** What an effect plays in. `effects` is the group the depth pass leaves out. */
export interface Stage {
  readonly renderer: WebGLRenderer;
  readonly camera: Camera;
  readonly scene: Scene;
  readonly effects: Group;
}

export interface Shown {
  readonly example: Example;
  readonly effect: FXEffect;
}

/** The one effect on show: loading it, swapping it in and moving it along its path. */
export class Showcase {
  private current: Shown | undefined;
  private playedSeconds = 0;
  /** Bumped on every {@link open}, so an effect still loading after a newer pick is dropped. */
  private request = 0;

  public constructor(
    private readonly media: Media,
    private readonly stage: Stage,
    private readonly onShow: () => void,
  ) {}

  public get shown(): Shown | undefined {
    return this.current;
  }

  /**
   * Loads the example's effect and compiles it hidden, so its first frame does not stall, then
   * swaps it in for the one before.
   */
  public async open(example: Example): Promise<void> {
    const request = ++this.request;
    const create = await example.load(this.media);
    if (request !== this.request) {
      return;
    }
    const { renderer, camera, scene, effects } = this.stage;
    const effect = create({ renderer, camera });
    if (example.path !== undefined) {
      effect.position.copy(example.path(0));
    }
    effect.visible = false;
    effects.add(effect);
    await effect.compile(renderer, camera, scene);
    if (request !== this.request) {
      effect.dispose();
      return;
    }

    this.current?.effect.dispose();
    this.current = { example, effect };
    this.playedSeconds = 0;
    effect.visible = true;
    effect.play();
    this.onShow();
  }

  /** Moves the effect along its path and returns how far it moved, or undefined if it has none. */
  public advance(deltaSeconds: number): Vector3 | undefined {
    const path = this.current?.example.path;
    if (this.current === undefined || path === undefined) {
      return undefined;
    }
    const { position } = this.current.effect;
    this.playedSeconds += deltaSeconds;
    const next = path(this.playedSeconds);
    const offset = next.clone().sub(position);
    position.copy(next);
    return offset;
  }
}

import { Vector2, type Texture } from "three";
import type { FXProperty } from "../instancedParticle/shared";
import source from "../shaders/FXRenderingAnimatedTexture.glsl";
import { FXRenderingModule } from "./FXRenderingModule";

export class FXRenderingAnimatedTexture extends FXRenderingModule {
  /** @internal */
  public readonly requiredUniforms: Record<string, FXProperty>;
  /** @internal */
  public readonly source = source;

  constructor(texture: Texture, horizontalCount: number, verticalCount: number) {
    super();
    this.requiredUniforms = { texture, count: new Vector2(horizontalCount, verticalCount) };
  }
}

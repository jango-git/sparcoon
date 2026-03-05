import type { FXProperty } from "../instancedParticle/shared";
import { FXTextureView } from "../miscellaneous/texture/FXTextureView";
import type { FXTextureConfig } from "../miscellaneous/texture/FXTextureView.Internal";
import source from "../shaders/FXRenderingTexture.glsl";
import { FXRenderingModule } from "./FXRenderingModule";

/**
 * Renders particles with a texture.
 *
 * Samples the texture using particle UV coordinates.
 */
export class FXRenderingTexture extends FXRenderingModule {
  /** @internal */
  public readonly requiredUniforms: Record<string, FXProperty>;
  /** @internal */
  public readonly source = source;
  private readonly texture: FXTextureView;

  /**
   * @param config - Texture configuration
   */
  constructor(config: FXTextureConfig) {
    super();
    this.texture = new FXTextureView(config);
    this.requiredUniforms = {
      texture: this.texture.texture,
      textureTransform: this.texture.calculateUVTransform(),
    };
  }
}

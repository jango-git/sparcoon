import type { Matrix3 } from "three";
import { FXTextureView } from "../../miscellaneous/texture/FXTextureView";
import type { FXTextureConfig } from "../../miscellaneous/texture/FXTextureView.Internal";
import { checkSRGBSupport } from "../../miscellaneous/webglCapabilities";
import { CURRENT_EXPRESSION_VALUE_PLACEHOLDER } from "../FXNode";
import { FXNodeTexture } from "./FXNodeTexture";

/**
 * Texture node that applies a single static texture to every particle
 */
export class FXNodeStaticTexture extends FXNodeTexture {
  /** @internal */
  public override readonly affectsDepth: boolean = true;
  /** @internal */
  public override readonly cacheKey: string = "static-texture";
  /** @internal */
  public override uniformDeclarations!: string[];
  /** @internal */
  public override uniforms!: Record<string, { value: unknown }>;
  /** @internal */
  public override helperFunctions!: string;
  /** @internal */
  public override colorExpression!: string;

  private uniformTexture!: string;
  private uniformUVTransform!: string;
  private readonly textureInternal: FXTextureView;

  private isPrepared = false;

  /**
   * @param config - Texture or atlas configuration applied to every particle
   */
  constructor(config: FXTextureConfig) {
    super();
    this.textureInternal = new FXTextureView(config);
  }

  /** View describing the texture and its atlas region */
  public get texture(): FXTextureView {
    return this.textureInternal;
  }

  public set texture(config: FXTextureConfig) {
    this.textureInternal.set(config);

    if (this.isPrepared) {
      if (this.textureInternal.textureDirty) {
        this.uniforms[this.uniformTexture].value = this.textureInternal.texture;
        this.textureInternal.setTextureDirtyFalse();
      }
      if (this.textureInternal.uvTransformDirty) {
        this.textureInternal.calculateUVTransform(
          this.uniforms[this.uniformUVTransform].value as Matrix3,
        );
        this.textureInternal.setUVTransformDirtyFalse();
      }
    }
  }

  public override prepare(index: number): void {
    this.uniformTexture = `u_StaticTexture_${index}`;
    this.uniformUVTransform = `u_StaticTextureUVTransform_${index}`;

    const uvTransform = this.textureInternal.calculateUVTransform();
    this.textureInternal.setTextureDirtyFalse();
    this.textureInternal.setUVTransformDirtyFalse();

    this.uniformDeclarations = [
      `uniform sampler2D ${this.uniformTexture};`,
      `uniform mat3 ${this.uniformUVTransform};`,
    ];
    this.uniforms = {
      [this.uniformTexture]: { value: this.textureInternal.texture },
      [this.uniformUVTransform]: { value: uvTransform },
    };
    this.helperFunctions = `
      vec4 fxSampleStaticTexture(sampler2D colorTexture, mat3 uvTransform, vec2 uv) {
        vec2 transformedUV = (uvTransform * vec3(uv, 1.0)).xy;
        vec4 color = texture2D(colorTexture, transformedUV);
        // Apply gamma correction when sRGB textures are not natively supported
        ${checkSRGBSupport() ? "" : "color = vec4(pow(color.rgb, vec3(2.2)), color.a);"}
        return color;
      }
    `;
    this.colorExpression = `${CURRENT_EXPRESSION_VALUE_PLACEHOLDER} * fxSampleStaticTexture(${this.uniformTexture}, ${this.uniformUVTransform}, p_uv)`;
    this.isPrepared = true;
  }
}

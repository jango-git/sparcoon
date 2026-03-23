import type { Matrix3 } from "three";
import { getNextInstanceId } from "../../miscellaneous/miscellaneous";
import { FXTextureView } from "../../miscellaneous/texture/FXTextureView";
import type { FXTextureConfig } from "../../miscellaneous/texture/FXTextureView.Internal";
import { checkSRGBSupport } from "../../miscellaneous/webglCapabilities";
import { FXNodeTexture } from "./FXNodeTexture";

/**
 * Texture node that applies a single static texture to every particle
 */
export class FXNodeStaticTexture extends FXNodeTexture {
  /** @internal */
  public override readonly affectsDepth: boolean;
  /** @internal */
  public override readonly cacheKey: string;
  /** @internal */
  public override readonly uniformDeclarations: string[];
  /** @internal */
  public override readonly uniforms: Record<string, { value: unknown }>;
  /** @internal */
  public override readonly helperFunctions: string;
  /** @internal */
  public override readonly colorExpression: string;

  private readonly uniformTexture: string;
  private readonly uniformUVTransform: string;
  private readonly textureViewInternal: FXTextureView;

  /**
   * @param config - Texture or atlas configuration applied to every particle
   */
  constructor(config: FXTextureConfig) {
    super();
    const id = getNextInstanceId();
    this.uniformTexture = `u_StaticTexture_${id}`;
    this.uniformUVTransform = `u_StaticTextureUVTransform_${id}`;

    this.textureViewInternal = new FXTextureView(config);
    const uvTransform = this.textureViewInternal.calculateUVTransform();
    this.textureViewInternal.setTextureDirtyFalse();
    this.textureViewInternal.setUVTransformDirtyFalse();

    this.affectsDepth = true;
    this.cacheKey = "static-texture";
    this.uniformDeclarations = [
      `uniform sampler2D ${this.uniformTexture};`,
      `uniform mat3 ${this.uniformUVTransform};`,
    ];
    this.uniforms = {
      [this.uniformTexture]: { value: this.textureViewInternal.texture },
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
    this.colorExpression = `fxSampleStaticTexture(${this.uniformTexture}, ${this.uniformUVTransform}, p_uv)`;
  }

  /** View describing the texture and its atlas region */
  public get textureView(): FXTextureView {
    return this.textureViewInternal;
  }

  public set textureView(config: FXTextureConfig) {
    this.textureViewInternal.set(config);
    if (this.textureViewInternal.textureDirty) {
      this.uniforms[this.uniformTexture].value = this.textureViewInternal.texture;
      this.textureViewInternal.setTextureDirtyFalse();
    }
    if (this.textureViewInternal.uvTransformDirty) {
      this.textureViewInternal.calculateUVTransform(
        this.uniforms[this.uniformUVTransform].value as Matrix3,
      );
      this.textureViewInternal.setUVTransformDirtyFalse();
    }
  }
}

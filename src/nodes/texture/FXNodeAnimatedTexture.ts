import type { Matrix3 } from "three";
import { assertValidPositiveNumber } from "../../miscellaneous/asserts";
import { getNextInstanceId } from "../../miscellaneous/miscellaneous";
import { FXTextureView } from "../../miscellaneous/texture/FXTextureView";
import type { FXTextureConfig } from "../../miscellaneous/texture/FXTextureView.Internal";
import { checkSRGBSupport } from "../../miscellaneous/webglCapabilities";
import { CURRENT_EXPRESSION_VALUE_PLACEHOLDER } from "../FXNode";
import { FXNodeTexture } from "./FXNodeTexture";

/**
 * Options for {@link FXNodeAnimatedTexture}
 */
export interface FXNodeAnimatedTextureOptions {
  /** Texture or atlas configuration containing all animation frames */
  texture: FXTextureConfig;

  /** Number of frame columns in the sprite sheet */
  columns: number;

  /** Number of frame rows in the sprite sheet */
  rows: number;

  /**
   * If true, blends between adjacent frames for smoother animation
   *
   * @defaultValue `false`
   */
  interpolate?: boolean;
}

/**
 * Texture node that animates through sprite sheet frames over a particle's lifetime
 *
 * @remarks
 * Frames advance from the first to the last as the particle ages. The total frame count
 * is `columns * rows`. Both `columns` and `rows` must be positive integers.
 */
export class FXNodeAnimatedTexture extends FXNodeTexture {
  /** @internal */
  public override readonly affectsDepth: boolean = true;
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
  private readonly uniformColumns: string;
  private readonly uniformRows: string;
  private readonly textureInternal: FXTextureView;

  /**
   * @param options - Sprite sheet configuration
   */
  constructor({ texture, columns, rows, interpolate = false }: FXNodeAnimatedTextureOptions) {
    super();
    assertValidPositiveNumber(columns, "FXNodeAnimatedTexture.constructor.columns");
    assertValidPositiveNumber(rows, "FXNodeAnimatedTexture.constructor.rows");
    const idx = getNextInstanceId();
    this.uniformTexture = `u_AnimatedTexture_${idx}`;
    this.uniformUVTransform = `u_AnimatedTextureUVTransform_${idx}`;
    this.uniformColumns = `u_AnimatedTextureColumns_${idx}`;
    this.uniformRows = `u_AnimatedTextureRows_${idx}`;

    this.textureInternal = new FXTextureView(texture);
    const uvTransform = this.textureInternal.calculateUVTransform();
    this.textureInternal.setTextureDirtyFalse();
    this.textureInternal.setUVTransformDirtyFalse();

    const gammaCorrection = checkSRGBSupport()
      ? ""
      : "color = vec4(pow(color.rgb, vec3(2.2)), color.a);";

    this.cacheKey = interpolate ? "animated-texture-interpolated" : "animated-texture";
    this.uniformDeclarations = [
      `uniform sampler2D ${this.uniformTexture};`,
      `uniform mat3 ${this.uniformUVTransform};`,
      `uniform float ${this.uniformColumns};`,
      `uniform float ${this.uniformRows};`,
    ];
    this.uniforms = {
      [this.uniformTexture]: { value: this.textureInternal.texture },
      [this.uniformUVTransform]: { value: uvTransform },
      [this.uniformColumns]: { value: columns },
      [this.uniformRows]: { value: rows },
    };
    this.helperFunctions = interpolate
      ? `
        vec2 fxFrameToUV(vec2 uv, float frame, float columns, float rows) {
          float column = mod(frame, columns);
          float row = floor(frame / columns);
          return vec2((column + uv.x) / columns, 1.0 - (row + 1.0 - uv.y) / rows);
        }

        vec4 fxSampleAnimatedTexture(sampler2D spriteSheet, mat3 uvTransform, vec2 uv, float columns, float rows) {
          float totalFrames = columns * rows;

          // Fractional frame position drives both frame selection and blend weight
          float exactFrame = PARTICLE_AGE / PARTICLE_LIFETIME * totalFrames;
          float currentFrame = clamp(floor(exactFrame), 0.0, totalFrames - 1.0);
          float nextFrame    = clamp(currentFrame + 1.0, 0.0, totalFrames - 1.0);
          float blendWeight  = fract(exactFrame);

          vec2 currentUV = (uvTransform * vec3(fxFrameToUV(uv, currentFrame, columns, rows), 1.0)).xy;
          vec2 nextUV    = (uvTransform * vec3(fxFrameToUV(uv, nextFrame,    columns, rows), 1.0)).xy;

          vec4 color = mix(
            texture2D(spriteSheet, currentUV),
            texture2D(spriteSheet, nextUV),
            blendWeight
          );

          // Apply gamma correction when sRGB textures are not natively supported
          ${gammaCorrection}

          return color;
        }
      `
      : `
        vec4 fxSampleAnimatedTexture(sampler2D spriteSheet, mat3 uvTransform, vec2 uv, float columns, float rows) {
          // Determine which frame to display based on normalized particle age
          float totalFrames = columns * rows;
          float frame = floor(PARTICLE_AGE / PARTICLE_LIFETIME * totalFrames);
          frame = clamp(frame, 0.0, totalFrames - 1.0);

          // Locate the frame's column and row in the sprite sheet grid
          float column = mod(frame, columns);
          float row = floor(frame / columns);

          // Remap UV to the frame's tile region, then apply atlas transform
          vec2 frameUV = vec2((column + uv.x) / columns, 1.0 - (row + 1.0 - uv.y) / rows);
          vec2 atlasUV = (uvTransform * vec3(frameUV, 1.0)).xy;
          vec4 color = texture2D(spriteSheet, atlasUV);

          // Apply gamma correction when sRGB textures are not natively supported
          ${gammaCorrection}

          return color;
        }
      `;
    this.colorExpression = `${CURRENT_EXPRESSION_VALUE_PLACEHOLDER} * fxSampleAnimatedTexture(${this.uniformTexture}, ${this.uniformUVTransform}, p_uv, ${this.uniformColumns}, ${this.uniformRows})`;
  }

  /** View describing the texture and its atlas region */
  public get texture(): FXTextureView {
    return this.textureInternal;
  }

  /** Number of frame columns in the sprite sheet */
  public get columns(): number {
    return this.uniforms[this.uniformColumns].value as number;
  }

  /** Number of frame rows in the sprite sheet */
  public get rows(): number {
    return this.uniforms[this.uniformRows].value as number;
  }

  public set texture(config: FXTextureConfig) {
    this.textureInternal.set(config);
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

  public set columns(value: number) {
    assertValidPositiveNumber(value, "FXNodeAnimatedTexture.columns");
    this.uniforms[this.uniformColumns].value = value;
  }

  public set rows(value: number) {
    assertValidPositiveNumber(value, "FXNodeAnimatedTexture.rows");
    this.uniforms[this.uniformRows].value = value;
  }
}

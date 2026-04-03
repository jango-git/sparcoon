import type { Matrix3 } from "three";
import { assertValidPositiveNumber } from "../../miscellaneous/asserts";
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
  public override cacheKey!: string;
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
  private uniformColumns!: string;
  private uniformRows!: string;
  private readonly textureInternal: FXTextureView;

  private readonly isInterpolate: boolean;

  private columnsInternal: number;
  private rowsInternal: number;

  private isPrepared = false;

  /**
   * @param options - Sprite sheet configuration
   */
  constructor({ texture, columns, rows, interpolate = false }: FXNodeAnimatedTextureOptions) {
    super();
    assertValidPositiveNumber(columns, "FXNodeAnimatedTexture.constructor.columns");
    assertValidPositiveNumber(rows, "FXNodeAnimatedTexture.constructor.rows");

    this.columnsInternal = columns;
    this.rowsInternal = rows;

    this.textureInternal = new FXTextureView(texture);
    this.isInterpolate = interpolate;
  }

  /** View describing the texture and its atlas region */
  public get texture(): FXTextureView {
    return this.textureInternal;
  }

  /** Number of frame columns in the sprite sheet */
  public get columns(): number {
    return this.columnsInternal;
  }

  /** Number of frame rows in the sprite sheet */
  public get rows(): number {
    return this.rowsInternal;
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

  public set columns(value: number) {
    assertValidPositiveNumber(value, "FXNodeAnimatedTexture.columns");
    this.columnsInternal = value;
    if (this.isPrepared) {
      this.uniforms[this.uniformColumns].value = value;
    }
  }

  public set rows(value: number) {
    assertValidPositiveNumber(value, "FXNodeAnimatedTexture.rows");
    this.rowsInternal = value;
    if (this.isPrepared) {
      this.uniforms[this.uniformRows].value = value;
    }
  }

  public override prepare(index: number): void {
    this.uniformTexture = `u_AnimatedTexture_${index}`;
    this.uniformUVTransform = `u_AnimatedTextureUVTransform_${index}`;
    this.uniformColumns = `u_AnimatedTextureColumns_${index}`;
    this.uniformRows = `u_AnimatedTextureRows_${index}`;

    const uvTransform = this.textureInternal.calculateUVTransform();
    this.textureInternal.setTextureDirtyFalse();
    this.textureInternal.setUVTransformDirtyFalse();

    const gammaCorrection = checkSRGBSupport()
      ? ""
      : "color = vec4(pow(color.rgb, vec3(2.2)), color.a);";

    this.cacheKey = this.isInterpolate ? "animated-texture-interpolated" : "animated-texture";
    this.uniformDeclarations = [
      `uniform sampler2D ${this.uniformTexture};`,
      `uniform mat3 ${this.uniformUVTransform};`,
      `uniform float ${this.uniformColumns};`,
      `uniform float ${this.uniformRows};`,
    ];
    this.uniforms = {
      [this.uniformTexture]: { value: this.textureInternal.texture },
      [this.uniformUVTransform]: { value: uvTransform },
      [this.uniformColumns]: { value: this.columnsInternal },
      [this.uniformRows]: { value: this.rowsInternal },
    };
    this.helperFunctions = this.isInterpolate
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

    this.isPrepared = true;
  }
}

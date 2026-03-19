import type { Texture } from "three";
import { checkSRGBSupport } from "../../miscellaneous/webglCapabilities";
import { FXTextureNode } from "./FXTextureNode";

const INSTANCES: FXAnimatedTextureNode[] = [];

export interface FXAnimatedTextureNodeOptions {
  texture: Texture;
  columns: number;
  rows: number;
  interpolate?: boolean;
}

export class FXAnimatedTextureNode extends FXTextureNode {
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

  constructor({ texture, columns, rows, interpolate = false }: FXAnimatedTextureNodeOptions) {
    super();
    INSTANCES.push(this);
    const idx = INSTANCES.length - 1;
    const uniformTexture = `u_AnimatedTexture_${idx}`;
    const uniformColumns = `u_AnimatedTextureColumns_${idx}`;
    const uniformRows = `u_AnimatedTextureRows_${idx}`;

    const gammaCorrection = checkSRGBSupport()
      ? ""
      : "color = vec4(pow(color.rgb, vec3(2.2)), color.a);";

    this.affectsDepth = true;
    this.cacheKey = interpolate ? "animated-interpolated" : "animated";
    this.uniformDeclarations = [
      `uniform sampler2D ${uniformTexture};`,
      `uniform float ${uniformColumns};`,
      `uniform float ${uniformRows};`,
    ];
    this.uniforms = {
      [uniformTexture]: { value: texture },
      [uniformColumns]: { value: columns },
      [uniformRows]: { value: rows },
    };
    this.helperFunctions = interpolate
      ? `
        vec2 frameToUV(vec2 uv, float frame, float columns, float rows) {
          float column = mod(frame, columns);
          float row = floor(frame / columns);
          return vec2((column + uv.x) / columns, 1.0 - (row + 1.0 - uv.y) / rows);
        }

        vec4 sampleAnimatedTexture(sampler2D spriteSheet, vec2 uv, float columns, float rows) {
          float totalFrames = columns * rows;

          // Fractional frame position drives both frame selection and blend weight
          float exactFrame = PARTICLE_AGE / PARTICLE_LIFETIME * totalFrames;
          float currentFrame = clamp(floor(exactFrame), 0.0, totalFrames - 1.0);
          float nextFrame    = clamp(currentFrame + 1.0, 0.0, totalFrames - 1.0);
          float blendWeight  = fract(exactFrame);

          vec4 color = mix(
            texture2D(spriteSheet, frameToUV(uv, currentFrame, columns, rows)),
            texture2D(spriteSheet, frameToUV(uv, nextFrame,    columns, rows)),
            blendWeight
          );

          // Apply gamma correction when sRGB textures are not natively supported
          ${gammaCorrection}

          return color;
        }
      `
      : `
        vec4 sampleAnimatedTexture(sampler2D spriteSheet, vec2 uv, float columns, float rows) {
          // Determine which frame to display based on normalized particle age
          float totalFrames = columns * rows;
          float frame = floor(PARTICLE_AGE / PARTICLE_LIFETIME * totalFrames);
          frame = clamp(frame, 0.0, totalFrames - 1.0);

          // Locate the frame's column and row in the sprite sheet grid
          float column = mod(frame, columns);
          float row = floor(frame / columns);

          // Remap UV to the frame's tile region within the sprite sheet
          vec2 frameUV = vec2((column + uv.x) / columns, 1.0 - (row + 1.0 - uv.y) / rows);
          vec4 color = texture2D(spriteSheet, frameUV);

          // Apply gamma correction when sRGB textures are not natively supported
          ${gammaCorrection}

          return color;
        }
      `;
    this.colorExpression = `sampleAnimatedTexture(${uniformTexture}, p_uv, ${uniformColumns}, ${uniformRows})`;
  }

  public override destroy(): void {
    const index = INSTANCES.indexOf(this);
    if (index !== -1) {
      INSTANCES.splice(index, 1);
    }
  }
}

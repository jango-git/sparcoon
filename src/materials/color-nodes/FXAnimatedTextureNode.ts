import type { Texture } from "three";
import { FXColorNode } from "./FXColorNode";

export interface FXAnimatedTextureNodeOptions {
  texture: Texture;
  cols: number;
  rows: number;
}

export class FXAnimatedTextureNode extends FXColorNode {
  /** @internal */
  public override readonly cacheKey = "animated";
  /** @internal */
  public override readonly uniformDeclarations = [
    "uniform sampler2D u_AnimatedTexture;",
    "uniform float u_AnimatedTextureCols;",
    "uniform float u_AnimatedTextureRows;",
  ];
  /** @internal */
  public override readonly uniforms: Record<string, { value: unknown }>;
  /** @internal */
  public override readonly helperFunctions = `
    vec4 _fx_sampleAnimated(sampler2D tex, vec2 uv, float cols, float rows) {
      float totalFrames = cols * rows;
      float frame = floor(PARTICLE_AGE / PARTICLE_LIFETIME * totalFrames);
      frame = clamp(frame, 0.0, totalFrames - 1.0);
      float col = mod(frame, cols);
      float row = floor(frame / cols);
      vec2 frameUV = vec2((col + uv.x) / cols, 1.0 - (row + 1.0 - uv.y) / rows);
      return texture2D(tex, frameUV);
    }
  `;
  /** @internal */
  public override readonly colorExpression =
    "_fx_sampleAnimated(u_AnimatedTexture, p_uv, u_AnimatedTextureCols, u_AnimatedTextureRows)";
  /** @internal */
  public override readonly affectsDepth = true;

  constructor({ texture, cols, rows }: FXAnimatedTextureNodeOptions) {
    super();
    this.uniforms = {
      // eslint-disable-next-line @typescript-eslint/naming-convention
      u_AnimatedTexture: { value: texture },
      // eslint-disable-next-line @typescript-eslint/naming-convention
      u_AnimatedTextureCols: { value: cols },
      // eslint-disable-next-line @typescript-eslint/naming-convention
      u_AnimatedTextureRows: { value: rows },
    };
  }
}

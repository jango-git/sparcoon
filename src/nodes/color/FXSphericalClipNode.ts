import { FXColorNode } from "./FXColorNode";

export class FXSphericalClipNode extends FXColorNode {
  /** @internal */
  public override readonly cacheKey = "spherical-clip";
  /** @internal */
  public override readonly uniformDeclarations: string[] = [];
  /** @internal */
  public override readonly uniforms: Record<string, { value: unknown }> = {};
  /** @internal */
  public override readonly helperFunctions = `
    vec4 applySphericalClip() {
      float dist = distance(p_uv, vec2(0.5, 0.5));
      float alpha = 1.0 - step(0.5, dist);
      return vec4(1.0, 1.0, 1.0, alpha);
    }
  `;
  /** @internal */
  public override readonly colorExpression = "applySphericalClip()";
}

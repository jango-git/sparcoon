import { FXNodeNormal } from "./FXNodeNormal";

/**
 * Normal node that makes flat billboard particles appear as spheres under directional lighting
 */
export class FXNodeSphericalNormal extends FXNodeNormal {
  /** @internal */
  public override readonly cacheKey: string;
  /** @internal */
  public override readonly uniformDeclarations: string[];
  /** @internal */
  public override readonly uniforms: Record<string, { value: unknown }>;
  /** @internal */
  public override readonly helperFunctions: string;
  /** @internal */
  public override readonly normalExpression: string;

  constructor() {
    super();

    this.cacheKey = "spherical-normal";
    this.uniformDeclarations = [];
    this.uniforms = {};
    this.helperFunctions = `
      vec3 fxComputeSphericalNormal(vec2 uv) {
        vec2 centeredUV = uv * 2.0 - 1.0;
        return normalize(vec3(centeredUV, sqrt(max(0.0, 1.0 - dot(centeredUV, centeredUV)))));
      }
    `;
    this.normalExpression = "fxComputeSphericalNormal(p_uv)";
  }
}

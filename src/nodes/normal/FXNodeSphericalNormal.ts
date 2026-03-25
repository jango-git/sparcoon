import { CURRENT_EXPRESSION_VALUE_PLACEHOLDER } from "../FXNode";
import { FXNodeNormal } from "./FXNodeNormal";

/**
 * Normal node that makes flat billboard particles appear as spheres under directional lighting
 */
export class FXNodeSphericalNormal extends FXNodeNormal {
  /** @internal */
  public override readonly cacheKey: string = "spherical-normal";
  /** @internal */
  public override readonly helperFunctions: string = `
    vec3 fxComputeSphericalNormal(vec2 uv) {
      vec2 centeredUV = uv * 2.0 - 1.0;
      return normalize(vec3(centeredUV, sqrt(max(0.0, 1.0 - dot(centeredUV, centeredUV)))));
    }
  `;
  /** @internal */
  public override readonly normalExpression: string = `${CURRENT_EXPRESSION_VALUE_PLACEHOLDER} * fxComputeSphericalNormal(p_uv)`;
}

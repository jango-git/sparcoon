import { CURRENT_EXPRESSION_VALUE_PLACEHOLDER } from "../FXNode";
import { FXNodeNormal } from "./FXNodeNormal";

/**
 * Normal node that outputs a constant face-aligned normal pointing toward the camera
 */
export class FXNodeFlatNormal extends FXNodeNormal {
  /** @internal */
  public override readonly cacheKey: string = "flat-normal";
  /** @internal */
  public override readonly normalExpression: string = `${CURRENT_EXPRESSION_VALUE_PLACEHOLDER} * vec3(0.0, 0.0, 1.0)`;
}

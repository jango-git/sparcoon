import { getNextInstanceId } from "../../miscellaneous/miscellaneous";
import {
  BLENDING_EXPRESSION_CURRENT_COLOR_PLACEHOLDER,
  CURRENT_EXPRESSION_VALUE_PLACEHOLDER,
} from "../FXNode";
import { FXNodeBlending } from "./FXNodeBlending";

export class FXNodeLightnessBlendingMask extends FXNodeBlending {
  /** @internal */
  public override readonly cacheKey: string = "lightness-blending-mask";
  /** @internal */
  public override readonly uniformDeclarations: string[];
  /** @internal */
  public override readonly uniforms: Record<string, { value: unknown }>;
  /** @internal */
  public override readonly helperFunctions: string;
  /** @internal */
  public override readonly blendingExpression: string;

  private readonly uniformEdge0: string;
  private readonly uniformEdge1: string;

  /**
   * @param edge0 - brightness threshold where mask starts (below this: NormalBlending). Defaults to `0.3`
   * @param edge1 - brightness threshold where mask is fully active (above this: full FXBlending effect). Defaults to `0.7`
   */
  constructor(edge0 = 0.3, edge1 = 0.7) {
    super();
    const id = getNextInstanceId();
    this.uniformEdge0 = `u_LightnessBlendingMaskEdge0_${id}`;
    this.uniformEdge1 = `u_LightnessBlendingMaskEdge1_${id}`;

    this.uniformDeclarations = [
      `uniform float ${this.uniformEdge0};`,
      `uniform float ${this.uniformEdge1};`,
    ];
    this.uniforms = {
      [this.uniformEdge0]: { value: edge0 },
      [this.uniformEdge1]: { value: edge1 },
    };
    this.helperFunctions = `
      float fxLightnessBlendingMask(vec4 color, float edge0, float edge1) {
        float brightness = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
        return smoothstep(edge0, edge1, brightness);
      }
    `;
    this.blendingExpression = `${CURRENT_EXPRESSION_VALUE_PLACEHOLDER} * fxLightnessBlendingMask(${BLENDING_EXPRESSION_CURRENT_COLOR_PLACEHOLDER}, ${this.uniformEdge0}, ${this.uniformEdge1})`;
  }

  /** Brightness threshold where mask starts (below this: NormalBlending) */
  public get edge0(): number {
    return this.uniforms[this.uniformEdge0].value as number;
  }

  /** Brightness threshold where mask is fully active (above this: full FXBlending effect) */
  public get edge1(): number {
    return this.uniforms[this.uniformEdge1].value as number;
  }

  public set edge0(value: number) {
    this.uniforms[this.uniformEdge0].value = value;
  }

  public set edge1(value: number) {
    this.uniforms[this.uniformEdge1].value = value;
  }
}

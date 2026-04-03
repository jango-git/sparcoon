import { assertValidNonNegativeNumber } from "../../miscellaneous/asserts";
import {
  BLENDING_EXPRESSION_CURRENT_COLOR_PLACEHOLDER,
  CURRENT_EXPRESSION_VALUE_PLACEHOLDER,
} from "../FXNode";
import { FXNodeBlending } from "./FXNodeBlending";

export class FXNodeLightnessBlendingMask extends FXNodeBlending {
  /** @internal */
  public override readonly cacheKey: string = "lightness-blending-mask";
  /** @internal */
  public override uniformDeclarations!: string[];
  /** @internal */
  public override uniforms!: Record<string, { value: unknown }>;
  /** @internal */
  public override helperFunctions!: string;
  /** @internal */
  public override blendingExpression!: string;

  private uniformNameEdge0!: string;
  private uniformNameEdge1!: string;

  private edge0Internal: number;
  private edge1Internal: number;

  private isPrepared = false;

  /**
   * @param edge0 - brightness threshold where mask starts (below this: NormalBlending). Defaults to `0.3`
   * @param edge1 - brightness threshold where mask is fully active (above this: full FXBlending effect). Defaults to `0.7`
   */
  constructor(edge0 = 0.3, edge1 = 0.7) {
    super();
    assertValidNonNegativeNumber(edge0, "FXNodeLightnessBlendingMask.constructor.edge0");
    assertValidNonNegativeNumber(edge1, "FXNodeLightnessBlendingMask.constructor.edge1");

    this.edge0Internal = edge0;
    this.edge1Internal = edge1;
  }

  /** Brightness threshold where mask starts (below this: NormalBlending) */
  public get edge0(): number {
    return this.edge0Internal;
  }

  /** Brightness threshold where mask is fully active (above this: full FXBlending effect) */
  public get edge1(): number {
    return this.edge1Internal;
  }

  public set edge0(value: number) {
    assertValidNonNegativeNumber(value, "FXNodeLightnessBlendingMask.edge0");
    this.edge0Internal = value;
    if (this.isPrepared) {
      this.uniforms[this.uniformNameEdge0].value = value;
    }
  }

  public set edge1(value: number) {
    assertValidNonNegativeNumber(value, "FXNodeLightnessBlendingMask.edge1");
    this.edge1Internal = value;
    if (this.isPrepared) {
      this.uniforms[this.uniformNameEdge1].value = value;
    }
  }

  /** @internal */
  public override prepare(index: number): void {
    this.uniformNameEdge0 = `u_LightnessBlendingMaskEdge0_${index}`;
    this.uniformNameEdge1 = `u_LightnessBlendingMaskEdge1_${index}`;

    this.uniformDeclarations = [
      `uniform float ${this.uniformNameEdge0};`,
      `uniform float ${this.uniformNameEdge1};`,
    ];
    this.uniforms = {
      [this.uniformNameEdge0]: { value: this.edge0Internal },
      [this.uniformNameEdge1]: { value: this.edge1Internal },
    };
    this.helperFunctions = `
      float fxLightnessBlendingMask(vec4 color, float edge0, float edge1) {
        float brightness = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
        return smoothstep(edge0, edge1, brightness);
      }
    `;
    this.blendingExpression = `${CURRENT_EXPRESSION_VALUE_PLACEHOLDER} * fxLightnessBlendingMask(${BLENDING_EXPRESSION_CURRENT_COLOR_PLACEHOLDER}, ${this.uniformNameEdge0}, ${this.uniformNameEdge1})`;

    this.isPrepared = true;
  }
}

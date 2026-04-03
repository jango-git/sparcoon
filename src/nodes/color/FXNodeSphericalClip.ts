import { assertValidNonNegativeNumber } from "../../miscellaneous/asserts";
import { CURRENT_EXPRESSION_VALUE_PLACEHOLDER } from "../FXNode";
import { FXNodeColor } from "./FXNodeColor";

/**
 * Color node that clips a particle to a circle with a configurable soft edge
 *
 * @remarks
 * Fades alpha from fully opaque at `innerRadius` to fully transparent at the billboard edge
 * (UV radius `0.5`). An `innerRadius` of `0.5` produces a hard circular clip with no gradient.
 */
export class FXNodeSphericalClip extends FXNodeColor {
  /** @internal */
  public override readonly affectsDepth: boolean = true;
  /** @internal */
  public override readonly cacheKey: string = "spherical-clip";
  /** @internal */
  public override uniformDeclarations!: string[];
  /** @internal */
  public override uniforms!: Record<string, { value: unknown }>;
  /** @internal */
  public override helperFunctions!: string;
  /** @internal */
  public override colorExpression!: string;

  private uniformName!: string;

  private innerRadiusInternal: number;
  private isPrepared = false;

  /**
   * @param innerRadius - UV radius where the fade begins; must be non-negative. Defaults to `0.5`
   */
  constructor(innerRadius = 0.5) {
    super();
    assertValidNonNegativeNumber(innerRadius, "FXNodeSphericalClip.constructor.innerRadius");
    this.innerRadiusInternal = innerRadius;
  }

  /** UV radius of the fully opaque inner area */
  public get innerRadius(): number {
    return this.innerRadiusInternal;
  }

  public set innerRadius(value: number) {
    assertValidNonNegativeNumber(value, "FXNodeSphericalClip.innerRadius");
    this.innerRadiusInternal = value;
    if (this.isPrepared) {
      this.uniforms[this.uniformName].value = value;
    }
  }

  public override prepare(index: number): void {
    this.uniformName = `u_SphericalClipInnerRadius_${index}`;

    this.uniformDeclarations = [`uniform float ${this.uniformName};`];
    this.uniforms = {
      [this.uniformName]: { value: this.innerRadiusInternal },
    };
    this.helperFunctions = `
      vec4 fxApplySphericalClip(float innerRadius) {
        float distanceToCenter = distance(p_uv, vec2(0.5, 0.5));
        return vec4(1.0, 1.0, 1.0, 1.0 - smoothstep(innerRadius, 0.5, distanceToCenter));
      }
    `;
    this.colorExpression = `${CURRENT_EXPRESSION_VALUE_PLACEHOLDER} * fxApplySphericalClip(${this.uniformName})`;
    this.isPrepared = true;
  }
}

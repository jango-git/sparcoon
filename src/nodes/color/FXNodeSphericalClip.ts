import { assertValidNonNegativeNumber } from "../../miscellaneous/asserts";
import { getNextInstanceId } from "../../miscellaneous/miscellaneous";
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

  private readonly uniformInnerRadius: string;

  /**
   * @param innerRadius - UV radius where the fade begins; must be non-negative. Defaults to `0.5`
   */
  constructor(innerRadius = 0.5) {
    super();
    assertValidNonNegativeNumber(innerRadius, "FXNodeSphericalClip.constructor.innerRadius");
    const id = getNextInstanceId();
    this.uniformInnerRadius = `u_SphericalClipInnerRadius_${id}`;

    this.affectsDepth = true;
    this.cacheKey = "spherical-clip";
    this.uniformDeclarations = [`uniform float ${this.uniformInnerRadius};`];
    this.uniforms = {
      [this.uniformInnerRadius]: { value: innerRadius },
    };
    this.helperFunctions = `
      vec4 fxApplySphericalClip(float innerRadius) {
        float distanceToCenter = distance(p_uv, vec2(0.5, 0.5));
        return vec4(1.0, 1.0, 1.0, 1.0 - smoothstep(innerRadius, 0.5, distanceToCenter));
      }
    `;
    this.colorExpression = `fxApplySphericalClip(${this.uniformInnerRadius})`;
  }

  /** UV radius of the fully opaque inner area */
  public get innerRadius(): number {
    return this.uniforms[this.uniformInnerRadius].value as number;
  }

  public set innerRadius(value: number) {
    assertValidNonNegativeNumber(value, "FXNodeSphericalClip.innerRadius");
    this.uniforms[this.uniformInnerRadius].value = value;
  }
}

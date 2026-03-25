import type { DataTexture } from "three";
import type { FXColor } from "../../miscellaneous/color/FXColor";
import type { FXCurve1DConfig } from "../../miscellaneous/curve/FXCurve1D";
import { FXCurve1D } from "../../miscellaneous/curve/FXCurve1D";
import { buildGradientTexture, getNextInstanceId } from "../../miscellaneous/miscellaneous";
import { checkSRGBSupport } from "../../miscellaneous/webglCapabilities";
import { CURRENT_EXPRESSION_VALUE_PLACEHOLDER } from "../FXNode";
import { FXNodeColor } from "./FXNodeColor";

/**
 * Color node that animates particle color along a gradient curve over its lifetime
 */
export class FXNodeColorOverLife extends FXNodeColor {
  /** @internal */
  public override readonly affectsDepth: boolean = true;
  /** @internal */
  public override readonly cacheKey: string = "color-over-life";
  /** @internal */
  public override readonly uniformDeclarations: string[];
  /** @internal */
  public override readonly uniforms: Record<string, { value: unknown }>;
  /** @internal */
  public override readonly helperFunctions: string;
  /** @internal */
  public override readonly colorExpression: string;

  /** @internal */
  private gradientTexture: DataTexture;
  private readonly uniformName: string;
  private curveInternal: FXCurve1D<FXColor>;

  /**
   * @param curve - Color gradient defining the animation over the particle lifetime
   */
  constructor(curve: FXCurve1DConfig<FXColor>) {
    super();
    const id = getNextInstanceId();
    this.uniformName = `u_ColorOverLife_${id}`;
    this.curveInternal = new FXCurve1D<FXColor>(curve);
    this.gradientTexture = buildGradientTexture(this.curveInternal);

    this.uniformDeclarations = [`uniform sampler2D ${this.uniformName};`];
    this.uniforms = {
      [this.uniformName]: { value: this.gradientTexture },
    };
    this.helperFunctions = `
      vec4 fxSampleColorOverLife(sampler2D gradientTexture) {
        // Normalized particle age [0, 1] maps to the gradient texture's x-axis
        float lifetimeRatio = clamp(PARTICLE_AGE / PARTICLE_LIFETIME, 0.0, 1.0);
        vec4 color = texture2D(gradientTexture, vec2(lifetimeRatio, 0.5));

        // Apply gamma correction when sRGB textures are not natively supported
        ${checkSRGBSupport() ? "" : "color = vec4(pow(color.rgb, vec3(2.2)), color.a);"}

        return color;
      }
    `;
    this.colorExpression = `${CURRENT_EXPRESSION_VALUE_PLACEHOLDER} * fxSampleColorOverLife(${this.uniformName})`;
  }

  /** Current color gradient curve */
  public get curve(): FXCurve1D<FXColor> {
    return this.curveInternal;
  }

  public set curve(value: FXCurve1DConfig<FXColor>) {
    this.curveInternal = new FXCurve1D<FXColor>(value);
    this.gradientTexture.dispose();
    this.gradientTexture = buildGradientTexture(this.curveInternal);
    this.uniforms[this.uniformName].value = this.gradientTexture;
  }

  /** Releases the backing gradient texture */
  public override destroy(): void {
    this.gradientTexture.dispose();
  }
}

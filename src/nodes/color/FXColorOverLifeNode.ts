import type { DataTexture } from "three";
import type { FXColor } from "../../miscellaneous/color/FXColor";
import { buildGradientTexture } from "../../miscellaneous/miscellaneous";
import { checkSRGBSupport } from "../../miscellaneous/webglCapabilities";
import { FXColorNode } from "./FXColorNode";

const INSTANCES: FXColorOverLifeNode[] = [];

export class FXColorOverLifeNode extends FXColorNode {
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

  /** @internal */
  private readonly gradientTexture: DataTexture;

  constructor(colors: FXColor[]) {
    if (colors.length === 0) {
      throw new Error("FXColorOverLifeNode: colors array cannot be empty");
    }

    super();
    INSTANCES.push(this);
    const uniformName = `u_ColorOverLife_${INSTANCES.length - 1}`;

    this.gradientTexture = buildGradientTexture(colors);

    this.affectsDepth = true;
    this.cacheKey = "color-over-life";
    this.uniformDeclarations = [`uniform sampler2D ${uniformName};`];
    this.uniforms = {
      [uniformName]: { value: this.gradientTexture },
    };
    this.helperFunctions = `
      vec4 sampleColorOverLife(sampler2D gradientTexture) {
        // Normalized particle age [0, 1] maps to the gradient texture's x-axis
        float lifetimeRatio = clamp(PARTICLE_AGE / PARTICLE_LIFETIME, 0.0, 1.0);
        vec4 color = texture2D(gradientTexture, vec2(lifetimeRatio, 0.5));

        // Apply gamma correction when sRGB textures are not natively supported
        ${checkSRGBSupport() ? "" : "color = vec4(pow(color.rgb, vec3(2.2)), color.a);"}

        return color;
      }
    `;
    this.colorExpression = `sampleColorOverLife(${uniformName})`;
  }

  public override destroy(): void {
    this.gradientTexture.dispose();
    const index = INSTANCES.indexOf(this);
    if (index !== -1) {
      INSTANCES.splice(index, 1);
    }
  }
}

import type { DataTexture } from "three";
import type { FXColor } from "../../miscellaneous/color/FXColor";
import { buildGradientTexture } from "../../miscellaneous/miscellaneous";
import { checkSRGBSupport } from "../../miscellaneous/webglCapabilities";
import { FXColorNode } from "./FXColorNode";

export class FXColorOverLifeNode extends FXColorNode {
  /** @internal */
  public override readonly affectsDepth = true;
  /** @internal */
  public override readonly cacheKey = "color-over-life";
  /** @internal */
  public override readonly uniformDeclarations = ["uniform sampler2D u_ColorOverLife;"];
  /** @internal */
  public override readonly uniforms: Record<string, { value: unknown }>;
  /** @internal */
  public override readonly helperFunctions: string;
  /** @internal */
  public override readonly colorExpression = "_fx_sampleColorOverLife(u_ColorOverLife)";

  private readonly gradientTexture: DataTexture;

  constructor(colors: FXColor[]) {
    if (colors.length === 0) {
      throw new Error("FXColorOverLifeNode: colors array cannot be empty");
    }

    super();

    this.gradientTexture = buildGradientTexture(colors);
    this.uniforms = {
      // eslint-disable-next-line @typescript-eslint/naming-convention
      u_ColorOverLife: { value: this.gradientTexture },
    };
    this.helperFunctions = `
      vec4 _fx_sampleColorOverLife(sampler2D tex) {
        float t = clamp(PARTICLE_AGE / PARTICLE_LIFETIME, 0.0, 1.0);
        vec4 c = texture2D(tex, vec2(t, 0.5));
        ${checkSRGBSupport() ? "" : "c = vec4(pow(c.rgb, vec3(2.2)), c.a);"}
        return c;
      }
    `;
  }

  public override destroy(): void {
    this.gradientTexture.dispose();
  }
}

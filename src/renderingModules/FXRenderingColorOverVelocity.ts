import type { DataTexture } from "three";
import type { FXColor } from "../color/FXColor";
import type { FXProperty, FXPropertyName } from "../instancedParticle/shared";
import { buildGradientTexture } from "../miscellaneous/miscellaneous";
import source from "../shaders/FXRenderingColorOverVelocity.glsl";
import { FXRenderingModule } from "./FXRenderingModule";

/**
 * Colors particles based on velocity magnitude.
 *
 * Maps velocity from 0 to maxVelocity across the color gradient.
 */
export class FXRenderingColorOverVelocity extends FXRenderingModule {
  /** @internal */
  public override readonly requiredProperties: Record<string, FXPropertyName> = {
    builtin: "Matrix4",
  } as const;
  /** @internal */
  public readonly requiredUniforms: Record<string, FXProperty>;
  /** @internal */
  public readonly source = source;

  /**
   * @param colors - Color gradient from slow to fast
   * @param maxVelocity - Velocity mapped to final color
   */
  constructor(colors: FXColor[], maxVelocity: number) {
    super();

    if (colors.length === 0) {
      throw new Error("FXRenderingColorOverVelocity: colors array cannot be empty");
    }

    if (maxVelocity <= 0) {
      throw new Error("FXRenderingColorOverVelocity: maxVelocity must be greater than 0");
    }

    this.source = source.replace(
      "COLOR_OVER_VELOCITY_MAX",
      `COLOR_OVER_VELOCITY_MAX ${maxVelocity.toFixed(2)}`,
    );

    this.requiredUniforms = { colorOverVelocityTexture: buildGradientTexture(colors) } as const;
  }

  public override destroy(): void {
    (this.requiredUniforms.colorOverVelocityTexture as DataTexture).dispose();
  }
}

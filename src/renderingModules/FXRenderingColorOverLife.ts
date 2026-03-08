import type { DataTexture } from "three";
import type { FXColor } from "../color/FXColor";
import type { FXProperty, FXPropertyName } from "../instancedParticle/shared";
import { buildGradientTexture } from "../miscellaneous/miscellaneous";
import source from "../shaders/FXRenderingColorOverLife.glsl";
import { FXRenderingModule } from "./FXRenderingModule";

/**
 * Colors particles based on lifetime progression.
 *
 * Interpolates through color gradient as particles age from birth to death.
 */
export class FXRenderingColorOverLife extends FXRenderingModule {
  /** @internal */
  public override readonly requiredProperties: Record<string, FXPropertyName> = {
    builtin: "Matrix4",
  } as const;
  /** @internal */
  public readonly requiredUniforms: Record<string, FXProperty>;
  /** @internal */
  public readonly source = source;

  /**
   * @param colors - Color gradient stops from birth to death
   */
  constructor(colors: FXColor[]) {
    super();

    if (colors.length === 0) {
      throw new Error("FXRenderingColorOverLife: colors array cannot be empty");
    }

    this.requiredUniforms = { colorOverLifeTexture: buildGradientTexture(colors) };
  }

  public override destroy(): void {
    (this.requiredUniforms.colorOverLifeTexture as DataTexture).dispose();
  }
}

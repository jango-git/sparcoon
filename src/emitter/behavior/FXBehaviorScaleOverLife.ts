import type { InstancedBufferAttribute } from "three";
import { MathUtils } from "three";
import {
  assertValidNonNegativeNumber,
  assertValidPositiveNumber,
} from "../../miscellaneous/asserts";
import type { FXAspectConfig, FXRange, FXRangeConfig } from "../../miscellaneous/miscellaneous";
import {
  BUILTIN_OFFSET_AGE,
  BUILTIN_OFFSET_LIFETIME,
  BUILTIN_OFFSET_RANDOM_A,
  BUILTIN_OFFSET_SCALE_X,
  BUILTIN_OFFSET_SCALE_Y,
  resolveAspect,
  resolveFXRangeConfig,
} from "../../miscellaneous/miscellaneous";
import { FXBehavior } from "./FXBehavior";

/**
 * Animates particle scale over lifetime.
 *
 * Interpolates between scale anchors based on particle age. Requires at least 2 anchors.
 */
export class FXBehaviorScaleOverLife extends FXBehavior<{ builtin: "Matrix4" }> {
  /** @internal */
  public readonly requiredProperties = { builtin: "Matrix4" } as const;
  private readonly scales: FXRange[] = [];
  private aspectInternal: number;

  /**
   * @param scales - Scale anchor points. Each accepts number, tuple, or range object
   * @param aspect - Width/height ratio. Accepts number or texture
   */
  constructor(scales: FXRangeConfig[], aspect: FXAspectConfig = 1) {
    super();

    if (scales.length < 2) {
      throw new Error(
        "FXBehaviorScaleOverLife.scales: the number of scale anchors must be more than two",
      );
    }

    for (let i = 0; i < scales.length; i++) {
      const scale = resolveFXRangeConfig(scales[i]);
      assertValidNonNegativeNumber(
        scale.min,
        `FXBehaviorScaleOverLife.constructor.scales[${i}].min`,
      );
      assertValidNonNegativeNumber(
        scale.max,
        `FXBehaviorScaleOverLife.constructor.scales[${i}].max`,
      );
      this.scales.push(scale);
    }

    this.aspectInternal = resolveAspect(aspect);
    assertValidPositiveNumber(this.aspectInternal, "FXBehaviorScaleOverLife.constructor.aspect");
  }

  /** Width/height aspect ratio */
  public get aspect(): number {
    return this.aspectInternal;
  }

  /** Width/height aspect ratio */
  public set aspect(value: FXAspectConfig) {
    this.aspectInternal = resolveAspect(value);
    assertValidPositiveNumber(this.aspectInternal, "FXBehaviorScaleOverLife.aspect");
  }

  /** @internal */
  public update(properties: { builtin: InstancedBufferAttribute }, instanceCount: number): void {
    const { builtin } = properties;
    const { array, itemSize } = builtin;

    for (let i = 0; i < instanceCount; i++) {
      const itemOffset = i * itemSize;
      const lifeT = Math.min(
        array[itemOffset + BUILTIN_OFFSET_AGE] / array[itemOffset + BUILTIN_OFFSET_LIFETIME],
        1,
      );

      const segment = (this.scales.length - 1) * lifeT;
      const index = Math.floor(segment);

      // Constant over the life of a particle but different for each particle
      const scaleT = array[itemOffset + BUILTIN_OFFSET_RANDOM_A];

      const localT = segment - index;
      const scaleRange0 = this.scales[index];
      const scaleRange1 = this.scales[index + 1];
      const scale0 = MathUtils.lerp(scaleRange0.min, scaleRange0.max, scaleT);
      const scale1 = MathUtils.lerp(scaleRange1.min, scaleRange1.max, scaleT);

      const interpolatedScale = scale0 + (scale1 - scale0) * localT;

      array[itemOffset + BUILTIN_OFFSET_SCALE_X] = interpolatedScale * this.aspectInternal;
      array[itemOffset + BUILTIN_OFFSET_SCALE_Y] = interpolatedScale;
    }

    builtin.needsUpdate = true;
  }
}

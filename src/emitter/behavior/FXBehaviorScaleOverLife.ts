import type { InstancedBufferAttribute } from "three";
import { MathUtils } from "three";
import { assertValidPositiveNumber } from "../../miscellaneous/asserts";
import type { FXCurve1DConfig } from "../../miscellaneous/curve/FXCurve1D";
import { FXCurve1D } from "../../miscellaneous/curve/FXCurve1D";
import type { FXAspectConfig, FXRange } from "../../miscellaneous/miscellaneous";
import {
  BUILTIN_OFFSET_AGE,
  BUILTIN_OFFSET_LIFETIME,
  BUILTIN_OFFSET_RANDOM_A,
  BUILTIN_OFFSET_SCALE_X,
  BUILTIN_OFFSET_SCALE_Y,
  resolveAspect,
} from "../../miscellaneous/miscellaneous";
import { FXBehavior } from "./FXBehavior";

/**
 * Animates particle scale over lifetime using a {@link FXCurve1D}
 */
export class FXBehaviorScaleOverLife extends FXBehavior<{ builtin: "Matrix4" }> {
  /** @internal */
  public readonly requiredProperties = { builtin: "Matrix4" } as const;
  /** Active scale curve */
  public curve: FXCurve1D<FXRange>;
  private aspectInternal: number;

  /**
   * @param curve - Scale curve; accepts a {@link FXCurve1D} instance or a `FXRange[]` shorthand
   * @param aspect - Width/height ratio; must be positive. Defaults to `1`
   */
  constructor(curve: FXCurve1DConfig<FXRange>, aspect: FXAspectConfig = 1) {
    super();
    this.curve = new FXCurve1D<FXRange>(curve);
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

      const scaleT = array[itemOffset + BUILTIN_OFFSET_RANDOM_A];
      const { a, b, t: localT } = this.curve.sample(lifeT);
      const scale = MathUtils.lerp(
        MathUtils.lerp(a.min, a.max, scaleT),
        MathUtils.lerp(b.min, b.max, scaleT),
        localT,
      );

      array[itemOffset + BUILTIN_OFFSET_SCALE_X] = scale * this.aspectInternal;
      array[itemOffset + BUILTIN_OFFSET_SCALE_Y] = scale;
    }

    builtin.needsUpdate = true;
  }
}

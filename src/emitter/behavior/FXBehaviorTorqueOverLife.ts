import type { InstancedBufferAttribute } from "three";
import { MathUtils } from "three";
import type { FXCurve1DConfig } from "../../miscellaneous/curve/FXCurve1D";
import { FXCurve1D } from "../../miscellaneous/curve/FXCurve1D";
import type { FXRange } from "../../miscellaneous/miscellaneous";
import {
  BUILTIN_OFFSET_AGE,
  BUILTIN_OFFSET_LIFETIME,
  BUILTIN_OFFSET_RANDOM_B,
  BUILTIN_OFFSET_TORQUE,
} from "../../miscellaneous/miscellaneous";
import { FXBehavior } from "./FXBehavior";

/**
 * Animates particle angular velocity over lifetime using a {@link FXCurve1D}
 */
export class FXBehaviorTorqueOverLife extends FXBehavior<{ builtin: "Matrix4" }> {
  /** @internal */
  public readonly requiredProperties = { builtin: "Matrix4" } as const;
  /** Active torque curve */
  public curve: FXCurve1D<FXRange>;

  /**
   * @param curve - Torque curve; accepts a {@link FXCurve1D} instance or a `FXRange[]` shorthand
   */
  constructor(curve: FXCurve1DConfig<FXRange>) {
    super();
    this.curve = new FXCurve1D<FXRange>(curve);
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

      const torqueT = array[itemOffset + BUILTIN_OFFSET_RANDOM_B];
      const { a, b, t: localT } = this.curve.sample(lifeT);
      array[itemOffset + BUILTIN_OFFSET_TORQUE] = MathUtils.lerp(
        MathUtils.lerp(a.min, a.max, torqueT),
        MathUtils.lerp(b.min, b.max, torqueT),
        localT,
      );
    }

    builtin.needsUpdate = true;
  }
}

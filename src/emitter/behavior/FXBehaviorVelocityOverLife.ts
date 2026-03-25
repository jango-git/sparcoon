import type { InstancedBufferAttribute } from "three";
import { MathUtils } from "three";
import type { FXCurve1DConfig } from "../../miscellaneous/curve/FXCurve1D";
import { FXCurve1D } from "../../miscellaneous/curve/FXCurve1D";
import type { FXRange } from "../../miscellaneous/miscellaneous";
import {
  BUILTIN_OFFSET_AGE,
  BUILTIN_OFFSET_LIFETIME,
  BUILTIN_OFFSET_RANDOM_A,
  BUILTIN_OFFSET_VELOCITY_X,
  BUILTIN_OFFSET_VELOCITY_Y,
  BUILTIN_OFFSET_VELOCITY_Z,
} from "../../miscellaneous/miscellaneous";
import { FXBehavior } from "./FXBehavior";

/**
 * Animates particle speed over lifetime using a {@link FXCurve1D}
 *
 * @remarks
 * Particles with zero velocity are not affected.
 */
export class FXBehaviorVelocityOverLife extends FXBehavior<{ builtin: "Matrix4" }> {
  /** @internal */
  public readonly requiredProperties = { builtin: "Matrix4" } as const;
  private curveInternal: FXCurve1D<FXRange>;

  /**
   * @param curve - Speed curve; accepts a {@link FXCurve1D} instance or a `FXRange[]` shorthand
   */
  constructor(curve: FXCurve1DConfig<FXRange>) {
    super();
    this.curveInternal = new FXCurve1D<FXRange>(curve);
  }

  /** Active speed curve */
  public get curve(): FXCurve1D<FXRange> {
    return this.curveInternal;
  }

  public set curve(value: FXCurve1DConfig<FXRange>) {
    this.curveInternal = new FXCurve1D<FXRange>(value);
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

      const velocityX = array[itemOffset + BUILTIN_OFFSET_VELOCITY_X];
      const velocityY = array[itemOffset + BUILTIN_OFFSET_VELOCITY_Y];
      const velocityZ = array[itemOffset + BUILTIN_OFFSET_VELOCITY_Z];
      const currentSpeed = Math.sqrt(
        velocityX * velocityX + velocityY * velocityY + velocityZ * velocityZ,
      );

      if (currentSpeed === 0) {
        continue;
      }

      const velocityT = array[itemOffset + BUILTIN_OFFSET_RANDOM_A];
      const { a, b, t: localT } = this.curveInternal.sample(lifeT);
      const targetSpeed = MathUtils.lerp(
        MathUtils.lerp(a.min, a.max, velocityT),
        MathUtils.lerp(b.min, b.max, velocityT),
        localT,
      );
      const scaleFactor = targetSpeed / currentSpeed;

      array[itemOffset + BUILTIN_OFFSET_VELOCITY_X] = velocityX * scaleFactor;
      array[itemOffset + BUILTIN_OFFSET_VELOCITY_Y] = velocityY * scaleFactor;
      array[itemOffset + BUILTIN_OFFSET_VELOCITY_Z] = velocityZ * scaleFactor;
    }

    builtin.needsUpdate = true;
  }
}

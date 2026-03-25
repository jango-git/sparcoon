import type { InstancedBufferAttribute } from "three";
import { MathUtils } from "three";
import { assertValidNonNegativeNumber } from "../../miscellaneous/asserts";
import type { FXRange, FXRangeConfig } from "../../miscellaneous/miscellaneous";
import {
  BUILTIN_OFFSET_RANDOM_B,
  BUILTIN_OFFSET_TORQUE,
  resolveFXRangeConfig,
} from "../../miscellaneous/miscellaneous";
import { FXBehavior } from "./FXBehavior";

/**
 * Reduces particle angular velocity over time
 *
 * @remarks
 * A damping value of `0` has no effect; `1` stops the particle instantly.
 */
export class FXBehaviorTorqueDamping extends FXBehavior<{
  builtin: "Matrix4";
}> {
  /** @internal */
  public readonly requiredProperties = { builtin: "Matrix4" } as const;
  private dampingInternal: FXRange;

  /**
   * @param damping - Damping coefficient range (0-1). Accepts number, tuple, or range object
   */
  constructor(damping: FXRangeConfig) {
    super();
    this.dampingInternal = resolveFXRangeConfig(damping);
    assertValidNonNegativeNumber(
      this.dampingInternal.min,
      `FXBehaviorTorqueDamping.constructor.damping.min`,
    );
    assertValidNonNegativeNumber(
      this.dampingInternal.max,
      `FXBehaviorTorqueDamping.constructor.damping.max`,
    );
  }

  /** Damping coefficient range (0-1) */
  public get damping(): FXRange {
    return this.dampingInternal;
  }

  public set damping(value: FXRangeConfig) {
    this.dampingInternal = resolveFXRangeConfig(value);
    assertValidNonNegativeNumber(this.dampingInternal.min, `FXBehaviorTorqueDamping.damping.min`);
    assertValidNonNegativeNumber(this.dampingInternal.max, `FXBehaviorTorqueDamping.damping.max`);
  }

  /** @internal */
  public update(
    properties: { builtin: InstancedBufferAttribute },
    instanceCount: number,
    deltaTime: number,
  ): void {
    const { builtin } = properties;
    const { array, itemSize } = builtin;

    for (let i = 0; i < instanceCount; i++) {
      const itemOffset = i * itemSize;

      // Constant over the life of a particle but different for each particle
      const dampingT = array[itemOffset + BUILTIN_OFFSET_RANDOM_B];
      const dampingFactor = Math.pow(
        1 - MathUtils.lerp(this.dampingInternal.min, this.dampingInternal.max, dampingT),
        deltaTime,
      );
      array[itemOffset + BUILTIN_OFFSET_TORQUE] *= dampingFactor;
    }

    builtin.needsUpdate = true;
  }
}

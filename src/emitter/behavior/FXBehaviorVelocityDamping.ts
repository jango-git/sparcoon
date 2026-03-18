import type { InstancedBufferAttribute } from "three";
import { MathUtils } from "three";
import { assertValidNonNegativeNumber } from "../../miscellaneous/asserts";
import {
  BUILTIN_OFFSET_RANDOM_B,
  BUILTIN_OFFSET_VELOCITY_X,
  BUILTIN_OFFSET_VELOCITY_Y,
  BUILTIN_OFFSET_VELOCITY_Z,
  resolveFXRangeConfig,
  type FXRange,
  type FXRangeConfig,
} from "../../miscellaneous/miscellaneous";
import { FXBehaviorModule } from "./FXBehaviorModule";

/**
 * Reduces particle velocity over time.
 *
 * Applies exponential decay to velocity. Damping of 0 means no effect, 1 means instant stop.
 */
export class FXBehaviorVelocityDamping extends FXBehaviorModule<{ builtin: "Matrix4" }> {
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
      `FXBehaviorVelocityDamping.constructor.damping.min`,
    );
    assertValidNonNegativeNumber(
      this.dampingInternal.max,
      `FXBehaviorVelocityDamping.constructor.damping.max`,
    );
  }

  /** Damping coefficient range (0-1) */
  public get damping(): FXRange {
    return this.dampingInternal;
  }

  /** Damping coefficient range (0-1) */
  public set damping(value: FXRangeConfig) {
    this.dampingInternal = resolveFXRangeConfig(value);
    assertValidNonNegativeNumber(this.dampingInternal.min, `FXBehaviorVelocityDamping.damping.min`);
    assertValidNonNegativeNumber(this.dampingInternal.max, `FXBehaviorVelocityDamping.damping.max`);
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

      array[itemOffset + BUILTIN_OFFSET_VELOCITY_X] *= dampingFactor;
      array[itemOffset + BUILTIN_OFFSET_VELOCITY_Y] *= dampingFactor;
      array[itemOffset + BUILTIN_OFFSET_VELOCITY_Z] *= dampingFactor;
    }

    builtin.needsUpdate = true;
  }
}

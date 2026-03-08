import { MathUtils, type InstancedBufferAttribute } from "three";
import { assertValidNumber } from "../miscellaneous/asserts";
import type { Vector3Like } from "../miscellaneous/math";
import {
  BUILTIN_OFFSET_POSITION_X,
  BUILTIN_OFFSET_POSITION_Y,
  BUILTIN_OFFSET_POSITION_Z,
  BUILTIN_OFFSET_RANDOM_A,
  BUILTIN_OFFSET_RANDOM_B,
  BUILTIN_OFFSET_RANDOM_C,
  BUILTIN_OFFSET_VELOCITY_X,
  BUILTIN_OFFSET_VELOCITY_Y,
  BUILTIN_OFFSET_VELOCITY_Z,
  resolveFXRangeConfig,
  resolveFXVector3Config,
  type FXRange,
  type FXRangeConfig,
  type FXVector3Config,
} from "../miscellaneous/miscellaneous";
import { FXBehaviorModule } from "./FXBehaviorModule";

/**
 * Applies gravity attraction toward a point.
 *
 * Force follows inverse power law: strength / distance^exponent. Particles closer than threshold are unaffected.
 */
export class FXBehaviorPointGravity extends FXBehaviorModule<{ builtin: "Matrix4" }> {
  /** @internal */
  public readonly requiredProperties = { builtin: "Matrix4" } as const;
  private centerInternal: Vector3Like;
  private strengthInternal: FXRange;
  private exponentInternal: FXRange;
  private thresholdInternal: FXRange;

  /**
   * @param center - Gravity center position
   * @param strength - Force multiplier range. Accepts number, tuple, or range object
   * @param exponent - Distance power exponent range. Accepts number, tuple, or range object
   * @param threshold - Minimum distance range. Accepts number, tuple, or range object
   */
  constructor(
    center: Vector3Like,
    strength: FXRangeConfig,
    exponent: FXRangeConfig = 2,
    threshold: FXRangeConfig = 1,
  ) {
    super();
    this.centerInternal = resolveFXVector3Config(center);
    assertValidNumber(this.centerInternal.x, "FXBehaviorPointGravity.constructor.center.x");
    assertValidNumber(this.centerInternal.y, "FXBehaviorPointGravity.constructor.center.y");
    assertValidNumber(this.centerInternal.z, "FXBehaviorPointGravity.constructor.center.z");

    this.strengthInternal = resolveFXRangeConfig(strength);
    assertValidNumber(this.strengthInternal.min, "FXBehaviorPointGravity.constructor.strength.min");
    assertValidNumber(this.strengthInternal.max, "FXBehaviorPointGravity.constructor.strength.max");

    this.exponentInternal = resolveFXRangeConfig(exponent);
    assertValidNumber(this.exponentInternal.min, "FXBehaviorPointGravity.constructor.exponent.min");
    assertValidNumber(this.exponentInternal.max, "FXBehaviorPointGravity.constructor.exponent.max");

    this.thresholdInternal = resolveFXRangeConfig(threshold);
    assertValidNumber(
      this.thresholdInternal.min,
      "FXBehaviorPointGravity.constructor.threshold.min",
    );
    assertValidNumber(
      this.thresholdInternal.max,
      "FXBehaviorPointGravity.constructor.threshold.max",
    );
  }

  /** Gravity center position */
  public get center(): Vector3Like {
    return this.centerInternal;
  }

  /** Force multiplier range */
  public get strength(): FXRange {
    return this.strengthInternal;
  }

  /** Distance power exponent range */
  public get exponent(): FXRange {
    return this.exponentInternal;
  }

  /** Minimum distance range */
  public get threshold(): FXRange {
    return this.thresholdInternal;
  }

  /** Gravity center position */
  public set center(value: FXVector3Config) {
    this.centerInternal = resolveFXVector3Config(value);
    assertValidNumber(this.centerInternal.x, "FXBehaviorPointGravity.center.x");
    assertValidNumber(this.centerInternal.y, "FXBehaviorPointGravity.center.y");
    assertValidNumber(this.centerInternal.z, "FXBehaviorPointGravity.center.z");
  }

  /** Force multiplier range */
  public set strength(value: FXRangeConfig) {
    this.strengthInternal = resolveFXRangeConfig(value);
    assertValidNumber(this.strengthInternal.min, "FXBehaviorPointGravity.strength.min");
    assertValidNumber(this.strengthInternal.max, "FXBehaviorPointGravity.strength.max");
  }

  /** Distance power exponent range */
  public set exponent(value: FXRangeConfig) {
    this.exponentInternal = resolveFXRangeConfig(value);
    assertValidNumber(this.exponentInternal.min, "FXBehaviorPointGravity.exponent.min");
    assertValidNumber(this.exponentInternal.max, "FXBehaviorPointGravity.exponent.max");
  }

  /** Minimum distance range */
  public set threshold(value: FXRangeConfig) {
    this.thresholdInternal = resolveFXRangeConfig(value);
    assertValidNumber(this.thresholdInternal.min, "FXBehaviorPointGravity.threshold.min");
    assertValidNumber(this.thresholdInternal.max, "FXBehaviorPointGravity.threshold.max");
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

      const dx = this.centerInternal.x - array[itemOffset + BUILTIN_OFFSET_POSITION_X];
      const dy = this.centerInternal.y - array[itemOffset + BUILTIN_OFFSET_POSITION_Y];
      const dz = this.centerInternal.z - array[itemOffset + BUILTIN_OFFSET_POSITION_Z];

      // Constant over the life of a particle but different for each particle
      const thresholdT = array[itemOffset + BUILTIN_OFFSET_RANDOM_A];
      const threshold = MathUtils.lerp(this.threshold.min, this.threshold.max, thresholdT);

      const thresholdSquared = threshold * threshold;
      const distanceSquared = dx * dx + dy * dy + dz * dz;
      if (distanceSquared < thresholdSquared) {
        continue;
      }

      // Constant over the life of a particle but different for each particle
      const strengthT = array[itemOffset + BUILTIN_OFFSET_RANDOM_B];
      const strength = MathUtils.lerp(
        this.strengthInternal.min,
        this.strengthInternal.max,
        strengthT,
      );

      // Constant over the life of a particle but different for each particle
      const exponentT = array[itemOffset + BUILTIN_OFFSET_RANDOM_C];
      const exponent = MathUtils.lerp(
        this.exponentInternal.min,
        this.exponentInternal.max,
        exponentT,
      );

      const distance = Math.sqrt(distanceSquared);
      const forceMagnitude = strength / Math.pow(distance, exponent);

      const directionX = dx / distance;
      const directionY = dy / distance;
      const directionZ = dz / distance;

      const accelerationX = directionX * forceMagnitude;
      const accelerationY = directionY * forceMagnitude;
      const accelerationZ = directionZ * forceMagnitude;

      array[itemOffset + BUILTIN_OFFSET_VELOCITY_X] += accelerationX * deltaTime;
      array[itemOffset + BUILTIN_OFFSET_VELOCITY_Y] += accelerationY * deltaTime;
      array[itemOffset + BUILTIN_OFFSET_VELOCITY_Z] += accelerationZ * deltaTime;
    }

    builtin.needsUpdate = true;
  }
}

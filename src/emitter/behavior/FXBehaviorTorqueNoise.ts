import { makeNoise3D } from "fast-simplex-noise";
import type { InstancedBufferAttribute } from "three";
import { MathUtils } from "three";
import {
  assertValidNonNegativeNumber,
  assertValidPositiveNumber,
} from "../../miscellaneous/asserts";
import type { FXRange, FXRangeConfig } from "../../miscellaneous/miscellaneous";
import {
  BUILTIN_OFFSET_POSITION_X,
  BUILTIN_OFFSET_POSITION_Y,
  BUILTIN_OFFSET_POSITION_Z,
  BUILTIN_OFFSET_RANDOM_A,
  BUILTIN_OFFSET_RANDOM_C,
  BUILTIN_OFFSET_TORQUE,
  resolveFXRangeConfig,
} from "../../miscellaneous/miscellaneous";
import { FXBehavior } from "./FXBehavior";

const generateNoise3D = makeNoise3D();

/**
 * Applies noise-based angular acceleration to particles
 *
 * @remarks
 * Higher `scale` values produce finer noise detail.
 */
export class FXBehaviorTorqueNoise extends FXBehavior<{ builtin: "Matrix4" }> {
  /** @internal */
  public readonly requiredProperties = { builtin: "Matrix4" } as const;
  private scaleInternal: FXRange;
  private strengthInternal: FXRange;

  /**
   * @param scale - Noise frequency range. Accepts number, tuple, or range object
   * @param strength - Force multiplier range. Accepts number, tuple, or range object
   */
  constructor(scale: FXRangeConfig, strength: FXRangeConfig) {
    super();
    this.scaleInternal = resolveFXRangeConfig(scale);
    assertValidPositiveNumber(
      this.scaleInternal.min,
      `FXBehaviorTorqueNoise.constructor.scale.min`,
    );
    assertValidPositiveNumber(
      this.scaleInternal.max,
      `FXBehaviorTorqueNoise.constructor.scale.max`,
    );

    this.strengthInternal = resolveFXRangeConfig(strength);
    assertValidNonNegativeNumber(
      this.strengthInternal.min,
      `FXBehaviorTorqueNoise.constructor.strength.min`,
    );
    assertValidNonNegativeNumber(
      this.strengthInternal.max,
      `FXBehaviorTorqueNoise.constructor.strength.max`,
    );
  }

  /** Noise frequency range */
  public get scale(): FXRange {
    return this.scaleInternal;
  }

  /** Force multiplier range */
  public get strength(): FXRange {
    return this.strengthInternal;
  }

  /** Noise frequency range */
  public set scale(value: FXRangeConfig) {
    this.scaleInternal = resolveFXRangeConfig(value);
    assertValidPositiveNumber(this.scaleInternal.min, `FXBehaviorTorqueNoise.scale.min`);
    assertValidPositiveNumber(this.scaleInternal.max, `FXBehaviorTorqueNoise.scale.max`);
  }

  /** Force multiplier range */
  public set strength(value: FXRangeConfig) {
    this.strengthInternal = resolveFXRangeConfig(value);
    assertValidNonNegativeNumber(this.strengthInternal.min, `FXBehaviorTorqueNoise.strength.min`);
    assertValidNonNegativeNumber(this.strengthInternal.max, `FXBehaviorTorqueNoise.strength.max`);
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
      const scaleT = array[itemOffset + BUILTIN_OFFSET_RANDOM_C];
      const scale = MathUtils.lerp(this.scaleInternal.min, this.scaleInternal.max, scaleT);
      const noise = generateNoise3D(
        array[itemOffset + BUILTIN_OFFSET_POSITION_X] * scale,
        array[itemOffset + BUILTIN_OFFSET_POSITION_Y] * scale,
        array[itemOffset + BUILTIN_OFFSET_POSITION_Z] * scale,
      );

      // Constant over the life of a particle but different for each particle
      const strengthT = array[itemOffset + BUILTIN_OFFSET_RANDOM_A];
      const strength = MathUtils.lerp(
        this.strengthInternal.min,
        this.strengthInternal.max,
        strengthT,
      );

      array[itemOffset + BUILTIN_OFFSET_TORQUE] += noise * strength * deltaTime;
    }

    builtin.needsUpdate = true;
  }
}

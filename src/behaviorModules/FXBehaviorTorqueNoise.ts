import { MathUtils, type InstancedBufferAttribute } from "three";
import { assertValidNonNegativeNumber, assertValidPositiveNumber } from "../miscellaneous/asserts";
import {
  BUILTIN_OFFSET_POSITION_X,
  BUILTIN_OFFSET_POSITION_Y,
  BUILTIN_OFFSET_POSITION_Z,
  BUILTIN_OFFSET_RANDOM_A,
  BUILTIN_OFFSET_RANDOM_C,
  BUILTIN_OFFSET_TORQUE,
  generateNoise3D,
  resolveFXRangeConfig,
  type FXRange,
  type FXRangeConfig,
} from "../miscellaneous/miscellaneous";
import { FXBehaviorModule } from "./FXBehaviorModule";

/**
 * Applies noise-based angular acceleration to particles.
 *
 * Uses 2D noise based on particle position. Higher scale means finer noise detail.
 */
export class FXBehaviorTorqueNoise extends FXBehaviorModule<{ builtin: "Matrix4" }> {
  /** @internal */
  public readonly requiredProperties = { builtin: "Matrix4" } as const;
  private scaleInternal: FXRange;
  private strengthInternal: FXRange;

  /**
   * @param scale - Noise frequency range. Accepts number, tuple, or range object
   * @param strength - Force multiplier range. Accepts number, tuple, or range object
   */
  constructor(scale: number, strength: number) {
    super();
    this.scaleInternal = resolveFXRangeConfig(scale);
    assertValidPositiveNumber(
      this.scaleInternal.min,
      `UIBehaviorTorqueNoise.constructor.scale.min`,
    );
    assertValidPositiveNumber(
      this.scaleInternal.max,
      `UIBehaviorTorqueNoise.constructor.scale.max`,
    );

    this.strengthInternal = resolveFXRangeConfig(strength);
    assertValidNonNegativeNumber(
      this.strengthInternal.min,
      `UIBehaviorTorqueNoise.constructor.strength.min`,
    );
    assertValidNonNegativeNumber(
      this.strengthInternal.max,
      `UIBehaviorTorqueNoise.constructor.strength.max`,
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
    assertValidPositiveNumber(this.scaleInternal.min, `UIBehaviorTorqueNoise.scale.min`);
    assertValidPositiveNumber(this.scaleInternal.max, `UIBehaviorTorqueNoise.scale.max`);
  }

  /** Force multiplier range */
  public set strength(value: FXRangeConfig) {
    this.strengthInternal = resolveFXRangeConfig(value);
    assertValidNonNegativeNumber(this.strengthInternal.min, `UIBehaviorTorqueNoise.strength.min`);
    assertValidNonNegativeNumber(this.strengthInternal.max, `UIBehaviorTorqueNoise.strength.max`);
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

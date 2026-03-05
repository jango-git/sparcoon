import { MathUtils, type InstancedBufferAttribute } from "three";
import { assertValidNonNegativeNumber, assertValidPositiveNumber } from "../miscellaneous/asserts";
import {
  BUILTIN_OFFSET_POSITION_X,
  BUILTIN_OFFSET_POSITION_Y,
  BUILTIN_OFFSET_POSITION_Z,
  BUILTIN_OFFSET_RANDOM_A,
  BUILTIN_OFFSET_RANDOM_C,
  BUILTIN_OFFSET_VELOCITY_X,
  BUILTIN_OFFSET_VELOCITY_Y,
  BUILTIN_OFFSET_VELOCITY_Z,
  generateNoise3D,
  resolveFXRangeConfig,
  type FXRange,
  type FXRangeConfig,
} from "../miscellaneous/miscellaneous";
import { FXBehaviorModule } from "./FXBehaviorModule";

/**
 * Applies noise-based acceleration to particles.
 *
 * Uses 2D noise based on particle position. Higher scale means finer noise detail.
 */
export class FXBehaviorVelocityNoise extends FXBehaviorModule<{ builtin: "Matrix4" }> {
  /** @internal */
  public readonly requiredProperties = { builtin: "Matrix4" } as const;
  private scaleInternal: FXRange;
  private strengthInternal: FXRange;

  /**
   * @param scale - Noise frequency range. Accepts number, tuple, or range object
   * @param strength - Force multiplier range. Accepts number, tuple, or range object
   */
  constructor(scale = 100, strength = 500) {
    super();
    this.scaleInternal = resolveFXRangeConfig(scale);
    assertValidPositiveNumber(
      this.scaleInternal.min,
      `UIBehaviorVelocityNoise.constructor.scale.min`,
    );
    assertValidPositiveNumber(
      this.scaleInternal.max,
      `UIBehaviorVelocityNoise.constructor.scale.max`,
    );

    this.strengthInternal = resolveFXRangeConfig(strength);
    assertValidNonNegativeNumber(
      this.strengthInternal.min,
      `UIBehaviorVelocityNoise.constructor.strength.min`,
    );
    assertValidNonNegativeNumber(
      this.strengthInternal.max,
      `UIBehaviorVelocityNoise.constructor.strength.max`,
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
    assertValidPositiveNumber(this.scaleInternal.min, `UIBehaviorVelocityNoise.scale.min`);
    assertValidPositiveNumber(this.scaleInternal.max, `UIBehaviorVelocityNoise.scale.max`);
  }

  /** Force multiplier range */
  public set strength(value: FXRangeConfig) {
    this.strengthInternal = resolveFXRangeConfig(value);
    assertValidNonNegativeNumber(this.strengthInternal.min, `UIBehaviorVelocityNoise.strength.min`);
    assertValidNonNegativeNumber(this.strengthInternal.max, `UIBehaviorVelocityNoise.strength.max`);
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

      const x = array[itemOffset + BUILTIN_OFFSET_POSITION_X];
      const y = array[itemOffset + BUILTIN_OFFSET_POSITION_Y];
      const z = array[itemOffset + BUILTIN_OFFSET_POSITION_Z];

      // Constant over the life of a particle but different for each particle
      const scaleT = array[itemOffset + BUILTIN_OFFSET_RANDOM_C];
      const scale = MathUtils.lerp(this.scaleInternal.min, this.scaleInternal.max, scaleT);

      const noiseX = generateNoise3D(x * scale, y * scale, z * scale);
      const noiseY = generateNoise3D((x + 100) * scale, (y + 100) * scale, (z + 100) * scale);
      const noiseZ = generateNoise3D((x - 200) * scale, (y - 200) * scale, (z - 200) * scale);

      // Constant over the life of a particle but different for each particle
      const strengthT = array[itemOffset + BUILTIN_OFFSET_RANDOM_A];
      const strength = MathUtils.lerp(
        this.strengthInternal.min,
        this.strengthInternal.max,
        strengthT,
      );

      array[itemOffset + BUILTIN_OFFSET_VELOCITY_X] += noiseX * strength * deltaTime;
      array[itemOffset + BUILTIN_OFFSET_VELOCITY_Y] += noiseY * strength * deltaTime;
      array[itemOffset + BUILTIN_OFFSET_VELOCITY_Z] += noiseZ * strength * deltaTime;
    }

    builtin.needsUpdate = true;
  }
}

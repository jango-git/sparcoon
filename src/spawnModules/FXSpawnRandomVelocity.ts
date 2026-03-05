import type { InstancedBufferAttribute } from "three";
import { MathUtils } from "three";
import { assertValidNumber } from "../miscellaneous/asserts";
import {
  BUILTIN_OFFSET_VELOCITY_X,
  BUILTIN_OFFSET_VELOCITY_Y,
  resolveFXRangeConfig,
  type FXRange,
  type FXRangeConfig,
} from "../miscellaneous/miscellaneous";
import { FXSpawnModule } from "./FXSpawnModule";

/**
 * Assigns random velocity to particles.
 *
 * Direction and magnitude are chosen independently from their respective ranges.
 */
export class FXSpawnRandomVelocity extends FXSpawnModule<{ builtin: "Matrix4" }> {
  /** @internal */
  public readonly requiredProperties = { builtin: "Matrix4" } as const;
  private angleInternal: FXRange;
  private magnitudeInternal: FXRange;

  /**
   * @param angle - Direction range in radians. Accepts number, tuple, or range object
   * @param magnitude - Speed range in units/second. Accepts number, tuple, or range object
   */
  constructor(
    angle: FXRangeConfig = { min: -Math.PI, max: Math.PI },
    magnitude: FXRangeConfig = { min: -50, max: 50 },
  ) {
    super();
    this.angleInternal = resolveFXRangeConfig(angle);
    this.magnitudeInternal = resolveFXRangeConfig(magnitude);
    assertValidNumber(this.angleInternal.min, "UISpawnRandomVelocity.constructor.angle.min");
    assertValidNumber(this.angleInternal.max, "UISpawnRandomVelocity.constructor.angle.max");
    assertValidNumber(
      this.magnitudeInternal.min,
      "UISpawnRandomVelocity.constructor.magnitude.min",
    );
    assertValidNumber(
      this.magnitudeInternal.max,
      "UISpawnRandomVelocity.constructor.magnitude.max",
    );
  }

  /** Direction range in radians */
  public get angle(): FXRange {
    return this.angleInternal;
  }

  /** Speed range in units/second */
  public get magnitude(): FXRange {
    return this.magnitudeInternal;
  }

  /** Direction range in radians */
  public set angle(value: FXRangeConfig) {
    this.angleInternal = resolveFXRangeConfig(value);
    assertValidNumber(this.angleInternal.min, "UISpawnRandomVelocity.angle.min");
    assertValidNumber(this.angleInternal.max, "UISpawnRandomVelocity.angle.max");
  }

  /** Speed range in units/second */
  public set magnitude(value: FXRangeConfig) {
    this.magnitudeInternal = resolveFXRangeConfig(value);
    assertValidNumber(this.magnitudeInternal.min, "UISpawnRandomVelocity.magnitude.min");
    assertValidNumber(this.magnitudeInternal.max, "UISpawnRandomVelocity.magnitude.max");
  }

  /** @internal */
  public spawn(
    properties: { builtin: InstancedBufferAttribute },
    instanceBegin: number,
    instanceEnd: number,
  ): void {
    const { builtin } = properties;
    const { array, itemSize } = builtin;
    const { min: angleMin, max: angleMax } = this.angleInternal;
    const { min: magnitudeMin, max: magnitudeMax } = this.magnitudeInternal;

    for (let i = instanceBegin; i < instanceEnd; i++) {
      const itemOffset = i * itemSize;
      const angle = MathUtils.randFloat(angleMin, angleMax);
      const magnitude = MathUtils.randFloat(magnitudeMin, magnitudeMax);
      array[itemOffset + BUILTIN_OFFSET_VELOCITY_X] = Math.cos(angle) * magnitude;
      array[itemOffset + BUILTIN_OFFSET_VELOCITY_Y] = Math.sin(angle) * magnitude;
    }

    builtin.needsUpdate = true;
  }
}

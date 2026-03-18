import type { InstancedBufferAttribute } from "three";
import { MathUtils } from "three";
import { assertValidNumber } from "../../miscellaneous/asserts";
import {
  BUILTIN_OFFSET_TORQUE,
  resolveFXRangeConfig,
  type FXRange,
  type FXRangeConfig,
} from "../../miscellaneous/miscellaneous";
import { FXSpawnModule } from "./FXSpawnModule";

/**
 * Assigns random angular velocity to particles.
 *
 * Torque (rotation speed) is chosen uniformly from the specified range.
 */
export class FXSpawnRandomTorque extends FXSpawnModule<{
  builtin: "Matrix4";
}> {
  /** @internal */
  public readonly requiredProperties = { builtin: "Matrix4" } as const;
  private torqueInternal: FXRange;

  /**
   * @param torque - Angular velocity range in radians/second. Accepts number, tuple, or range object
   */
  constructor(torque: FXRangeConfig = { min: -Math.PI, max: Math.PI }) {
    super();
    this.torqueInternal = resolveFXRangeConfig(torque);
    assertValidNumber(this.torqueInternal.min, "FXSpawnRandomTorque.constructor.torque.min");
    assertValidNumber(this.torqueInternal.max, "FXSpawnRandomTorque.constructor.torque.max");
  }

  /** Angular velocity range in radians/second */
  public get torque(): FXRange {
    return this.torqueInternal;
  }

  /** Angular velocity range in radians/second */
  public set torque(value: FXRangeConfig) {
    this.torqueInternal = resolveFXRangeConfig(value);
    assertValidNumber(this.torqueInternal.min, "FXSpawnRandomTorque.torque.min");
    assertValidNumber(this.torqueInternal.max, "FXSpawnRandomTorque.torque.max");
  }

  /** @internal */
  public spawn(
    properties: { builtin: InstancedBufferAttribute },
    instanceBegin: number,
    instanceEnd: number,
  ): void {
    const { builtin } = properties;
    const { array, itemSize } = builtin;
    const { min: torqueMin, max: torqueMax } = this.torqueInternal;

    for (let i = instanceBegin; i < instanceEnd; i++) {
      array[i * itemSize + BUILTIN_OFFSET_TORQUE] = MathUtils.randFloat(torqueMin, torqueMax);
    }

    builtin.needsUpdate = true;
  }
}

import type { InstancedBufferAttribute } from "three";
import { MathUtils } from "three";
import { assertValidNumber } from "../../miscellaneous/asserts";
import type { FXRange, FXRangeConfig } from "../../miscellaneous/miscellaneous";
import { BUILTIN_OFFSET_TORQUE, resolveFXRangeConfig } from "../../miscellaneous/miscellaneous";
import { FXSpawn } from "./FXSpawn";

/**
 * Assigns a random initial angular velocity to each spawned particle
 */
export class FXSpawnTorque extends FXSpawn<{
  builtin: "Matrix4";
}> {
  /** @internal */
  public readonly requiredProperties = { builtin: "Matrix4" } as const;
  private torqueInternal: FXRange;

  /**
   * @param torque - Angular velocity range in radians/second. Defaults to `{ min: -Math.PI, max: Math.PI }`
   */
  constructor(torque: FXRangeConfig = { min: -Math.PI, max: Math.PI }) {
    super();
    this.torqueInternal = resolveFXRangeConfig(torque);
    assertValidNumber(this.torqueInternal.min, "FXSpawnTorque.constructor.torque.min");
    assertValidNumber(this.torqueInternal.max, "FXSpawnTorque.constructor.torque.max");
  }

  /** Angular velocity range in radians/second */
  public get torque(): FXRange {
    return this.torqueInternal;
  }

  /** Angular velocity range in radians/second */
  public set torque(value: FXRangeConfig) {
    this.torqueInternal = resolveFXRangeConfig(value);
    assertValidNumber(this.torqueInternal.min, "FXSpawnTorque.torque.min");
    assertValidNumber(this.torqueInternal.max, "FXSpawnTorque.torque.max");
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

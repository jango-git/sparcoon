import type { InstancedBufferAttribute } from "three";
import { MathUtils } from "three";
import { assertValidNumber } from "../../miscellaneous/asserts";
import type { FXRange, FXRangeConfig } from "../../miscellaneous/miscellaneous";
import { BUILTIN_OFFSET_ROTATION, resolveFXRangeConfig } from "../../miscellaneous/miscellaneous";
import { FXSpawn } from "./FXSpawn";

/**
 * Assigns a random initial rotation to each spawned particle
 */
export class FXSpawnRotation extends FXSpawn<{ builtin: "Matrix4" }> {
  /** @internal */
  public requiredProperties = { builtin: "Matrix4" } as const;
  private rotationInternal: FXRange;

  /**
   * @param rotation - Rotation range in radians. Defaults to `{ min: -Math.PI, max: Math.PI }`
   */
  constructor(rotation: FXRangeConfig = { min: -Math.PI, max: Math.PI }) {
    super();
    this.rotationInternal = resolveFXRangeConfig(rotation);
    assertValidNumber(this.rotationInternal.min, "FXSpawnRotation.constructor.rotation.min");
    assertValidNumber(this.rotationInternal.max, "FXSpawnRotation.constructor.rotation.max");
  }

  /** Rotation range in radians */
  public get rotation(): FXRange {
    return this.rotationInternal;
  }

  /** Rotation range in radians */
  public set rotation(value: FXRangeConfig) {
    this.rotationInternal = resolveFXRangeConfig(value);
    assertValidNumber(this.rotationInternal.min, "FXSpawnRotation.rotation.min");
    assertValidNumber(this.rotationInternal.max, "FXSpawnRotation.rotation.max");
  }

  /** @internal */
  public spawn(
    properties: { builtin: InstancedBufferAttribute },
    instanceBegin: number,
    instanceEnd: number,
  ): void {
    const { builtin } = properties;
    const { array, itemSize } = builtin;
    const { min: rotationMin, max: rotationMax } = this.rotationInternal;

    for (let i = instanceBegin; i < instanceEnd; i++) {
      array[i * itemSize + BUILTIN_OFFSET_ROTATION] = MathUtils.randFloat(rotationMin, rotationMax);
    }

    builtin.needsUpdate = true;
  }
}

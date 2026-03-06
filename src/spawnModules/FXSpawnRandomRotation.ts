import type { InstancedBufferAttribute } from "three";
import { MathUtils } from "three";
import { assertValidNumber } from "../miscellaneous/asserts";
import {
  BUILTIN_OFFSET_ROTATION,
  resolveFXRangeConfig,
  type FXRange,
  type FXRangeConfig,
} from "../miscellaneous/miscellaneous";
import { FXSpawnModule } from "./FXSpawnModule";

/**
 * Assigns random rotation to particles.
 *
 * Initial rotation is chosen uniformly from the specified range.
 */
export class FXSpawnRandomRotation extends FXSpawnModule<{ builtin: "Matrix4" }> {
  /** @internal */
  public requiredProperties = { builtin: "Matrix4" } as const;
  private rotationInternal: FXRange;

  /**
   * @param rotation - Rotation range in radians. Accepts number, tuple, or range object
   */
  constructor(rotation: FXRangeConfig = { min: -Math.PI, max: Math.PI }) {
    super();
    this.rotationInternal = resolveFXRangeConfig(rotation);
    assertValidNumber(this.rotationInternal.min, "FXSpawnRandomRotation.constructor.rotation.min");
    assertValidNumber(this.rotationInternal.max, "FXSpawnRandomRotation.constructor.rotation.max");
  }

  /** Rotation range in radians */
  public get rotation(): FXRange {
    return this.rotationInternal;
  }

  /** Rotation range in radians */
  public set rotation(value: FXRangeConfig) {
    this.rotationInternal = resolveFXRangeConfig(value);
    assertValidNumber(this.rotationInternal.min, "FXSpawnRandomRotation.rotation.min");
    assertValidNumber(this.rotationInternal.max, "FXSpawnRandomRotation.rotation.max");
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

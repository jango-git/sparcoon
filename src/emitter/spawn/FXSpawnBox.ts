import type { InstancedBufferAttribute } from "three";
import { MathUtils } from "three";
import { assertValidNumber } from "../../miscellaneous/asserts";
import type { Vector3Like } from "../../miscellaneous/math";
import {
  BUILTIN_OFFSET_POSITION_X,
  BUILTIN_OFFSET_POSITION_Y,
  BUILTIN_OFFSET_POSITION_Z,
  resolveFXVector3Config,
  type FXVector3Config,
} from "../../miscellaneous/miscellaneous";
import { FXSpawnModule } from "./FXSpawnModule";

/**
 * Spawns particles at random positions within an axis-aligned bounding box.
 *
 * Position is chosen uniformly within the bounds defined by min and max.
 */
export class FXSpawnBox extends FXSpawnModule<{ builtin: "Matrix4" }> {
  /** @internal */
  public readonly requiredProperties = { builtin: "Matrix4" } as const;
  private minInternal: Vector3Like;
  private maxInternal: Vector3Like;

  /**
   * @param min - Minimum corner of the spawn box
   * @param max - Maximum corner of the spawn box
   */
  constructor(
    min: FXVector3Config = { x: -1, y: -1, z: -1 },
    max: FXVector3Config = { x: 1, y: 1, z: 1 },
  ) {
    super();
    this.minInternal = resolveFXVector3Config(min);
    this.maxInternal = resolveFXVector3Config(max);
    assertValidNumber(this.minInternal.x, "FXSpawnBox.constructor.min.x");
    assertValidNumber(this.minInternal.y, "FXSpawnBox.constructor.min.y");
    assertValidNumber(this.minInternal.z, "FXSpawnBox.constructor.min.z");
    assertValidNumber(this.maxInternal.x, "FXSpawnBox.constructor.max.x");
    assertValidNumber(this.maxInternal.y, "FXSpawnBox.constructor.max.y");
    assertValidNumber(this.maxInternal.z, "FXSpawnBox.constructor.max.z");
  }

  /** Minimum corner of the spawn box */
  public get min(): Vector3Like {
    return this.minInternal;
  }

  /** Maximum corner of the spawn box */
  public get max(): Vector3Like {
    return this.maxInternal;
  }

  /** Minimum corner of the spawn box */
  public set min(value: FXVector3Config) {
    this.minInternal = resolveFXVector3Config(value);
    assertValidNumber(this.minInternal.x, "FXSpawnBox.min.x");
    assertValidNumber(this.minInternal.y, "FXSpawnBox.min.y");
    assertValidNumber(this.minInternal.z, "FXSpawnBox.min.z");
  }

  /** Maximum corner of the spawn box */
  public set max(value: FXVector3Config) {
    this.maxInternal = resolveFXVector3Config(value);
    assertValidNumber(this.maxInternal.x, "FXSpawnBox.max.x");
    assertValidNumber(this.maxInternal.y, "FXSpawnBox.max.y");
    assertValidNumber(this.maxInternal.z, "FXSpawnBox.max.z");
  }

  /** @internal */
  public spawn(
    properties: { builtin: InstancedBufferAttribute },
    instanceBegin: number,
    instanceEnd: number,
  ): void {
    const { builtin } = properties;
    const { array, itemSize } = builtin;
    const { x: minX, y: minY, z: minZ } = this.minInternal;
    const { x: maxX, y: maxY, z: maxZ } = this.maxInternal;

    for (let i = instanceBegin; i < instanceEnd; i++) {
      const itemOffset = i * itemSize;
      array[itemOffset + BUILTIN_OFFSET_POSITION_X] = MathUtils.randFloat(minX, maxX);
      array[itemOffset + BUILTIN_OFFSET_POSITION_Y] = MathUtils.randFloat(minY, maxY);
      array[itemOffset + BUILTIN_OFFSET_POSITION_Z] = MathUtils.randFloat(minZ, maxZ);
    }

    builtin.needsUpdate = true;
  }
}

import type { InstancedBufferAttribute } from "three";
import { MathUtils } from "three";
import { assertValidNumber } from "../../miscellaneous/asserts";
import type { Vector3Like } from "../../miscellaneous/math";
import type { FXVector3Config } from "../../miscellaneous/miscellaneous";
import {
  BUILTIN_OFFSET_POSITION_X,
  BUILTIN_OFFSET_POSITION_Y,
  BUILTIN_OFFSET_POSITION_Z,
  resolveFXVector3Config,
} from "../../miscellaneous/miscellaneous";
import { FXSpawn } from "./FXSpawn";

/**
 * Spawns particles at random positions within an axis-aligned bounding box centered at the origin
 */
export class FXSpawnBox extends FXSpawn<{ builtin: "Matrix4" }> {
  /** @internal */
  public readonly requiredProperties = { builtin: "Matrix4" } as const;
  private sizeInternal: Vector3Like;

  /**
   * @param size - Dimensions of the spawn box. Defaults to `{ x: 1, y: 1, z: 1 }`
   */
  constructor(size: FXVector3Config = { x: 1, y: 1, z: 1 }) {
    super();
    this.sizeInternal = resolveFXVector3Config(size);
    assertValidNumber(this.sizeInternal.x, "FXSpawnBox.constructor.size.x");
    assertValidNumber(this.sizeInternal.y, "FXSpawnBox.constructor.size.y");
    assertValidNumber(this.sizeInternal.z, "FXSpawnBox.constructor.size.z");
  }

  /** Size of the spawn box */
  public get size(): Vector3Like {
    return this.sizeInternal;
  }

  /** Size of the spawn box */
  public set size(value: FXVector3Config) {
    this.sizeInternal = resolveFXVector3Config(value);
    assertValidNumber(this.sizeInternal.x, "FXSpawnBox.size.x");
    assertValidNumber(this.sizeInternal.y, "FXSpawnBox.size.y");
    assertValidNumber(this.sizeInternal.z, "FXSpawnBox.size.z");
  }

  /** @internal */
  public spawn(
    properties: { builtin: InstancedBufferAttribute },
    instanceBegin: number,
    instanceEnd: number,
  ): void {
    const { builtin } = properties;
    const { array, itemSize } = builtin;
    const { x: sizeX, y: sizeY, z: sizeZ } = this.sizeInternal;
    const halfX = sizeX * 0.5;
    const halfY = sizeY * 0.5;
    const halfZ = sizeZ * 0.5;

    for (let i = instanceBegin; i < instanceEnd; i++) {
      const itemOffset = i * itemSize;
      array[itemOffset + BUILTIN_OFFSET_POSITION_X] = MathUtils.randFloat(-halfX, halfX);
      array[itemOffset + BUILTIN_OFFSET_POSITION_Y] = MathUtils.randFloat(-halfY, halfY);
      array[itemOffset + BUILTIN_OFFSET_POSITION_Z] = MathUtils.randFloat(-halfZ, halfZ);
    }

    builtin.needsUpdate = true;
  }
}

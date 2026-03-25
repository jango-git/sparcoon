import type { InstancedBufferAttribute } from "three";
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
 * Shifts particle spawn positions by a fixed offset
 *
 * @remarks
 * Adds to the position set by any preceding spawn step rather than overwriting it.
 */
export class FXSpawnOffset extends FXSpawn<{ builtin: "Matrix4" }> {
  /** @internal */
  public readonly requiredProperties = { builtin: "Matrix4" } as const;
  private offsetInternal: Vector3Like;

  /**
   * @param offset - Position offset applied to each spawned particle. Defaults to `{ x: 0, y: 0, z: 0 }`
   */
  constructor(offset: FXVector3Config = { x: 0, y: 0, z: 0 }) {
    super();
    this.offsetInternal = resolveFXVector3Config(offset);
    assertValidNumber(this.offsetInternal.x, "FXSpawnOffset.constructor.offset.x");
    assertValidNumber(this.offsetInternal.y, "FXSpawnOffset.constructor.offset.y");
    assertValidNumber(this.offsetInternal.z, "FXSpawnOffset.constructor.offset.z");
  }

  /** Particle position offset */
  public get offset(): Vector3Like {
    return this.offsetInternal;
  }

  public set offset(value: FXVector3Config) {
    this.offsetInternal = resolveFXVector3Config(value);
    assertValidNumber(this.offsetInternal.x, "FXSpawnOffset.offset.x");
    assertValidNumber(this.offsetInternal.y, "FXSpawnOffset.offset.y");
    assertValidNumber(this.offsetInternal.z, "FXSpawnOffset.offset.z");
  }

  /** @internal */
  public spawn(
    properties: { builtin: InstancedBufferAttribute },
    instanceBegin: number,
    instanceEnd: number,
  ): void {
    const { builtin } = properties;
    const { array, itemSize } = builtin;
    const { x: offsetX, y: offsetY, z: offsetZ } = this.offsetInternal;

    for (let i = instanceBegin; i < instanceEnd; i++) {
      const itemOffset = i * itemSize;
      array[itemOffset + BUILTIN_OFFSET_POSITION_X] += offsetX;
      array[itemOffset + BUILTIN_OFFSET_POSITION_Y] += offsetY;
      array[itemOffset + BUILTIN_OFFSET_POSITION_Z] += offsetZ;
    }

    builtin.needsUpdate = true;
  }
}

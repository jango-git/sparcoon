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

export class FXSpawnPoint extends FXSpawn<{ builtin: "Matrix4" }> {
  /** @internal */
  public readonly requiredProperties = { builtin: "Matrix4" } as const;
  private positionInternal: Vector3Like;

  constructor(position: FXVector3Config = { x: 0, y: 0, z: 0 }) {
    super();
    this.positionInternal = resolveFXVector3Config(position);
    assertValidNumber(this.positionInternal.x, "FXSpawnPoint.constructor.position.x");
    assertValidNumber(this.positionInternal.y, "FXSpawnPoint.constructor.position.y");
    assertValidNumber(this.positionInternal.z, "FXSpawnPoint.constructor.position.z");
  }

  public get position(): Vector3Like {
    return this.positionInternal;
  }

  public set position(value: FXVector3Config) {
    this.positionInternal = resolveFXVector3Config(value);
    assertValidNumber(this.positionInternal.x, "FXSpawnPoint.position.x");
    assertValidNumber(this.positionInternal.y, "FXSpawnPoint.position.y");
    assertValidNumber(this.positionInternal.z, "FXSpawnPoint.position.z");
  }

  /** @internal */
  public spawn(
    properties: { builtin: InstancedBufferAttribute },
    instanceBegin: number,
    instanceEnd: number,
  ): void {
    const { builtin } = properties;
    const { array, itemSize } = builtin;
    const { x: positionX, y: positionY, z: positionZ } = this.positionInternal;

    for (let i = instanceBegin; i < instanceEnd; i++) {
      const itemOffset = i * itemSize;
      array[itemOffset + BUILTIN_OFFSET_POSITION_X] = positionX;
      array[itemOffset + BUILTIN_OFFSET_POSITION_Y] = positionY;
      array[itemOffset + BUILTIN_OFFSET_POSITION_Z] = positionZ;
    }

    builtin.needsUpdate = true;
  }
}

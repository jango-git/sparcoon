import type { InstancedBufferAttribute } from "three";
import { assertValidNumber } from "../miscellaneous/asserts";
import type { Vector3Like } from "../miscellaneous/math";
import type { FXVector3Config } from "../miscellaneous/miscellaneous";
import {
  BUILTIN_OFFSET_POSITION_X,
  BUILTIN_OFFSET_POSITION_Y,
  BUILTIN_OFFSET_POSITION_Z,
  resolveFXVector2Config,
} from "../miscellaneous/miscellaneous";
import { FXSpawnModule } from "./FXSpawnModule";

/**
 * Sets particle spawn position offset.
 *
 * All particles spawned with this module start at the specified position.
 */
export class FXSpawnOffset extends FXSpawnModule<{ builtin: "Matrix4" }> {
  /** @internal */
  public readonly requiredProperties = { builtin: "Matrix4" } as const;
  private offsetInternal: Vector3Like;

  /**
   * @param offset - Initial particle position offset
   */
  constructor(offset: FXVector3Config = { x: 0, y: 0, z: 0 }) {
    super();
    this.offsetInternal = resolveFXVector2Config(offset);
    assertValidNumber(this.offsetInternal.x, "UISpawnOffset.constructor.offset.x");
    assertValidNumber(this.offsetInternal.y, "UISpawnOffset.constructor.offset.y");
    assertValidNumber(this.offsetInternal.z, "UISpawnOffset.constructor.offset.z");
  }

  /** Particle position offset */
  public get offset(): Vector3Like {
    return this.offsetInternal;
  }

  /** Particle position offset */
  public set offset(value: FXVector3Config) {
    this.offsetInternal = resolveFXVector2Config(value);
    assertValidNumber(this.offsetInternal.x, "UISpawnOffset.offset.x");
    assertValidNumber(this.offsetInternal.y, "UISpawnOffset.offset.y");
    assertValidNumber(this.offsetInternal.z, "UISpawnOffset.offset.z");
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
      array[itemOffset + BUILTIN_OFFSET_POSITION_X] = offsetX;
      array[itemOffset + BUILTIN_OFFSET_POSITION_Y] = offsetY;
      array[itemOffset + BUILTIN_OFFSET_POSITION_Z] = offsetZ;
    }

    builtin.needsUpdate = true;
  }
}

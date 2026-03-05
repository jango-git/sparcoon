import type { InstancedBufferAttribute } from "three";
import { MathUtils } from "three";
import { assertValidNumber } from "../miscellaneous/asserts";
import type { Vector3Like } from "../miscellaneous/math";
import {
  BUILTIN_OFFSET_POSITION_X,
  BUILTIN_OFFSET_POSITION_Y,
  BUILTIN_OFFSET_POSITION_Z,
  resolveFXVector2Config,
  type FXVector3Config,
} from "../miscellaneous/miscellaneous";
import { FXSpawnModule } from "./FXSpawnModule";

/**
 * Spawns particles at random positions within a rectangle.
 *
 * Position is chosen uniformly within the bounds defined by min and max.
 */
export class FXSpawnBox extends FXSpawnModule<{ builtin: "Matrix4" }> {
  /** @internal */
  public readonly requiredProperties = { builtin: "Matrix4" } as const;
  private minInternal: Vector3Like;
  private maxInternal: Vector3Like;

  /**
   * @param min - Bottom-left corner of spawn area
   * @param max - Top-right corner of spawn area
   */
  constructor(
    min: FXVector3Config = { x: -1, y: -1, z: -1 },
    max: FXVector3Config = { x: 1, y: 1, z: 1 },
  ) {
    super();
    this.minInternal = resolveFXVector2Config(min);
    this.maxInternal = resolveFXVector2Config(max);
    assertValidNumber(this.minInternal.x, "UISpawnRectangle.constructor.min.x");
    assertValidNumber(this.minInternal.y, "UISpawnRectangle.constructor.min.y");
    assertValidNumber(this.minInternal.z, "UISpawnRectangle.constructor.min.z");
    assertValidNumber(this.maxInternal.x, "UISpawnRectangle.constructor.max.x");
    assertValidNumber(this.maxInternal.y, "UISpawnRectangle.constructor.max.y");
    assertValidNumber(this.maxInternal.z, "UISpawnRectangle.constructor.max.z");
  }

  /** Bottom-left corner of spawn area */
  public get min(): Vector3Like {
    return this.minInternal;
  }

  /** Top-right corner of spawn area */
  public get max(): Vector3Like {
    return this.maxInternal;
  }

  /** Bottom-left corner of spawn area */
  public set min(value: FXVector3Config) {
    this.minInternal = resolveFXVector2Config(value);
    assertValidNumber(this.minInternal.x, "UISpawnRectangle.min.x");
    assertValidNumber(this.minInternal.y, "UISpawnRectangle.min.y");
    assertValidNumber(this.minInternal.z, "UISpawnRectangle.min.z");
  }

  /** Top-right corner of spawn area */
  public set max(value: FXVector3Config) {
    this.maxInternal = resolveFXVector2Config(value);
    assertValidNumber(this.maxInternal.x, "UISpawnRectangle.max.x");
    assertValidNumber(this.maxInternal.y, "UISpawnRectangle.max.y");
    assertValidNumber(this.maxInternal.z, "UISpawnRectangle.max.z");
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

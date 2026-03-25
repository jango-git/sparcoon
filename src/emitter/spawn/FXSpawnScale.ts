import type { InstancedBufferAttribute } from "three";
import { MathUtils } from "three";
import { assertValidPositiveNumber } from "../../miscellaneous/asserts";
import type { FXAspectConfig, FXRange, FXRangeConfig } from "../../miscellaneous/miscellaneous";
import {
  BUILTIN_OFFSET_SCALE_X,
  BUILTIN_OFFSET_SCALE_Y,
  resolveAspect,
  resolveFXRangeConfig,
} from "../../miscellaneous/miscellaneous";
import { FXSpawn } from "./FXSpawn";

/**
 * Assigns a random initial scale to each spawned particle
 */
export class FXSpawnScale extends FXSpawn<{ builtin: "Matrix4" }> {
  /** @internal */
  public requiredProperties = { builtin: "Matrix4" } as const;
  private scaleInternal: FXRange;
  private aspectInternal: number;

  /**
   * @param scale - Base scale range; must be positive. Defaults to `{ min: 1, max: 2 }`
   * @param aspect - Width/height ratio; must be positive. Defaults to `1`
   */
  constructor(scale: FXRangeConfig = { min: 1, max: 2 }, aspect: FXAspectConfig = 1) {
    super();
    this.scaleInternal = resolveFXRangeConfig(scale);
    this.aspectInternal = resolveAspect(aspect);
    assertValidPositiveNumber(this.scaleInternal.min, "FXSpawnScale.constructor.scale.min");
    assertValidPositiveNumber(this.scaleInternal.max, "FXSpawnScale.constructor.scale.max");
    assertValidPositiveNumber(this.aspectInternal, "FXSpawnScale.constructor.aspect");
  }

  /** Base scale range */
  public get scale(): FXRange {
    return this.scaleInternal;
  }

  /** Width/height aspect ratio */
  public get aspect(): number {
    return this.aspectInternal;
  }

  public set scale(value: FXRangeConfig) {
    this.scaleInternal = resolveFXRangeConfig(value);
    assertValidPositiveNumber(this.scaleInternal.min, "FXSpawnScale.scale.min");
    assertValidPositiveNumber(this.scaleInternal.max, "FXSpawnScale.scale.max");
  }

  public set aspect(value: FXAspectConfig) {
    this.aspectInternal = resolveAspect(value);
    assertValidPositiveNumber(this.aspectInternal, "FXSpawnScale.aspect");
  }

  /** @internal */
  public spawn(
    properties: { builtin: InstancedBufferAttribute },
    instanceBegin: number,
    instanceEnd: number,
  ): void {
    const { builtin } = properties;
    const { array, itemSize } = builtin;
    const { min: scaleMin, max: scaleMax } = this.scaleInternal;

    for (let i = instanceBegin; i < instanceEnd; i++) {
      const itemOffset = i * itemSize;
      const randomScale = MathUtils.randFloat(scaleMin, scaleMax);
      array[itemOffset + BUILTIN_OFFSET_SCALE_X] = randomScale * this.aspectInternal;
      array[itemOffset + BUILTIN_OFFSET_SCALE_Y] = randomScale;
    }

    builtin.needsUpdate = true;
  }
}

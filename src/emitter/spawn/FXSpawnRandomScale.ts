import type { InstancedBufferAttribute } from "three";
import { MathUtils } from "three";
import { assertValidPositiveNumber } from "../../miscellaneous/asserts";
import {
  BUILTIN_OFFSET_SCALE_X,
  BUILTIN_OFFSET_SCALE_Y,
  resolveAspect,
  resolveFXRangeConfig,
  type FXAspectConfig,
  type FXRange,
  type FXRangeConfig,
} from "../../miscellaneous/miscellaneous";
import { FXSpawnModule } from "./FXSpawnModule";

/**
 * Assigns random scale to particles.
 *
 * Base scale is chosen uniformly from the range. Aspect ratio is applied to X scale.
 */
export class FXSpawnRandomScale extends FXSpawnModule<{ builtin: "Matrix4" }> {
  /** @internal */
  public requiredProperties = { builtin: "Matrix4" } as const;
  private scaleInternal: FXRange;
  private aspectInternal: number;

  /**
   * @param scale - Base scale range. Accepts number, tuple, or range object
   * @param aspect - Width/height ratio. Accepts number or texture
   */
  constructor(scale: FXRangeConfig = { min: 50, max: 100 }, aspect: FXAspectConfig = 1) {
    super();
    this.scaleInternal = resolveFXRangeConfig(scale);
    this.aspectInternal = resolveAspect(aspect);
    assertValidPositiveNumber(this.scaleInternal.min, "FXSpawnRandomScale.constructor.scale.min");
    assertValidPositiveNumber(this.scaleInternal.max, "FXSpawnRandomScale.constructor.scale.max");
    assertValidPositiveNumber(this.aspectInternal, "FXSpawnRandomScale.constructor.aspect");
  }

  /** Base scale range */
  public get scale(): FXRange {
    return this.scaleInternal;
  }

  /** Width/height aspect ratio */
  public get aspect(): number {
    return this.aspectInternal;
  }

  /** Base scale range */
  public set scale(value: FXRangeConfig) {
    this.scaleInternal = resolveFXRangeConfig(value);
    assertValidPositiveNumber(this.scaleInternal.min, "FXSpawnRandomScale.scale.min");
    assertValidPositiveNumber(this.scaleInternal.max, "FXSpawnRandomScale.scale.max");
  }

  /** Width/height aspect ratio */
  public set aspect(value: FXAspectConfig) {
    this.aspectInternal = resolveAspect(value);
    assertValidPositiveNumber(this.aspectInternal, "FXSpawnRandomScale.aspect");
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

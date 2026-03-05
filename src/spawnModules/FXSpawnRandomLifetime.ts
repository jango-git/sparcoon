import type { InstancedBufferAttribute } from "three";
import { MathUtils } from "three";
import { assertValidPositiveNumber } from "../miscellaneous/asserts";
import type { FXRange, FXRangeConfig } from "../miscellaneous/miscellaneous";
import {
  BUILTIN_OFFSET_AGE,
  BUILTIN_OFFSET_LIFETIME,
  resolveFXRangeConfig,
} from "../miscellaneous/miscellaneous";
import { FXSpawnModule } from "./FXSpawnModule";

/**
 * Assigns random lifetime to particles.
 *
 * Lifetime is chosen uniformly from the specified range. Age is set to 0.
 */
export class FXSpawnRandomLifetime extends FXSpawnModule<{ builtin: "Matrix4" }> {
  /** @internal */
  public readonly requiredProperties = { builtin: "Matrix4" } as const;
  private lifetimeInternal: FXRange;

  /**
   * @param lifetime - Lifetime range in seconds. Accepts number, tuple, or range object
   */
  constructor(lifetime: FXRangeConfig = { min: 4, max: 8 }) {
    super();
    this.lifetimeInternal = resolveFXRangeConfig(lifetime);
    assertValidPositiveNumber(
      this.lifetimeInternal.min,
      "UISpawnRandomLifetime.constructor.lifetime.min",
    );
    assertValidPositiveNumber(
      this.lifetimeInternal.max,
      "UISpawnRandomLifetime.constructor.lifetime.max",
    );
  }

  /** Lifetime range in seconds */
  public get lifetime(): FXRange {
    return this.lifetimeInternal;
  }

  /** Lifetime range in seconds */
  public set lifetime(value: FXRangeConfig) {
    this.lifetimeInternal = resolveFXRangeConfig(value);
    assertValidPositiveNumber(this.lifetimeInternal.min, "UISpawnRandomLifetime.lifetime.min");
    assertValidPositiveNumber(this.lifetimeInternal.max, "UISpawnRandomLifetime.lifetime.max");
  }

  /** @internal */
  public spawn(
    properties: { builtin: InstancedBufferAttribute },
    instanceBegin: number,
    instanceEnd: number,
  ): void {
    const { builtin } = properties;
    const { array, itemSize } = builtin;
    const { min: lifetimeMin, max: lifetimeMax } = this.lifetimeInternal;

    for (let i = instanceBegin; i < instanceEnd; i++) {
      const itemOffset = i * itemSize;
      array[itemOffset + BUILTIN_OFFSET_LIFETIME] = MathUtils.randFloat(lifetimeMin, lifetimeMax);
      array[itemOffset + BUILTIN_OFFSET_AGE] = 0;
    }

    builtin.needsUpdate = true;
  }
}

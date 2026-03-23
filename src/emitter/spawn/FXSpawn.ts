import type { InstancedBufferAttribute } from "three";
import type { FXPropertyName } from "../../instancedParticle/shared";

/**
 * Abstract base for particle spawn modules that initialize per-particle properties at birth
 *
 * @typeParam T - Map of local property keys to {@link FXPropertyName} identifiers,
 * declaring which particle attributes this spawn module writes
 */
export abstract class FXSpawn<
  T extends Record<string, FXPropertyName> = Record<string, FXPropertyName>,
> {
  /** @internal */
  public abstract readonly requiredProperties: T;
  /** @internal */
  public abstract spawn(
    properties: { [K in keyof T]: InstancedBufferAttribute },
    instanceBegin: number,
    instanceEnd: number,
  ): void;

  /** Releases any resources held by this spawn module */
  public destroy?(): void;
}

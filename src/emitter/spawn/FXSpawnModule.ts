import type { InstancedBufferAttribute } from "three";
import type { FXPropertyName } from "../../instancedParticle/shared";

/**
 * Base class for particle spawn modules.
 *
 * Spawn modules initialize particle properties when particles are created.
 */
export abstract class FXSpawnModule<
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

  public destroy?(): void;
}

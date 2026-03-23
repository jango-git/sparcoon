import type { InstancedBufferAttribute } from "three";
import type { FXPropertyName } from "../../instancedParticle/shared";

/**
 * Abstract base for particle behavior modules that mutate per-particle properties each frame
 *
 * @typeParam T - Map of local property keys to {@link FXPropertyName} identifiers,
 * declaring which particle attributes this behavior reads or writes
 */
export abstract class FXBehavior<
  T extends Record<string, FXPropertyName> = Record<string, FXPropertyName>,
> {
  /** Particle attributes required by this behavior */
  public abstract readonly requiredProperties: T;

  /**
   * Called once per frame to update all live particles
   *
   * @param properties - Buffer attributes keyed by `requiredProperties`
   * @param instanceCount - Number of currently live particles
   * @param deltaTime - Elapsed time since the last frame, in seconds
   */
  public abstract update(
    properties: { [K in keyof T]: InstancedBufferAttribute },
    instanceCount: number,
    deltaTime: number,
  ): void;

  /** Releases any resources held by this behavior */
  public destroy?(): void;
}

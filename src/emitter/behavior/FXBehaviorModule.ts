import type { InstancedBufferAttribute } from "three";
import type { FXPropertyName } from "../../instancedParticle/shared";

/**
 * Base class for particle behavior modules.
 *
 * Behavior modules update particle properties each frame.
 */
export abstract class FXBehaviorModule<
  T extends Record<string, FXPropertyName> = Record<string, FXPropertyName>,
> {
  public abstract readonly requiredProperties: T;
  public abstract update(
    properties: { [K in keyof T]: InstancedBufferAttribute },
    instanceCount: number,
    deltaTime: number,
  ): void;

  public destroy?(): void;
}

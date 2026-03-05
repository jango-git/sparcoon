import type { FXProperty, FXPropertyName } from "../instancedParticle/shared";

/**
 * Base class for particle rendering modules.
 *
 * Rendering modules provide fragment shader code and uniforms for particle appearance.
 */
export abstract class FXRenderingModule {
  /** @internal */
  public readonly requiredProperties?: Record<string, FXPropertyName>;
  /** @internal */
  public abstract readonly requiredUniforms: Record<string, FXProperty>;
  /** @internal */
  public abstract readonly source: string;

  public destroy?(): void;
}

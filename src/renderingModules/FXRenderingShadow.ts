import type { FXProperty, FXPropertyName } from "../instancedParticle/shared";
import source from "../shaders/FXRenderingShadow.glsl";
import { FXRenderingModule } from "./FXRenderingModule";

/**
 * Applies directional light shadow attenuation to particles.
 *
 * Samples the first directional light's shadow map per billboard fragment,
 * multiplying the particle color by the shadow factor.
 *
 * Requires a DirectionalLight with `castShadow = true` in the scene,
 * and `receiveShadow = true` on the emitter (or its parent).
 */
export class FXRenderingShadow extends FXRenderingModule {
  /** @internal */
  public override readonly requiredProperties: Record<string, FXPropertyName> = {
    builtin: "Matrix4",
  } as const;
  /** @internal */
  public readonly requiredUniforms: Record<string, FXProperty> = {};
  /** @internal */
  public readonly source = source;
}

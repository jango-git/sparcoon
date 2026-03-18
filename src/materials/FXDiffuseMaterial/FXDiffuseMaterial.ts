import { NormalBlending, type Blending, type MeshLambertMaterial } from "three";
import type { GLTypeInfo } from "../../instancedParticle/shared";
import { FXMaterial, type FXMaterialOptions } from "../FXMaterial";
import { buildFXDiffuseMaterial, FXParticleNormalsMode } from "./FXDiffuseMaterial.Internal";

export { FXParticleNormalsMode };

export interface FXDiffuseMaterialOptions extends FXMaterialOptions {
  blending: Blending;
  useAlphaHashing: boolean;
  normalsMode: FXParticleNormalsMode;
}

export class FXDiffuseMaterial extends FXMaterial {
  private readonly blending: Blending;
  private readonly useAlphaHashing: boolean;
  private readonly normalsMode: FXParticleNormalsMode;

  constructor(options: Partial<FXDiffuseMaterialOptions> = {}) {
    super(options);
    this.blending = options.blending ?? NormalBlending;
    this.useAlphaHashing = options.useAlphaHashing ?? false;
    this.normalsMode = options.normalsMode ?? FXParticleNormalsMode.SPHERICAL;
  }

  /** @internal */
  public override buildThreeMaterial(varyings: Record<string, GLTypeInfo>): MeshLambertMaterial {
    return buildFXDiffuseMaterial(
      varyings,
      this.blending,
      this.useAlphaHashing,
      this.normalsMode,
      this.colorNodes,
    );
  }
}

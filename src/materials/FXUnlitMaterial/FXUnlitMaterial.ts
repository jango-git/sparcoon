import { NormalBlending, type Blending, type MeshBasicMaterial } from "three";
import type { GLTypeInfo } from "../../instancedParticle/shared";
import { FXMaterial, type FXMaterialOptions } from "../FXMaterial";
import { buildFXUnlitMaterial } from "./FXUnlitMaterial.Internal";

export interface FXUnlitMaterialOptions extends FXMaterialOptions {
  blending: Blending;
  useAlphaHashing: boolean;
}

export class FXUnlitMaterial extends FXMaterial {
  private readonly blending: Blending;
  private readonly useAlphaHashing: boolean;

  constructor(options: Partial<FXUnlitMaterialOptions> = {}) {
    super(options);
    this.blending = options.blending ?? NormalBlending;
    this.useAlphaHashing = options.useAlphaHashing ?? false;
  }

  /** @internal */
  public override buildThreeMaterial(varyings: Record<string, GLTypeInfo>): MeshBasicMaterial {
    return buildFXUnlitMaterial(varyings, this.blending, this.useAlphaHashing, this.colorNodes);
  }
}

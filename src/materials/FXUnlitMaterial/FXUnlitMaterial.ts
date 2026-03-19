import type { MeshBasicMaterial } from "three";
import type { GLTypeInfo } from "../../instancedParticle/shared";
import type { FXMaterialOptions } from "../FXMaterial/FXMaterial";
import { FXMaterial } from "../FXMaterial/FXMaterial";
import { buildFXUnlitMaterial } from "./FXUnlitMaterial.Internal";

export type FXUnlitMaterialOptions = FXMaterialOptions;

export class FXUnlitMaterial extends FXMaterial {
  constructor(options: FXUnlitMaterialOptions = {}) {
    super(options);
  }

  /** @internal */
  public override buildThreeMaterial(varyings: Record<string, GLTypeInfo>): MeshBasicMaterial {
    return buildFXUnlitMaterial(varyings, this.blending, this.useAlphaHashing, this.alphaTest, this.albedoNodes);
  }
}

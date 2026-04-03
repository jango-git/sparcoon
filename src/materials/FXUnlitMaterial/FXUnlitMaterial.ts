import type { MeshBasicMaterial } from "three";
import type { GLTypeInfo } from "../../instancedParticle/shared";
import { FXMaterial } from "../FXMaterial/FXMaterial";
import { buildFXUnlitMaterial } from "./FXUnlitMaterial.Internal";

/**
 * Unlit particle material - renders particles without lighting or shadows
 */
export class FXUnlitMaterial extends FXMaterial {
  /** @internal */
  public override buildThreeMaterial(varyings: Record<string, GLTypeInfo>): MeshBasicMaterial {
    return buildFXUnlitMaterial(
      varyings,
      this.blending,
      this.useAlphaHashing,
      this.alphaTest,
      this.albedoNodes,
    );
  }

  public override prepare(): void {
    let i = 0;
    for (const node of this.albedoNodes) {
      node.prepare?.(i);
      i += 1;
    }
  }
}

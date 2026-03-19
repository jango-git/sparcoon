import type { MeshLambertMaterial } from "three";
import type { GLTypeInfo } from "../../instancedParticle/shared";
import type { FXColorNode } from "../../nodes/color/FXColorNode";
import type { FXNormalNode } from "../../nodes/normal/FXNormalNode";
import { FXSphericalNormalNode } from "../../nodes/normal/FXSphericalNormalNode";
import type { FXTextureNode } from "../../nodes/texture/FXTextureNode";
import type { FXMaterialOptions } from "../FXMaterial/FXMaterial";
import { FXMaterial } from "../FXMaterial/FXMaterial";
import { buildFXDiffuseMaterial } from "./FXDiffuseMaterial.Internal";

export interface FXDiffuseMaterialOptions extends FXMaterialOptions {
  normalNodes?: (FXTextureNode | FXNormalNode)[];
  emissionNodes?: (FXColorNode | FXTextureNode)[];
}

export class FXDiffuseMaterial extends FXMaterial {
  private readonly normalNodes: readonly (FXTextureNode | FXNormalNode)[];
  private readonly emissionNodes: readonly (FXColorNode | FXTextureNode)[];

  constructor(options: FXDiffuseMaterialOptions = {}) {
    super(options);
    this.normalNodes = options.normalNodes ?? [new FXSphericalNormalNode()];
    this.emissionNodes = options.emissionNodes ?? [];
  }

  public override destroy(): void {
    super.destroy();
    for (const node of this.normalNodes) {
      node.destroy?.();
    }
    for (const node of this.emissionNodes) {
      node.destroy?.();
    }
  }

  /** @internal */
  public override buildThreeMaterial(varyings: Record<string, GLTypeInfo>): MeshLambertMaterial {
    return buildFXDiffuseMaterial(
      varyings,
      this.blending,
      this.useAlphaHashing,
      this.alphaTest,
      this.albedoNodes,
      this.normalNodes,
      this.emissionNodes,
    );
  }
}

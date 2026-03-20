import type { ColorRepresentation, MeshLambertMaterial } from "three";
import type { GLTypeInfo } from "../../instancedParticle/shared";
import { FXColor } from "../../miscellaneous/color/FXColor";
import type { FXColorNode } from "../../nodes/color/FXColorNode";
import type { FXNormalNode } from "../../nodes/normal/FXNormalNode";
import { FXSphericalNormalNode } from "../../nodes/normal/FXSphericalNormalNode";
import type { FXTextureNode } from "../../nodes/texture/FXTextureNode";
import type { FXMaterialOptions } from "../FXMaterial/FXMaterial";
import { FXMaterial } from "../FXMaterial/FXMaterial";
import type { FXScatterUniforms } from "./FXDiffuseMaterial.Internal";
import { buildFXDiffuseMaterial } from "./FXDiffuseMaterial.Internal";

export interface FXDiffuseMaterialOptions extends FXMaterialOptions {
  normalNodes: (FXTextureNode | FXNormalNode)[];
  emissionNodes: (FXColorNode | FXTextureNode)[];
  enableScatter: boolean;
  scatterTint: ColorRepresentation;
  scatterPower: number;
  forwardScatterStrength: number;
  backScatterStrength: number;
  shadowSensitivity: number;
  premultipliedAlpha: boolean;
}

export class FXDiffuseMaterial extends FXMaterial {
  private readonly normalNodes: readonly (FXTextureNode | FXNormalNode)[];
  private readonly emissionNodes: readonly (FXColorNode | FXTextureNode)[];
  private readonly scatterUniforms: FXScatterUniforms | undefined;
  private readonly shadowSensitivity: { value: number } | undefined;
  private readonly premultipliedAlpha: boolean;

  constructor(options: Partial<FXDiffuseMaterialOptions> = {}) {
    super(options);
    this.normalNodes = options.normalNodes ?? [new FXSphericalNormalNode()];
    this.emissionNodes = options.emissionNodes ?? [];
    this.scatterUniforms =
      options.enableScatter === true
        ? {
            // eslint-disable-next-line @typescript-eslint/naming-convention
            u_ScatterTint: { value: new FXColor(options.scatterTint ?? 0xffd999).toThreeColor() },
            // eslint-disable-next-line @typescript-eslint/naming-convention
            u_ScatterPower: { value: options.scatterPower ?? 10 },
            // eslint-disable-next-line @typescript-eslint/naming-convention
            u_ForwardScatterStrength: { value: options.forwardScatterStrength ?? 1 },
            // eslint-disable-next-line @typescript-eslint/naming-convention
            u_BackScatterStrength: { value: options.backScatterStrength ?? 1 },
          }
        : undefined;
    this.shadowSensitivity = { value: options.shadowSensitivity ?? 1 };
    this.premultipliedAlpha = options.premultipliedAlpha ?? false;
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
      this.scatterUniforms,
      this.shadowSensitivity,
      this.premultipliedAlpha,
    );
  }
}

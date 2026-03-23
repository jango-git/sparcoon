import type { ColorRepresentation, MeshLambertMaterial } from "three";
import type { GLTypeInfo } from "../../instancedParticle/shared";
import { FXColor } from "../../miscellaneous/color/FXColor";
import type { FXNodeColor } from "../../nodes/color/FXNodeColor";
import type { FXNodeNormal } from "../../nodes/normal/FXNodeNormal";
import { FXNodeSphericalNormal } from "../../nodes/normal/FXNodeSphericalNormal";
import type { FXNodeTexture } from "../../nodes/texture/FXNodeTexture";
import type { FXMaterialOptions } from "../FXMaterial/FXMaterial";
import { FXMaterial } from "../FXMaterial/FXMaterial";
import type { FXScatterUniforms } from "./FXDiffuseMaterial.Internal";
import { buildFXDiffuseMaterial } from "./FXDiffuseMaterial.Internal";

/**
 * Configuration options for {@link FXDiffuseMaterial}
 */
export interface FXDiffuseMaterialOptions extends FXMaterialOptions {
  /**
   * Normal nodes for lighting; multiple nodes are blended together
   *
   * @defaultValue `[new FXNodeSphericalNormal()]`
   */
  normalNodes: (FXNodeTexture | FXNodeNormal)[];

  /**
   * Emission color nodes composited for emissive output
   *
   * @defaultValue `[]`
   */
  emissionNodes: (FXNodeColor | FXNodeTexture)[];

  /**
   * Enable subsurface scattering approximation
   *
   * @defaultValue `false`
   */
  enableScatter: boolean;

  /**
   * Tint color applied to the scatter contribution
   *
   * @defaultValue `0xffd999`
   */
  scatterTint: ColorRepresentation;

  /**
   * Scatter lobe sharpness; higher values produce a tighter highlight
   *
   * @defaultValue `10`
   */
  scatterPower: number;

  /**
   * Forward scatter intensity (light-facing side)
   *
   * @defaultValue `1`
   */
  forwardScatterStrength: number;

  /**
   * Back scatter intensity (back-lit side)
   *
   * @defaultValue `1`
   */
  backScatterStrength: number;

  /**
   * Shadow influence (`0` = no shadows, `1` = full shadows)
   *
   * @defaultValue `1`
   */
  shadowSensitivity: number;
}

/**
 * Diffuse particle material with lighting, normals, emission, and optional subsurface scattering
 */
export class FXDiffuseMaterial extends FXMaterial {
  private readonly normalNodes: readonly (FXNodeTexture | FXNodeNormal)[];
  private readonly emissionNodes: readonly (FXNodeColor | FXNodeTexture)[];
  private readonly scatterUniforms: FXScatterUniforms | undefined;
  private readonly shadowSensitivity: { value: number } | undefined;

  /**
   * @param options - Material configuration
   */
  constructor(options: Partial<FXDiffuseMaterialOptions> = {}) {
    super(options);
    this.normalNodes = options.normalNodes ?? [new FXNodeSphericalNormal()];
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
  }

  /** Releases resources held by all albedo, normal, and emission nodes */
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
      this.premultipliedAlpha,
      this.albedoNodes,
      this.normalNodes,
      this.emissionNodes,
      this.scatterUniforms,
      this.shadowSensitivity,
    );
  }
}

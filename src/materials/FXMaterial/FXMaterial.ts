import type { Blending, Material, MeshDepthMaterial, MeshDistanceMaterial } from "three";
import { NormalBlending } from "three";
import type { GLTypeInfo } from "../../instancedParticle/shared";
import type { FXColorNode } from "../../nodes/color/FXColorNode";
import type { FXTextureNode } from "../../nodes/texture/FXTextureNode";
import { buildDepthMaterial } from "./FXDepthMaterial.Internal";
import { buildDistanceMaterial } from "./FXDistanceMaterial.Internal";

export interface FXMaterialOptions {
  albedoNodes: (FXColorNode | FXTextureNode)[];
  blending: Blending;
  useAlphaHashing: boolean;
  alphaTest: number;
  depthAlphaTest: number;
  useDepthAlphaHash: boolean;
  useSphericalDepth: boolean;
  premultipliedAlpha: boolean;
}

export abstract class FXMaterial {
  /** @internal */
  public readonly albedoNodes: readonly (FXColorNode | FXTextureNode)[];
  /** @internal */
  public readonly blending: Blending;
  /** @internal */
  public readonly useAlphaHashing: boolean;
  /** @internal */
  public readonly alphaTest: number;
  /** @internal */
  public readonly premultipliedAlpha: boolean;

  private readonly depthAlphaTest: number;
  private readonly useDepthAlphaHash: boolean;
  private readonly useSphericalDepth: boolean;

  constructor(options: Partial<FXMaterialOptions> = {}) {
    this.albedoNodes = options.albedoNodes ?? [];
    this.blending = options.blending ?? NormalBlending;
    this.useAlphaHashing = options.useAlphaHashing ?? false;
    this.alphaTest = options.alphaTest ?? 0.0075;
    this.premultipliedAlpha =
      (options.useAlphaHashing === undefined && options.premultipliedAlpha) ?? true;

    this.depthAlphaTest = options.depthAlphaTest ?? 0.5;
    this.useDepthAlphaHash = options.useDepthAlphaHash ?? false;
    this.useSphericalDepth = options.useSphericalDepth ?? true;
  }

  public destroy(): void {
    for (const node of this.albedoNodes) {
      node.destroy?.();
    }
  }

  /** @internal */
  public buildDepthMaterial(): MeshDepthMaterial {
    return buildDepthMaterial(
      this.albedoNodes,
      this.depthAlphaTest,
      this.useDepthAlphaHash,
      this.useSphericalDepth,
    );
  }

  public buildDistanceMaterial(): MeshDistanceMaterial {
    return buildDistanceMaterial(
      this.albedoNodes,
      this.depthAlphaTest,
      this.useDepthAlphaHash,
      this.useSphericalDepth,
    );
  }

  /** @internal */
  public abstract buildThreeMaterial(varyings: Record<string, GLTypeInfo>): Material;
}

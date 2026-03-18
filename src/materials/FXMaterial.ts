import type { Material, MeshDepthMaterial } from "three";
import type { GLTypeInfo } from "../instancedParticle/shared";
import type { FXColorNode } from "./color-nodes/FXColorNode";
import { buildDepthMaterial } from "./FXMaterial.Internal";

export interface FXMaterialOptions {
  colorNodes?: FXColorNode[];
  depthAlphaTest?: number;
  useDepthAlphaHash?: boolean;
  useSphericalDepth?: boolean;
}

export abstract class FXMaterial {
  /** @internal */
  public readonly colorNodes: readonly FXColorNode[];
  private readonly depthAlphaTest: number;
  private readonly useDepthAlphaHash: boolean;
  private readonly useSphericalDepth: boolean;

  constructor(options: FXMaterialOptions = {}) {
    this.colorNodes = options.colorNodes ?? [];
    this.depthAlphaTest = options.depthAlphaTest ?? 0.5;
    this.useDepthAlphaHash = options.useDepthAlphaHash ?? false;
    this.useSphericalDepth = options.useSphericalDepth ?? false;
  }

  public destroy(): void {
    for (const node of this.colorNodes) {
      node.destroy?.();
    }
  }

  /** @internal */
  public buildDepthMaterial(): MeshDepthMaterial {
    return buildDepthMaterial(
      this.colorNodes,
      this.depthAlphaTest,
      this.useDepthAlphaHash,
      this.useSphericalDepth,
    );
  }

  /** @internal */
  public abstract buildThreeMaterial(varyings: Record<string, GLTypeInfo>): Material;
}

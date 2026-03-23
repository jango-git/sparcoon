import type { Blending, Material, MeshDepthMaterial, MeshDistanceMaterial } from "three";
import { NormalBlending } from "three";
import type { GLTypeInfo } from "../../instancedParticle/shared";
import type { FXNodeColor } from "../../nodes/color/FXNodeColor";
import type { FXNodeTexture } from "../../nodes/texture/FXNodeTexture";
import { buildDepthMaterial } from "./FXDepthMaterial.Internal";
import { buildDistanceMaterial } from "./FXDistanceMaterial.Internal";

/**
 * Configuration options shared by all {@link FXMaterial} subclasses
 */
export interface FXMaterialOptions {
  /**
   * Color and texture nodes composited for particle color
   *
   * @defaultValue `[]`
   */
  albedoNodes: (FXNodeColor | FXNodeTexture)[];

  /**
   * Three.js blending mode
   *
   * @defaultValue `NormalBlending`
   */
  blending: Blending;

  /**
   * Use alpha hashing instead of standard transparency
   *
   * @defaultValue `false`
   */
  useAlphaHashing: boolean;

  /**
   * Alpha cutoff threshold for color passes
   *
   * @defaultValue `0.0075`
   */
  alphaTest: number;

  /**
   * Alpha cutoff threshold for depth and shadow passes
   *
   * @defaultValue `0.5`
   */
  depthAlphaTest: number;

  /**
   * Use alpha hashing in depth and shadow passes
   *
   * @defaultValue `false`
   */
  useDepthAlphaHash: boolean;

  /**
   * Approximate spherical depth for shadow maps
   *
   * @defaultValue `true`
   */
  useSphericalDepth: boolean;

  /**
   * Use premultiplied alpha blending
   *
   * @defaultValue `true`
   */
  premultipliedAlpha: boolean;
}

/**
 * Abstract base class for particle materials
 */
export abstract class FXMaterial {
  /** @internal */
  public readonly albedoNodes: readonly (FXNodeColor | FXNodeTexture)[];
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

  /** Releases resources held by all albedo nodes */
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

  /** @internal */
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

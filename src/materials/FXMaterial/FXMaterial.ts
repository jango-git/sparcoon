import type { Material, MeshDepthMaterial, MeshDistanceMaterial } from "three";
import type { GLTypeInfo } from "../../instancedParticle/shared";
import type { FXNodeBlending } from "../../nodes/blending/FXNodeBlending";
import { FXNodeColor } from "../../nodes/color/FXNodeColor";
import { FXNodeTexture } from "../../nodes/texture/FXNodeTexture";
import { buildDepthMaterial } from "./FXDepthMaterial.Internal";
import { buildDistanceMaterial } from "./FXDistanceMaterial.Internal";

/**
 * Per-particle blend mode used when compositing particles into the scene
 */
export enum FXBlending {
  /**
   * Premultiplied additive blend - particle color is pre-multiplied by alpha and added to the
   * destination with zero alpha contribution
   */
  MASKED_ADDITIVE = 0,
  /**
   * Luminance-aware multiply blend - dark areas darken the destination while bright areas
   * normal-blend through a mask
   */
  MASKED_MULTIPLY = 1,
}

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

  blending: FXBlending;

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
}

/**
 * Abstract base class for particle materials
 */
export abstract class FXMaterial {
  /** @internal */
  public readonly albedoNodes: readonly (FXNodeColor | FXNodeTexture | FXNodeBlending)[];
  /** @internal */
  public readonly blending: FXBlending;
  /** @internal */
  public readonly useAlphaHashing: boolean;
  /** @internal */
  public readonly alphaTest: number;

  private readonly depthAlphaTest: number;
  private readonly useDepthAlphaHash: boolean;
  private readonly useSphericalDepth: boolean;

  constructor(options: Partial<FXMaterialOptions> = {}) {
    this.albedoNodes = options.albedoNodes ?? [];
    this.blending = options.blending ?? FXBlending.MASKED_ADDITIVE;
    this.useAlphaHashing = options.useAlphaHashing ?? false;
    this.alphaTest = options.alphaTest ?? 0.0075;

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
      this.albedoNodes.filter(
        (node): node is FXNodeColor | FXNodeTexture =>
          node instanceof FXNodeColor || node instanceof FXNodeTexture,
      ),
      this.depthAlphaTest,
      this.useDepthAlphaHash,
      this.useSphericalDepth,
    );
  }

  /** @internal */
  public buildDistanceMaterial(): MeshDistanceMaterial {
    return buildDistanceMaterial(
      this.albedoNodes.filter(
        (node): node is FXNodeColor | FXNodeTexture =>
          node instanceof FXNodeColor || node instanceof FXNodeTexture,
      ),
      this.depthAlphaTest,
      this.useDepthAlphaHash,
      this.useSphericalDepth,
    );
  }

  /** @internal */
  public abstract buildThreeMaterial(varyings: Record<string, GLTypeInfo>): Material;

  /** @internal */
  public abstract prepare(): void;
}

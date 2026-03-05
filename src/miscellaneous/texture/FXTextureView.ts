import type { FerrsignView3 } from "ferrsign";
import { Ferrsign3 } from "ferrsign";
import { Matrix3, Texture, Vector2 } from "three";
import { assertValidNonNegativeNumber, assertValidPositiveNumber } from "../asserts";
import type { FXTextureAtlasConfig, FXTextureConfig } from "./FXTextureView.Internal";
import { TEXTURE_DEFAULT_SIZE, TEXTURE_DEFAULT_TEXTURE } from "./FXTextureView.Internal";

/** Wrapper for Three.js texture with atlas and trim support. Does not own the underlying texture; user must dispose it. */
export class FXTextureView {
  private textureInternal: Texture = TEXTURE_DEFAULT_TEXTURE;

  private sourceWidth = TEXTURE_DEFAULT_SIZE;
  private sourceHeight = TEXTURE_DEFAULT_SIZE;

  private frameX = 0;
  private frameY = 0;
  private frameWidth = TEXTURE_DEFAULT_SIZE;
  private frameHeight = TEXTURE_DEFAULT_SIZE;

  private rotatedInternal = false;
  private scaleInternal = 1;

  private trimLeft = 0;
  private trimRight = 0;
  private trimTop = 0;
  private trimBottom = 0;

  private textureDirtyInternal = false;
  private uvTransformDirtyInternal = false;
  private trimDirtyInternal = false;

  private readonly signalDiminsionsChangedInternal = new Ferrsign3<number, number, FXTextureView>();

  /** @param config Texture or atlas configuration */
  constructor(config?: FXTextureConfig) {
    if (config !== undefined) {
      this.set(config);
    }
  }

  /** Original width before trimming in world units */
  public get width(): number {
    return this.sourceWidth / this.scaleInternal;
  }

  /** Original height before trimming in world units */
  public get height(): number {
    return this.sourceHeight / this.scaleInternal;
  }

  /** Visible width after trimming in world units */
  public get trimmedWidth(): number {
    const frameSize = this.rotatedInternal ? this.frameHeight : this.frameWidth;
    return frameSize / this.scaleInternal;
  }

  /** Visible height after trimming in world units */
  public get trimmedHeight(): number {
    const frameSize = this.rotatedInternal ? this.frameWidth : this.frameHeight;
    return frameSize / this.scaleInternal;
  }

  /** Underlying Three.js texture */
  public get texture(): Texture {
    return this.textureInternal;
  }

  /** Whether sprite is rotated in atlas */
  public get rotated(): boolean {
    return this.rotatedInternal;
  }

  /** Scale factor for resolution independence */
  public get scale(): number {
    return this.scaleInternal;
  }

  /** Transparent padding around visible content */
  public get trim(): Readonly<{
    left: number;
    right: number;
    top: number;
    bottom: number;
  }> {
    const scale = this.scaleInternal;
    return {
      left: this.trimLeft / scale,
      right: this.trimRight / scale,
      top: this.trimTop / scale,
      bottom: this.trimBottom / scale,
    };
  }

  public get textureDirty(): boolean {
    return this.textureDirtyInternal;
  }

  /** Whether UV transform inputs changed since last check */
  public get uvTransformDirty(): boolean {
    return this.uvTransformDirtyInternal;
  }

  /** Whether trim values changed since last check */
  public get trimDirty(): boolean {
    return this.trimDirtyInternal;
  }

  public get signalDiminsionsChanged(): FerrsignView3<number, number, FXTextureView> {
    return this.signalDiminsionsChangedInternal;
  }

  public setTextureDirtyFalse(): void {
    this.textureDirtyInternal = false;
  }

  /** Marks UV transform as clean. @internal */
  public setUVTransformDirtyFalse(): void {
    this.uvTransformDirtyInternal = false;
  }

  /** Marks trim as clean. @internal */
  public setTrimDirtyFalse(): void {
    this.trimDirtyInternal = false;
  }

  /**
   * Calculates UV transform matrix for shader sampling.
   * @param result Matrix to store result in
   * @returns UV transform matrix
   */
  public calculateUVTransform(result = new Matrix3()): Matrix3 {
    const atlasWidth = this.textureInternal.image?.naturalWidth ?? TEXTURE_DEFAULT_SIZE;
    const atlasHeight = this.textureInternal.image?.naturalHeight ?? TEXTURE_DEFAULT_SIZE;

    if (this.rotatedInternal) {
      const physicalWidth = this.frameHeight;
      const physicalHeight = this.frameWidth;

      const u0 = this.frameX / atlasWidth;
      const v0 = (atlasHeight - this.frameY - physicalHeight) / atlasHeight;
      const uSize = physicalWidth / atlasWidth;
      const vSize = physicalHeight / atlasHeight;

      result.set(0, uSize, u0, -vSize, 0, v0 + vSize, 0, 0, 1);
    } else {
      const u0 = this.frameX / atlasWidth;
      const v0 = (atlasHeight - this.frameY - this.frameHeight) / atlasHeight;
      const uSize = this.frameWidth / atlasWidth;
      const vSize = this.frameHeight / atlasHeight;

      result.set(uSize, 0, u0, 0, vSize, v0, 0, 0, 1);
    }

    return result;
  }

  /**
   * Gets original dimensions before trimming.
   * @param result Vector to store result in
   * @returns Width and height in world units
   */
  public getResolution(result = new Vector2()): Vector2 {
    return result.set(this.width, this.height);
  }

  /**
   * Replaces texture with new configuration.
   * @param config Texture or atlas configuration
   */
  public set(config: FXTextureConfig): void {
    const lastWidth = this.width;
    const lastHeight = this.height;

    if (config instanceof Texture) {
      this.setFromTexture(config);
    } else {
      this.setFromAtlasConfig(config);
    }

    if (this.width !== lastWidth || this.height !== lastHeight) {
      this.signalDiminsionsChangedInternal.emit(this.width, this.height, this);
    }
  }

  private setFromTexture(texture: Texture): void {
    const width = texture.image?.naturalWidth ?? TEXTURE_DEFAULT_SIZE;
    const height = texture.image?.naturalHeight ?? TEXTURE_DEFAULT_SIZE;

    this.sourceWidth = width;
    this.sourceHeight = height;

    if (this.texture !== texture) {
      this.textureInternal = texture;
      this.textureDirtyInternal = true;
    }

    if (
      this.frameX !== 0 ||
      this.frameY !== 0 ||
      this.frameWidth !== width ||
      this.frameHeight !== height ||
      this.scaleInternal !== 1 ||
      this.rotatedInternal
    ) {
      this.frameX = 0;
      this.frameY = 0;
      this.frameWidth = width;
      this.frameHeight = height;
      this.rotatedInternal = false;
      this.scaleInternal = 1;
      this.uvTransformDirtyInternal = true;
    }

    if (
      this.trimLeft !== 0 ||
      this.trimRight !== 0 ||
      this.trimTop !== 0 ||
      this.trimBottom !== 0
    ) {
      this.trimLeft = 0;
      this.trimRight = 0;
      this.trimTop = 0;
      this.trimBottom = 0;
      this.trimDirtyInternal = true;
    }
  }

  private setFromAtlasConfig(config: FXTextureAtlasConfig): void {
    assertValidPositiveNumber(
      config.sourceSize.w,
      "UITextureView.setFromAtlasConfig.config.sourceSize.w",
    );
    assertValidPositiveNumber(
      config.sourceSize.h,
      "UITextureView.setFromAtlasConfig.config.sourceSize.h",
    );
    assertValidNonNegativeNumber(config.frame.x, "UITextureView.setFromAtlasConfig.config.frame.x");
    assertValidNonNegativeNumber(config.frame.y, "UITextureView.setFromAtlasConfig.config.frame.y");
    assertValidPositiveNumber(config.frame.w, "UITextureView.setFromAtlasConfig.config.frame.w");
    assertValidPositiveNumber(config.frame.h, "UITextureView.setFromAtlasConfig.config.frame.h");
    assertValidNonNegativeNumber(
      config.spriteSourceSize.x,
      "UITextureView.setFromAtlasConfig.config.spriteSourceSize.x",
    );
    assertValidNonNegativeNumber(
      config.spriteSourceSize.y,
      "UITextureView.setFromAtlasConfig.config.spriteSourceSize.y",
    );
    assertValidPositiveNumber(
      config.spriteSourceSize.w,
      "UITextureView.setFromAtlasConfig.config.spriteSourceSize.w",
    );
    assertValidPositiveNumber(
      config.spriteSourceSize.h,
      "UITextureView.setFromAtlasConfig.config.spriteSourceSize.h",
    );

    if (config.scale !== undefined) {
      assertValidPositiveNumber(config.scale, "UITextureView.setFromAtlasConfig.config.scale");
    }

    this.sourceWidth = config.sourceSize.w;
    this.sourceHeight = config.sourceSize.h;

    if (this.texture !== config.texture) {
      this.textureInternal = config.texture;
      this.textureDirtyInternal = true;
    }

    const scale = config.scale ?? 1;
    const rotated = config.rotated ?? false;

    if (
      this.frameX !== 0 ||
      this.frameY !== 0 ||
      this.frameWidth !== config.frame.w ||
      this.frameHeight !== config.frame.h ||
      this.scaleInternal !== scale ||
      this.rotatedInternal !== rotated
    ) {
      this.frameX = config.frame.x;
      this.frameY = config.frame.y;
      this.frameWidth = config.frame.w;
      this.frameHeight = config.frame.h;
      this.scaleInternal = scale;
      this.rotatedInternal = rotated;
      this.uvTransformDirtyInternal = true;
    }

    const spriteSource = config.spriteSourceSize;
    const trimLeft = spriteSource.x;
    const trimTop = spriteSource.y;
    const trimRight = this.sourceWidth - spriteSource.x - spriteSource.w;
    const trimBottom = this.sourceHeight - spriteSource.y - spriteSource.h;

    if (
      this.trimLeft !== trimLeft ||
      this.trimRight !== trimRight ||
      this.trimTop !== trimTop ||
      this.trimBottom !== trimBottom
    ) {
      this.trimLeft = trimLeft;
      this.trimRight = trimRight;
      this.trimTop = trimTop;
      this.trimBottom = trimBottom;
      this.trimDirtyInternal = true;
    }
  }
}

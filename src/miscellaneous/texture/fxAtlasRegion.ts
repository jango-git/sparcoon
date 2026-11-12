import type { Texture } from "three";

import type { FXTextureRegion } from "../../render/FXExternalTexture.js";

/** A rectangle in texture pixels, origin top-left (as texture packers write it). */
export interface FXAtlasRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** A size in pixels (as packers write the atlas' `meta.size`). */
export interface FXAtlasSize {
  readonly w: number;
  readonly h: number;
}

/**
 * One sprite of a packed atlas, in the shape packers (TexturePacker, free-tex-packer) write a
 * frame - so a parsed frame entry can be passed as is. Parsing the atlas file is the app's job.
 */
export interface FXAtlasSprite {
  /** The sprite's rectangle in the atlas, at its unrotated size (`w`/`h` as in the source image). */
  readonly frame: FXAtlasRect;
  /** Stored rotated 90 degrees clockwise in the atlas. default false */
  readonly rotated?: boolean;
  /** Where the trimmed `frame` sits in the untrimmed source. Absent = not trimmed. */
  readonly spriteSourceSize?: FXAtlasRect;
  /** The untrimmed source size. Required with `spriteSourceSize`. */
  readonly sourceSize?: FXAtlasSize;
}

/** Size fields of the image sources a `Texture` may hold. */
interface ImageSize {
  readonly naturalWidth?: number;
  readonly naturalHeight?: number;
  readonly videoWidth?: number;
  readonly videoHeight?: number;
  readonly width?: number;
  readonly height?: number;
}

function textureImageSize(texture: Texture): FXAtlasSize | undefined {
  const image = texture.image as ImageSize | null | undefined;
  const w = image?.naturalWidth ?? image?.videoWidth ?? image?.width ?? 0;
  const h = image?.naturalHeight ?? image?.videoHeight ?? image?.height ?? 0;
  return w > 0 && h > 0 ? { w, h } : undefined;
}

function assertRect(rect: FXAtlasRect, where: string): void {
  const valid =
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    rect.x >= 0 &&
    rect.y >= 0 &&
    Number.isFinite(rect.w) &&
    Number.isFinite(rect.h) &&
    rect.w > 0 &&
    rect.h > 0;
  if (!valid) {
    throw new RangeError(`fxAtlasRegion: ${where} must have x, y >= 0 and w, h > 0`);
  }
}

/**
 * The {@link FXTextureRegion} of one atlas sprite. The slot's UV square spans the sprite's
 * untrimmed source; a trimmed sprite's cut margins come back transparent (`uvBounds`), so a
 * particle quad keeps the source's proportions.
 *
 * @param atlasSize - The atlas size in pixels, as the packer wrote it (`meta.size`). Lets the region
 * be built before the image loads; omitted, it is read from `texture.image`.
 * @throws When the atlas size is unknown (none given and the image not loaded yet), a rectangle is
 * invalid, or `spriteSourceSize` comes without `sourceSize`.
 */
export function fxAtlasRegion(
  texture: Texture,
  sprite: FXAtlasSprite,
  atlasSize?: FXAtlasSize,
): FXTextureRegion {
  const atlas = atlasSize ?? textureImageSize(texture);
  if (atlas === undefined) {
    throw new Error(
      "fxAtlasRegion: the atlas size is unknown - pass it (the packer's meta.size) or load the image first",
    );
  }
  assertRect({ x: 0, y: 0, ...atlas }, "atlasSize");
  const { frame } = sprite;
  assertRect(frame, "frame");
  const rotated = sprite.rotated ?? false;

  // The trim: the slot's UV (source space, V up) -> the trimmed frame's UV (V up).
  // `t = s * uv + o` per axis; identity when not trimmed.
  let scaleU = 1;
  let offsetU = 0;
  let scaleV = 1;
  let offsetV = 0;
  let uvBounds: FXTextureRegion["uvBounds"];
  if (sprite.spriteSourceSize !== undefined) {
    const source = sprite.sourceSize;
    if (source === undefined) {
      throw new Error("fxAtlasRegion: spriteSourceSize needs sourceSize");
    }
    const trim = sprite.spriteSourceSize;
    assertRect(trim, "spriteSourceSize");
    assertRect({ x: 0, y: 0, ...source }, "sourceSize");
    const trimmed = trim.x > 0 || trim.y > 0 || trim.w < source.w || trim.h < source.h;
    if (trimmed) {
      scaleU = source.w / trim.w;
      offsetU = -trim.x / trim.w;
      scaleV = source.h / trim.h;
      offsetV = (trim.h - source.h + trim.y) / trim.h;
      uvBounds = [
        trim.x / source.w,
        1 - (trim.y + trim.h) / source.h,
        (trim.x + trim.w) / source.w,
        1 - trim.y / source.h,
      ];
    }
  }

  // The frame's UV -> the atlas UV. A rotated sprite is stored 90 degrees clockwise, so its
  // physical rectangle is `h` wide and `w` tall, and its U runs down the atlas.
  const physicalW = rotated ? frame.h : frame.w;
  const physicalH = rotated ? frame.w : frame.h;
  const u0 = frame.x / atlas.w;
  const v0 = (atlas.h - frame.y - physicalH) / atlas.h;
  const uSize = physicalW / atlas.w;
  const vSize = physicalH / atlas.h;

  const uvTransform: FXTextureRegion["uvTransform"] = rotated
    ? // u' = u0 + uSize * t_v; v' = v0 + vSize - vSize * t_u
      [0, uSize * scaleV, u0 + uSize * offsetV, -vSize * scaleU, 0, v0 + vSize - vSize * offsetU]
    : // u' = u0 + uSize * t_u; v' = v0 + vSize * t_v
      [uSize * scaleU, 0, u0 + uSize * offsetU, 0, vSize * scaleV, v0 + vSize * offsetV];

  return uvBounds === undefined ? { texture, uvTransform } : { texture, uvTransform, uvBounds };
}

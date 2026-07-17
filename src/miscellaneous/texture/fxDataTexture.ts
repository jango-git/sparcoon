import type {
  ColorSpace,
  MagnificationTextureFilter,
  MinificationTextureFilter,
  PixelFormat,
  TextureDataType,
  Wrapping,
} from "three";
import {
  ClampToEdgeWrapping,
  DataTexture,
  FloatType,
  LinearFilter,
  NoColorSpace,
  RGBAFormat,
} from "three";

/** Format/filter overrides for {@link fxDataTexture}; each defaults to a gradient-LUT-friendly value. */
export interface FXDataTextureOptions {
  /** default RGBAFormat */
  format?: PixelFormat;
  /** must match `data` (Float32Array <-> FloatType). default FloatType */
  type?: TextureDataType;
  /** default LinearFilter */
  minFilter?: MinificationTextureFilter;
  /** default LinearFilter */
  magFilter?: MagnificationTextureFilter;
  /** default ClampToEdgeWrapping */
  wrapS?: Wrapping;
  /** default ClampToEdgeWrapping */
  wrapT?: Wrapping;
  /** default NoColorSpace (linear) */
  colorSpace?: ColorSpace;
}

/**
 * Rebuilds a generated (baked) Three {@link DataTexture} from flat pixel data - the stable helper an
 * editor-emitted module calls; the runtime only constructs the GPU resource, no baking logic here.
 * `data.length` must be `width * height * channels`. Module-scoped and shared by every importing
 * emitter, never disposed by the runtime (see the `fromArtifacts` texture-ownership contract).
 */
export function fxDataTexture(
  data: Float32Array,
  width: number,
  height: number,
  options: FXDataTextureOptions = {},
): DataTexture {
  const texture = new DataTexture(
    // TS 5.7 widens `Float32Array` to `Float32Array<ArrayBufferLike>`, which no longer matches
    // three's ArrayBuffer-backed `BufferSource` parameter; the runtime value is a plain typed array.
    data as unknown as ConstructorParameters<typeof DataTexture>[0],
    width,
    height,
    options.format ?? RGBAFormat,
    options.type ?? FloatType,
  );
  texture.minFilter = options.minFilter ?? LinearFilter;
  texture.magFilter = options.magFilter ?? LinearFilter;
  texture.wrapS = options.wrapS ?? ClampToEdgeWrapping;
  texture.wrapT = options.wrapT ?? ClampToEdgeWrapping;
  texture.colorSpace = options.colorSpace ?? NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

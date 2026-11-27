import type { WebGLRenderer } from "three";
import { Texture } from "three";

import { gpuLimit } from "./FXGPULimits.Internal.js";

/**
 * @internal Textures of raw values a shader reads by index with `texelFetch`, never filtered: one
 * value per texel, in rows of up to `MAX_TEXTURE_SIZE` texels, so value `i` is texel
 * `(i % width, i / width)` - the mesh surface tables and a sorted emitter's slots and order alike.
 * They are made and uploaded with raw GL calls three's state does not see, so the caller resets it:
 * `renderer.resetState()`, or `deferStateReset` inside the world's tick.
 */

/** Floats of an RGBA32F texel. */
const RGBA_FLOATS = 4;

export interface FXDataTextureSize {
  readonly width: number;
  readonly height: number;
}

/**
 * The size of a texture of `texels` values on `gl`.
 * @param subject - What the texture holds, opening the error.
 * @throws When it would be taller than the GPU's texture size.
 */
export function dataTextureSize(
  gl: WebGL2RenderingContext,
  texels: number,
  subject: string,
): FXDataTextureSize {
  const maxSize = gpuLimit(gl, gl.MAX_TEXTURE_SIZE);
  const width = Math.min(texels, maxSize);
  const height = Math.ceil(texels / width);
  if (height > maxSize) {
    throw new Error(
      `${subject} of ${String(texels)} texels exceeds this GPU's texture size (${String(maxSize)})`,
    );
  }
  return { width, height };
}

/** One rectangle of an upload: `width` x `height` texels at row `y`, from value `first`. */
export interface FXDataTextureRows {
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly first: number;
}

/** The rectangles `texels` values fill: the full rows, then the partial last one. */
export function dataTextureRows(
  texels: number,
  size: FXDataTextureSize,
): readonly FXDataTextureRows[] {
  const fullRows = Math.floor(texels / size.width);
  const rest = texels - fullRows * size.width;
  const rows: FXDataTextureRows[] = [];
  if (fullRows > 0) {
    rows.push({ y: 0, width: size.width, height: fullRows, first: 0 });
  }
  if (rest > 0) {
    rows.push({ y: fullRows, width: rest, height: 1, first: fullRows * size.width });
  }
  return rows;
}

/** A data texture of `internalFormat`, left bound to `TEXTURE_2D` and ready for an upload. */
export function createDataTexture(
  gl: WebGL2RenderingContext,
  internalFormat: number,
  size: FXDataTextureSize,
): WebGLTexture {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, internalFormat, size.width, size.height);
  // Float and integer formats do not filter: a filtering sampler would leave it incomplete.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  prepareDataUpload(gl);
  return texture;
}

/** Uploads the `texels` RGBA32F values of `data` into the texture of `size` bound to
 *  `TEXTURE_2D`. */
export function uploadDataTexels(
  gl: WebGL2RenderingContext,
  size: FXDataTextureSize,
  texels: number,
  data: Float32Array,
): void {
  prepareDataUpload(gl);
  for (const rows of dataTextureRows(texels, size)) {
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      rows.y,
      rows.width,
      rows.height,
      gl.RGBA,
      gl.FLOAT,
      data,
      rows.first * RGBA_FLOATS,
    );
  }
}

/**
 * Sets the unpack state an upload of raw values needs, whatever three's last upload left: values
 * as they lie, rows back to back. An upload from a buffer fails unless flipping and premultiplying
 * are off.
 */
export function prepareDataUpload(gl: WebGL2RenderingContext): void {
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
  gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
  gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
}

/**
 * A three `Texture` drawing `texture`, for a material's uniform: three binds a texture it never
 * uploaded (`version` 0) by the WebGL texture its properties hold for it, and deletes only textures
 * it uploaded itself.
 */
export function threeTextureOf(renderer: WebGLRenderer, texture: WebGLTexture): Texture {
  const wrapper = new Texture();
  (renderer.properties.get(wrapper) as Record<string, unknown>)["__webglTexture"] = texture;
  return wrapper;
}

/** The WebGL texture three holds for `texture` - {@link threeTextureOf} the other way round -
 *  `undefined` until three first uploaded or rendered into it. */
export function webglTextureOf(
  renderer: WebGLRenderer,
  texture: Texture,
): WebGLTexture | undefined {
  return (renderer.properties.get(texture) as Record<string, WebGLTexture | undefined>)[
    "__webglTexture"
  ];
}

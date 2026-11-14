import type { WebGLRenderer } from "three";

import { FX_SURFACE_TEXEL_FLOATS } from "../surfaceTableLayout.js";
import { type FXContextLease, FXContextLeases } from "./FXContextLeases.Internal.js";
import type { FXSurfaceTable } from "./FXSurfaceTable.Internal.js";

// Every holder sampling the same table on the same context shares one texture.
const textures = new FXContextLeases<FXSurfaceTable, WebGLTexture>((gl, texture) => {
  gl.deleteTexture(texture);
});

/** @internal A claim on the RGBA32F texture of `table` on `renderer`'s context, uploaded on first
 *  use. */
export function acquireSurfaceTexture(
  renderer: WebGLRenderer,
  table: FXSurfaceTable,
): FXContextLease<WebGLTexture> {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  return textures.acquire(gl, table, () => uploadSurfaceTexture(renderer, gl, table));
}

/** Rows of up to `MAX_TEXTURE_SIZE` texels; the kernel finds a texel by the texture's width. */
function uploadSurfaceTexture(
  renderer: WebGLRenderer,
  gl: WebGL2RenderingContext,
  table: FXSurfaceTable,
): WebGLTexture {
  const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  const width = Math.min(table.texels, maxSize);
  const height = Math.ceil(table.texels / width);
  if (height > maxSize) {
    throw new Error(
      `FXSurfaceTexture: a surface of ${String(table.texels)} texels exceeds this GPU's texture size`,
    );
  }
  const pixels =
    width * height === table.texels
      ? table.data
      : padded(table.data, width * height * FX_SURFACE_TEXEL_FLOATS);
  const texture = gl.createTexture();
  // Bound through three's state, so its texture cache stays true to the context.
  renderer.state.bindTexture(gl.TEXTURE_2D, texture);
  // three sets these before each of its own uploads but leaves them set after.
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, pixels);
  renderer.state.unbindTexture();
  return texture;
}

function padded(data: Float32Array, length: number): Float32Array {
  const result = new Float32Array(length);
  result.set(data);
  return result;
}

import type { WebGLRenderer } from "three";

import { prepareDataUpload } from "../render/FXDataTexture.Internal.js";
import { gpuLimit } from "../render/FXGPULimits.Internal.js";
import { type FXContextLease, FXContextLeases } from "./FXContextLeases.Internal.js";
import type { FXVolumeTable } from "./FXVolumeTable.Internal.js";

// Every holder sampling the same table on the same context shares one texture.
const textures = new FXContextLeases<FXVolumeTable, WebGLTexture>((gl, texture) => {
  gl.deleteTexture(texture);
});

/** @internal A claim on the R8 3D texture of `table` on `renderer`'s context, uploaded on first
 *  use. */
export function acquireVolumeTexture(
  renderer: WebGLRenderer,
  table: FXVolumeTable,
): FXContextLease<WebGLTexture> {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  return textures.acquire(gl, table, () => uploadVolumeTexture(renderer, gl, table));
}

/** Filtered linearly and clamped to its edge texels, as the JS kernel's table is read. */
function uploadVolumeTexture(
  renderer: WebGLRenderer,
  gl: WebGL2RenderingContext,
  table: FXVolumeTable,
): WebGLTexture {
  const maxSize = gpuLimit(gl, gl.MAX_3D_TEXTURE_SIZE);
  if (Math.max(table.width, table.height, table.depth) > maxSize) {
    throw new Error(
      `FXVolumeTexture: a ${String(table.width)}x${String(table.height)}x${String(table.depth)} ` +
        `volume exceeds this GPU's 3D texture size (${String(maxSize)})`,
    );
  }
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_3D, texture);
  gl.texStorage3D(gl.TEXTURE_3D, 1, gl.R8, table.width, table.height, table.depth);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  prepareDataUpload(gl);
  // One byte a texel - rows of any width lie back to back, and so do the slices.
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, 0);
  gl.pixelStorei(gl.UNPACK_SKIP_IMAGES, 0);
  gl.texSubImage3D(
    gl.TEXTURE_3D,
    0,
    0,
    0,
    0,
    table.width,
    table.height,
    table.depth,
    gl.RED,
    gl.UNSIGNED_BYTE,
    table.bytes,
  );
  // Built outside the world's tick, possibly right before a draw.
  renderer.resetState();
  return texture;
}

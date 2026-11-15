import type { WebGLRenderer } from "three";

import {
  createDataTexture,
  dataTextureRows,
  dataTextureSize,
} from "../render/FXDataTexture.Internal.js";
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

/** A data texture of the table's texels (see `FXDataTexture.Internal`), which the kernel reads by
 *  index. */
function uploadSurfaceTexture(
  renderer: WebGLRenderer,
  gl: WebGL2RenderingContext,
  table: FXSurfaceTable,
): WebGLTexture {
  const size = dataTextureSize(gl, table.texels, "FXSurfaceTexture: a surface");
  const texture = createDataTexture(gl, gl.RGBA32F, size);
  for (const rows of dataTextureRows(table.texels, size)) {
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      rows.y,
      rows.width,
      rows.height,
      gl.RGBA,
      gl.FLOAT,
      table.data,
      rows.first * FX_SURFACE_TEXEL_FLOATS,
    );
  }
  // Built outside the world's tick, possibly right before a draw.
  renderer.resetState();
  return texture;
}

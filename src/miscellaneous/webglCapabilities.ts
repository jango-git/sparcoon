/**
 * Checks sRGB support
 */
function checkSRGBSupportInternal(): boolean {
  const canvasElement = document.createElement("canvas");
  const gl = canvasElement.getContext("webgl2") ?? canvasElement.getContext("webgl");
  if (!gl) {
    return false;
  }

  if (gl instanceof WebGL2RenderingContext) {
    try {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.SRGB8_ALPHA8, 2, 2);
      const errorCode = gl.getError();
      gl.deleteTexture(texture);
      return errorCode === gl.NO_ERROR;
    } catch {
      return false;
    }
  }

  const extension = gl.getExtension("EXT_sRGB");
  if (!extension) {
    return false;
  }

  try {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      extension.SRGB_ALPHA_EXT,
      2,
      2,
      0,
      extension.SRGB_ALPHA_EXT,
      gl.UNSIGNED_BYTE,
      null,
    );
    const errorCode = gl.getError();
    gl.deleteTexture(texture);
    return errorCode === gl.NO_ERROR;
  } catch {
    return false;
  }
}

let SRGB_SUPPORTED_INTERNAL: boolean | undefined;

export const checkSRGBSupport = (): boolean => {
  SRGB_SUPPORTED_INTERNAL ??= checkSRGBSupportInternal();
  return SRGB_SUPPORTED_INTERNAL;
};

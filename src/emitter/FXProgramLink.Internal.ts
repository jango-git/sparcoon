/**
 * @internal Compiles and links a raw WebGL2 program, capturing `feedbackVaryings` interleaved
 * (in that order) when there are any.
 * @param errorPrefix - Who asks, prefixed to the error.
 * @throws When a shader fails to compile or the program fails to link.
 */
export function linkProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
  feedbackVaryings: readonly string[],
  errorPrefix: string,
): WebGLProgram {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource, errorPrefix);
  let fragmentShader: WebGLShader;
  try {
    fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource, errorPrefix);
  } catch (error) {
    // compileShader deletes only the shader it failed on.
    gl.deleteShader(vertexShader);
    throw error;
  }
  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  if (feedbackVaryings.length > 0) {
    // Must be called before linking (WebGL2 spec).
    gl.transformFeedbackVaryings(program, [...feedbackVaryings], gl.INTERLEAVED_ATTRIBS);
  }
  gl.linkProgram(program);
  // Shaders are safe to delete once linked - GL keeps them alive by refcount until the program
  // itself is deleted, regardless of link success.
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`${errorPrefix}: program failed to link: ${info ?? ""}`);
  }
  return program;
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
  errorPrefix: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (shader === null) {
    throw new Error(`${errorPrefix}: gl.createShader() failed`);
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`${errorPrefix}: shader failed to compile: ${info ?? ""}`);
  }
  return shader;
}

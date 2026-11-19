/**
 * The limits read so far, per context. A limit is fixed for a context's lifetime and survives its
 * loss: a restored context is the same GPU.
 */
const limitsByContext = new WeakMap<WebGL2RenderingContext, Map<number, number>>();

/**
 * @internal The GPU limit `name` (a `MAX_*` enum) of `gl`, read from the context once. A query may
 * wait for every command sent before it, a program still building among them, so each limit is
 * asked once per context instead of once per emitter.
 */
export function gpuLimit(gl: WebGL2RenderingContext, name: number): number {
  let limits = limitsByContext.get(gl);
  if (limits === undefined) {
    limits = new Map();
    limitsByContext.set(gl, limits);
  }
  let limit = limits.get(name);
  if (limit === undefined) {
    limit = gl.getParameter(name) as number;
    limits.set(name, limit);
  }
  return limit;
}

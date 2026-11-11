import type { WebGLRenderer } from "three";

// A raw `gl.bindVertexArray()` leaves three's VAO cache stale, and `resetState()` is the only public
// way to correct it. Nothing draws between two transform-feedback passes of one tick, so the reset
// is owed once per renderer per tick, not once per pass. Renderers are shared by every world, so the
// set is too.
const owing = new Set<WebGLRenderer>();

/** @internal Marks `renderer`'s three state stale until {@link flushStateResets}. */
export function deferStateReset(renderer: WebGLRenderer): void {
  owing.add(renderer);
}

/** @internal Resets every renderer marked since the last flush; call before anything draws. */
export function flushStateResets(): void {
  for (const renderer of owing) {
    renderer.resetState();
  }
  owing.clear();
}

import type { Camera, Object3D, WebGLRenderer } from "three";

// Three r158 added `compileAsync` and the target scene together; the peer range still admits r157,
// whose `@types/three` this package builds against.
type FXCompileAsync = (
  object: Object3D,
  camera: Camera,
  targetScene: Object3D | null,
) => Promise<Object3D>;

/** @internal Compiles every material under `object`, lit by `scene`; resolves once they are ready. */
export async function compilePrograms(
  renderer: WebGLRenderer,
  object: Object3D,
  camera: Camera,
  scene: Object3D | undefined,
): Promise<void> {
  const compileAsync = (renderer as { compileAsync?: FXCompileAsync }).compileAsync;
  if (compileAsync === undefined) {
    // r157: no target scene, so `object` must already be in `scene`; nothing to await either.
    renderer.compile(scene ?? object, camera);
    return;
  }
  await compileAsync.call(renderer, object, camera, scene ?? null);
}

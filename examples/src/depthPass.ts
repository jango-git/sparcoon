import {
  type Camera,
  DepthTexture,
  type Object3D,
  type Scene,
  type WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { fxSetCameraDepth } from "sparcoon";

/** The depth of the scene without the effects, which soft particles and collisions with the scene
 *  read. See "Scene depth" in the runtime's README. */
export class DepthPass {
  private readonly target: WebGLRenderTarget;

  public constructor(camera: Camera) {
    const depthTexture = new DepthTexture(1, 1);
    this.target = new WebGLRenderTarget(1, 1, { depthTexture });
    fxSetCameraDepth(camera, depthTexture);
  }

  public setSize(width: number, height: number): void {
    this.target.setSize(width, height);
  }

  public render(renderer: WebGLRenderer, scene: Scene, camera: Camera, effects: Object3D): void {
    effects.visible = false;
    renderer.setRenderTarget(this.target);
    renderer.render(scene, camera);
    effects.visible = true;
    renderer.setRenderTarget(null);
  }
}

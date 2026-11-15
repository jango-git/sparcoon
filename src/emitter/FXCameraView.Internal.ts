import type { Camera } from "three";
import { Matrix4 } from "three";

/**
 * @internal The view a camera's depth was drawn from, for a simulation reading that depth. Taken
 * after a tick, when the host has moved the camera for the frame it renders next - the frame
 * whose depth the next tick reads - so the depth and the matrices always come from one frame.
 */
export class FXCameraView {
  /** The camera of the last capture; `undefined` before the first. */
  public camera: Camera | undefined = undefined;
  public readonly viewProjection = new Matrix4();
  public readonly inverseViewProjection = new Matrix4();

  public capture(camera: Camera): void {
    // The host may have moved the camera since three last updated its matrices.
    camera.updateWorldMatrix(true, false);
    this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.inverseViewProjection.copy(this.viewProjection).invert();
    this.camera = camera;
  }
}

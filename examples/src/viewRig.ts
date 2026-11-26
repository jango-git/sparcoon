import { type PerspectiveCamera, Vector3 } from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

/** Where the camera starts for an effect, relative to the effect's position. */
export interface View {
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
  /** Vertical field of view in degrees. */
  readonly fov: number;
}

/** The aspect ratio the views were set for. */
const VIEW_ASPECT = 16 / 10;

/**
 * How far a canvas narrower than {@link VIEW_ASPECT} moves the camera back: 1 keeps the view's
 * width in sight, 0 its height. Between them the effect stays large on a phone held upright.
 */
const NARROW_BACK_OFF = 0.6;

/** The camera the visitor orbits around an effect. */
export class ViewRig {
  private readonly controls: OrbitControls;

  public constructor(
    private readonly camera: PerspectiveCamera,
    element: HTMLElement,
  ) {
    this.controls = new OrbitControls(camera, element);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.enableZoom = false;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.05;
  }

  /** Puts the camera where `view` says around `origin` and returns its distance to the target. */
  public frame(view: View, origin: Vector3): number {
    const target = new Vector3(...view.target).add(origin);
    const offset = new Vector3(...view.position).sub(new Vector3(...view.target));
    if (this.camera.aspect < VIEW_ASPECT) {
      offset.multiplyScalar((VIEW_ASPECT / this.camera.aspect) ** NARROW_BACK_OFF);
    }
    const distance = offset.length();
    this.camera.fov = view.fov;
    this.camera.updateProjectionMatrix();
    this.camera.position.copy(target).add(offset);
    this.controls.target.copy(target);
    this.controls.update();
    return distance;
  }

  /** Moves the camera with an effect that moved by `offset`, keeping the visitor's orbit. */
  public follow(offset: Vector3): void {
    this.camera.position.add(offset);
    this.controls.target.add(offset);
  }

  public update(): void {
    this.controls.update();
  }
}

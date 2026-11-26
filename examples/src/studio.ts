import {
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  PlaneGeometry,
  Scene,
} from "three";

const BACKGROUND = 0x0b0d14;

/** The editor preview's surroundings: a sun with shadows, a sky fill, and a ground or the scene an
 *  effect plays in. */
export class Studio {
  public readonly scene = new Scene();
  private readonly ground: Mesh;
  private shownScene: Object3D | undefined;

  public constructor() {
    this.scene.background = new Color(BACKGROUND);

    const sun = new DirectionalLight(0xffffff, 2.2);
    // Azimuth 45 and elevation 50 degrees, as the editor places it.
    sun.position.set(0.455, 0.766, 0.455).multiplyScalar(14);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -10, right: 10, top: 10, bottom: -10, far: 40 });
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;
    this.scene.add(sun, new HemisphereLight(0xbcc7d6, 0x2b2620, 0.7));

    this.ground = new Mesh(
      new PlaneGeometry(400, 400),
      new MeshStandardMaterial({ color: 0x2c2f36, roughness: 1 }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -0.025;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
  }

  /**
   * Shows `surroundings` in place of the ground, or the ground when `ground` is true, or neither.
   * Fog starting at `fadeFrom`, the distance to the point the camera looks at, fades them into the
   * background long before their edge.
   */
  public surround(surroundings: Object3D | undefined, ground: boolean, fadeFrom: number): void {
    if (this.shownScene !== surroundings) {
      if (this.shownScene !== undefined) {
        this.scene.remove(this.shownScene);
      }
      if (surroundings !== undefined) {
        this.scene.add(surroundings);
      }
      this.shownScene = surroundings;
    }
    this.ground.visible = surroundings === undefined && ground;
    this.scene.fog =
      surroundings !== undefined || ground ? new Fog(BACKGROUND, fadeFrom, fadeFrom * 1.8) : null;
  }
}

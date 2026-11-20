import {
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Scene,
} from "three";

const BACKGROUND = 0x0b0d14;

/** The editor preview's surroundings: a sun with shadows, a sky fill and a ground. */
export class Studio {
  public readonly scene = new Scene();
  private readonly ground: Mesh;

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
   * Shows or hides the ground. Fog starting at `fadeFrom`, the distance to the point the camera
   * looks at, fades the ground into the background long before its edge.
   */
  public setGround(visible: boolean, fadeFrom: number): void {
    this.ground.visible = visible;
    this.scene.fog = visible ? new Fog(BACKGROUND, fadeFrom, fadeFrom * 1.8) : null;
  }
}

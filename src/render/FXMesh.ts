import {
  Mesh,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type Material,
  type Texture,
} from "three";
import type { FXRenderArtifact } from "../artifact/FXArtifact.js";
import { FXObjectMotionTracker } from "../emitter/FXObjectMotion.Internal.js";
import { resolveGeometrySource } from "../instancedParticle/primitiveGeometry.js";
import { FXWorld } from "../world/FXWorld.js";
import { FXMeshMaterial } from "./FXMeshMaterial.js";

/** Options for {@link FXMesh.fromArtifact}. */
export interface FXFromMeshArtifactOptions {
  /** External textures by slot name (a `{ type: "sampler2D", external }` uniform binds from here). */
  readonly textures?: Readonly<Record<string, Texture>>;
  /** Custom geometries by name, resolving a `{ type: "custom", external }` geometry source. */
  readonly geometries?: Readonly<Record<string, BufferGeometry>>;
  /** Cast a shape-aware shadow (builds a depth material from the render artifact). default false */
  readonly castShadow?: boolean;
  /** Receive shadows. default false */
  readonly receiveShadow?: boolean;
}

/**
 * A single, non-instanced VFX mesh built from one precompiled render artifact - the mesh twin of
 * {@link FXEmitter}. Extends `THREE.Mesh`, so the host adds it to its own scene; it self-subscribes
 * to an {@link FXWorld} on construction and unsubscribes on {@link destroy}, so one
 * {@link FXWorld.update} per frame drives it alongside every emitter. Each tick pushes the shared
 * clock and the mesh's world-space velocity/angular velocity, so a render graph reading the
 * object-velocity/object-angular-velocity builtins works without the host tracking motion by hand.
 *
 * Not exported from the main package (the runtime path is running whole projects through
 * {@link FXEffect}); reached through the `sparcoon/editor` entry, for editor live preview and
 * similar tooling that renders one artifact-driven mesh at a time.
 */
export class FXMesh extends Mesh {
  private readonly world: FXWorld;
  private readonly driver: FXMeshMaterial;
  private readonly motionTracker = new FXObjectMotionTracker();
  // A built-in primitive is ours to dispose; an app-supplied custom geometry is the caller's.
  private readonly ownsGeometry: boolean;
  // The depth material we built for a shadow caster (undefined when not casting), kept so `destroy`
  // can free it without reading the loosely typed inherited `customDepthMaterial`.
  private readonly depthMaterial?: Material;

  // Reused decompose scratch (avoids a per-tick allocation); scale is discarded.
  private readonly motionPositionScratch = new Vector3();
  private readonly motionQuaternionScratch = new Quaternion();
  private readonly motionScaleScratch = new Vector3();

  private destroyed = false;

  private constructor(
    geometry: BufferGeometry,
    driver: FXMeshMaterial,
    threeMaterial: Material,
    depthMaterial: Material | undefined,
    ownsGeometry: boolean,
    world: FXWorld,
  ) {
    super(geometry, threeMaterial);
    this.driver = driver;
    this.ownsGeometry = ownsGeometry;
    this.world = world;
    if (depthMaterial !== undefined) {
      this.depthMaterial = depthMaterial;
      this.castShadow = true;
      this.customDepthMaterial = depthMaterial;
    }
    this.world.registerObject(this);
  }

  /** Builds a mesh into `world` from a precompiled render artifact. */
  public static fromArtifact(
    render: FXRenderArtifact,
    options: FXFromMeshArtifactOptions = {},
    world: FXWorld = FXWorld.getDefault(),
  ): FXMesh {
    const driver = new FXMeshMaterial(render, options.textures);
    const geometry = resolveGeometrySource(render.geometry, options.geometries ?? {});
    const ownsGeometry = render.geometry === undefined || render.geometry.type === "primitive";
    const depthMaterial = (options.castShadow ?? false)
      ? driver.buildThreeDepthMaterial()
      : undefined;
    const mesh = new FXMesh(
      geometry,
      driver,
      driver.buildThreeMaterial(),
      depthMaterial,
      ownsGeometry,
      world,
    );
    if (options.receiveShadow ?? false) {
      mesh.receiveShadow = true;
    }
    return mesh;
  }

  /** @internal Driven by {@link FXWorld.update}. */
  public onWorldTick(deltaTime: number, elapsedTime: number): void {
    this.updateWorldMatrix(true, false);
    this.matrixWorld.decompose(
      this.motionPositionScratch,
      this.motionQuaternionScratch,
      this.motionScaleScratch,
    );
    const motion = this.motionTracker.sample(
      {
        position: [
          this.motionPositionScratch.x,
          this.motionPositionScratch.y,
          this.motionPositionScratch.z,
        ],
        quaternion: [
          this.motionQuaternionScratch.x,
          this.motionQuaternionScratch.y,
          this.motionQuaternionScratch.z,
          this.motionQuaternionScratch.w,
        ],
      },
      deltaTime,
    );
    this.driver.setElapsedTime(elapsedTime);
    this.driver.setDeltaTime(deltaTime);
    this.driver.setObjectVelocity(motion.velocity);
    this.driver.setObjectAngularVelocity(motion.angularVelocity);
  }

  /** Scrubs live uniform values by name (picked up next frame). Unknown name = safe no-op. */
  public applyValues(values: Readonly<Record<string, number | readonly number[] | Texture>>): void {
    if (this.destroyed) {
      return;
    }
    this.driver.applyUniformValues(values);
  }

  /**
   * Unsubscribes from its world and disposes GPU resources (the mounted material, its depth
   * material, and a built-in primitive geometry - never an app-supplied custom one). Idempotent.
   */
  public destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.world.unregisterObject(this);
    if (this.ownsGeometry) {
      this.geometry.dispose();
    }
    (this.material as Material).dispose();
    if (this.depthMaterial !== undefined) {
      this.depthMaterial.dispose();
    }
    this.removeFromParent();
  }
}

import type { Material, Texture } from "three";
import type { FXRenderArtifact, FXValueSlot } from "../artifact/FXArtifact.js";
import {
  buildMeshArtifactDepthMaterial,
  buildMeshArtifactMaterial,
} from "./FXArtifactMaterial.Internal.js";
import type { FXFrameTimeUniform, FXFrameVec3Uniform } from "./FXArtifactMaterial.Internal.js";

/**
 * Runtime material driver for a **VFX mesh**: the mesh twin of {@link FXArtifactMaterial}. Wraps a
 * precompiled {@link FXRenderArtifact} (compiled against the mesh render target) and builds a
 * self-contained `ShaderMaterial` for a single, non-instanced `THREE.Mesh`. Unlike the particle
 * driver it takes no per-particle `varyings` - a VFX mesh has no simulation and no attributes. The
 * host builds the material once and pushes the shared clock each frame.
 */
export class FXMeshMaterial {
  private readonly elapsedTime: FXFrameTimeUniform = { value: 0 };
  private readonly deltaTime: FXFrameTimeUniform = { value: 0 };
  private readonly velocity: FXFrameVec3Uniform = { value: [0, 0, 0] };
  private readonly angularVelocity: FXFrameVec3Uniform = { value: [0, 0, 0] };

  // Durable per-mesh slots for `external` texture uniforms: an external uniform resolves per mesh, so
  // it binds its own live-scrubbable slot (non-external uniforms bind the shared artifact slot).
  private readonly externalSlots: Record<string, FXValueSlot<Texture>> = {};

  /**
   * @param textures - App-supplied external textures by slot name. A missing one fails fast here
   * rather than surfacing as a blank sampler at draw time.
   */
  constructor(
    private readonly artifact: FXRenderArtifact,
    textures: Readonly<Record<string, Texture>> = {},
  ) {
    for (const name in artifact.uniforms) {
      const uniform = artifact.uniforms[name];
      if ("external" in uniform) {
        if (!(uniform.external in textures)) {
          throw new Error(
            `FXMeshMaterial: no texture supplied for external slot "${uniform.external}" ` +
              `(uniform "${name}"); pass it via the mesh host's textures`,
          );
        }
        this.externalSlots[name] = { value: textures[uniform.external] };
      }
    }
  }

  public buildThreeMaterial(): Material {
    return buildMeshArtifactMaterial(
      this.artifact,
      this.elapsedTime,
      this.deltaTime,
      this.velocity,
      this.angularVelocity,
      this.externalSlots,
    );
  }

  /**
   * The `customDepthMaterial` for casting shadows: the mesh twin of
   * {@link FXArtifactMaterial.buildThreeDepthMaterial}. The mesh host attaches it on the `Mesh` only
   * when the mesh opts into `castShadow`.
   */
  public buildThreeDepthMaterial(): Material {
    return buildMeshArtifactDepthMaterial(
      this.artifact,
      this.elapsedTime,
      this.deltaTime,
      this.velocity,
      this.angularVelocity,
      this.externalSlots,
    );
  }

  public setElapsedTime(seconds: number): void {
    this.elapsedTime.value = seconds;
  }

  public setDeltaTime(seconds: number): void {
    this.deltaTime.value = seconds;
  }

  public setObjectVelocity(velocity: readonly [number, number, number]): void {
    this.velocity.value = velocity;
  }

  public setObjectAngularVelocity(angularVelocity: readonly [number, number, number]): void {
    this.angularVelocity.value = angularVelocity;
  }

  /**
   * Applies a value edit (a rebind, no rebuild). A non-external uniform mutates its shared artifact
   * slot; an external uniform mutates this mesh's own slot. Unknown name = no-op (an editor<->runtime
   * name drift never corrupts values).
   */
  public applyUniformValues(
    values: Readonly<Record<string, number | readonly number[] | Texture>>,
  ): void {
    for (const name in values) {
      const value = values[name];
      if (name in this.externalSlots) {
        this.externalSlots[name].value = value as Texture;
      } else if (name in this.artifact.uniforms) {
        (this.artifact.uniforms[name] as FXValueSlot<number | readonly number[] | Texture>).value =
          value;
      }
    }
  }

  // No-op: the artifact owns no per-mesh resources (generated textures are module-scoped; external
  // textures are app-owned).
  public destroy(): void {}
}

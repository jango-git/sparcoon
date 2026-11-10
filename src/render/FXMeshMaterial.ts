import type { Material } from "three";
import type { FXRenderArtifact } from "../artifact/FXArtifact.js";
import {
  applyArtifactUniformValues,
  buildMeshArtifactDepthMaterial,
  buildMeshArtifactMaterial,
} from "./FXArtifactMaterial.Internal.js";
import { createExternalTextureBindings } from "./FXExternalTexture.Internal.js";
import type { FXExternalTextureBindings } from "./FXExternalTexture.Internal.js";
import type { FXExternalTexture, FXUniformValue } from "./FXExternalTexture.js";
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
  private readonly externalSlots: FXExternalTextureBindings;

  /**
   * @param textures - App-supplied external textures by slot name. A missing one fails fast here
   * rather than surfacing as a blank sampler at draw time.
   */
  constructor(
    private readonly artifact: FXRenderArtifact,
    textures: Readonly<Record<string, FXExternalTexture>> = {},
  ) {
    this.externalSlots = createExternalTextureBindings(
      artifact,
      textures,
      "FXMeshMaterial",
      "pass it via the mesh host's textures",
    );
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
   * @throws When an external texture is of a variant its slot was not built with; nothing is
   * written then.
   */
  public applyUniformValues(values: Readonly<Record<string, FXUniformValue>>): void {
    applyArtifactUniformValues(this.artifact, this.externalSlots, values);
  }

  // No-op: the artifact owns no per-mesh resources (generated textures are module-scoped; external
  // textures are app-owned).
  public destroy(): void {}
}

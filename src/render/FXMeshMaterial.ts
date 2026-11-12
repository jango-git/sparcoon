import type { Material } from "three";
import type { FXRenderArtifact } from "../artifact/FXArtifact.js";
import type { FXDrawInputs } from "./FXDrawInputs.js";
import {
  advanceMaterialSlots,
  applyArtifactUniformValues,
  buildMeshArtifactDepthMaterial,
  buildMeshArtifactMaterial,
  createMaterialSlots,
} from "./FXArtifactMaterial.Internal.js";
import type { FXMaterialSlots } from "./FXArtifactMaterial.Internal.js";
import { createExternalTextureBindings } from "./FXExternalTexture.Internal.js";
import type { FXExternalTexture, FXUniformValue } from "./FXExternalTexture.js";

/**
 * Runtime material driver for a **VFX mesh**: the mesh twin of {@link FXArtifactMaterial}. Wraps a
 * precompiled {@link FXRenderArtifact} (compiled against the mesh render target) and builds a
 * self-contained `ShaderMaterial` for a single, non-instanced `THREE.Mesh`. Unlike the particle
 * driver it takes no per-particle `varyings` - a VFX mesh has no simulation and no attributes. The
 * host builds the material once and pushes the shared clock each frame.
 */
export class FXMeshMaterial {
  // This mesh's own live slots, bound by reference into both of its materials.
  private readonly slots: FXMaterialSlots;

  /**
   * @param textures - App-supplied external textures by slot name. A missing one fails fast here
   * rather than surfacing as a blank sampler at draw time.
   */
  constructor(
    private readonly artifact: FXRenderArtifact,
    textures: Readonly<Record<string, FXExternalTexture>> = {},
  ) {
    this.slots = createMaterialSlots(
      artifact,
      createExternalTextureBindings(
        artifact,
        textures,
        "FXMeshMaterial",
        "pass it via the mesh host's textures",
      ),
    );
  }

  public buildThreeMaterial(): Material {
    return buildMeshArtifactMaterial(this.artifact, this.slots);
  }

  /**
   * The `customDepthMaterial` for casting shadows: the mesh twin of
   * {@link FXArtifactMaterial.buildThreeDepthMaterial}. The mesh host attaches it on the `Mesh` only
   * when the mesh opts into `castShadow`.
   */
  public buildThreeDepthMaterial(): Material {
    return buildMeshArtifactDepthMaterial(this.artifact, this.slots);
  }

  /**
   * This tick's draw inputs: the clock and motion the shaders read, and the artifact's draw stage
   * (when it has one) computed from them into this instance's draw uniforms.
   */
  public advance(frame: FXDrawInputs): void {
    advanceMaterialSlots(this.slots, this.artifact, frame);
  }

  /**
   * Applies a value edit (a rebind, no rebuild) to this mesh's own slots, never the artifact.
   * Unknown name = no-op (an editor<->runtime name drift never corrupts values).
   * @throws When an external texture is of a variant its slot was not built with; nothing is
   * written then.
   */
  public applyUniformValues(values: Readonly<Record<string, FXUniformValue>>): void {
    applyArtifactUniformValues(this.slots, values);
  }

  // No-op: the artifact owns no per-mesh resources (generated textures are module-scoped; external
  // textures are app-owned).
  public destroy(): void {}
}

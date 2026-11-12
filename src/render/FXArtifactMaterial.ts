import type { Material, ShaderMaterial } from "three";

import type { FXRenderArtifact } from "../artifact/FXArtifact.js";
import type {
  FXMaterialSlots,
  FXParticleLayout,
  FXTrailLayout,
  FXTrailUniforms,
} from "./FXArtifactMaterial.Internal.js";
import {
  advanceMaterialSlots,
  applyArtifactUniformValues,
  assertArtifactUniformValues,
  buildArtifactDepthMaterial,
  buildArtifactMaterial,
  buildTrailArtifactMaterial,
  createMaterialSlots,
} from "./FXArtifactMaterial.Internal.js";
import type { FXDrawInputs } from "./FXDrawInputs.js";
import { createExternalTextureBindings } from "./FXExternalTexture.Internal.js";
import type { FXExternalTexture, FXUniformValue } from "./FXExternalTexture.js";

/**
 * @internal Runtime material driver: wraps a precompiled {@link FXRenderArtifact} and builds the
 * concrete self-contained `ShaderMaterial` via {@link buildArtifactMaterial}, which picks the flat or
 * lit variant from the artifact's lighting capability ({@link FXRenderArtifact.lightingIntrinsics}).
 * The emitter owns one, calls {@link buildThreeMaterial} once, and pushes the shared clock each frame.
 */
export class FXArtifactMaterial {
  // This emitter's own live slots, bound by reference into every material it builds.
  private readonly slots: FXMaterialSlots;

  /**
   * @param textures - App-supplied external textures by slot name. A missing one fails fast here
   * rather than surfacing as a blank sampler at draw time.
   */
  constructor(
    /** The artifact the materials are built from - what `particleLayout` reads it by. */
    public readonly artifact: FXRenderArtifact,
    textures: Readonly<Record<string, FXExternalTexture>> = {},
  ) {
    this.slots = createMaterialSlots(
      artifact,
      createExternalTextureBindings(
        artifact,
        textures,
        "FXArtifactMaterial",
        "pass it via FXEmitter.fromArtifacts({ textures })",
      ),
    );
  }

  /** The particle material over a mesh of `layout` (its driver's, see `particleLayout`). */
  public buildThreeMaterial(layout: FXParticleLayout): Material {
    return buildArtifactMaterial(this.artifact, layout, this.slots);
  }

  /**
   * The `customDepthMaterial` for casting shadows: the same artifact IR spliced into a depth-packing
   * material, so the shadow silhouette honors the authored shape/alpha-cutout (see
   * {@link buildArtifactDepthMaterial}). Built only when the emitter opts into `castShadow`.
   */
  public buildThreeDepthMaterial(layout: FXParticleLayout): Material {
    return buildArtifactDepthMaterial(this.artifact, layout, this.slots);
  }

  /** The trail material over a history of `layout` (see {@link buildTrailArtifactMaterial}). */
  public buildThreeTrailMaterial(
    layout: FXTrailLayout,
    trailUniforms: FXTrailUniforms,
  ): ShaderMaterial {
    return buildTrailArtifactMaterial(this.artifact, layout, this.slots, trailUniforms);
  }

  /**
   * This tick's draw inputs: the clock and motion the shaders read, and the artifact's draw stage
   * (when it has one) computed from them into this instance's draw uniforms.
   */
  public advance(frame: FXDrawInputs): void {
    advanceMaterialSlots(this.slots, this.artifact, frame);
  }

  /**
   * Throws when {@link applyUniformValues} would reject `values` (an external texture of a variant
   * its slot was not built with); writes nothing. Lets the emitter check its particle and trail
   * materials both before either changes.
   */
  public assertUniformValues(values: Readonly<Record<string, FXUniformValue>>): void {
    assertArtifactUniformValues(this.slots, values);
  }

  /**
   * Render half of {@link FXEmitter.applyValues}: writes this emitter's own slots, never the
   * artifact. Unknown name = no-op.
   * @throws See {@link assertUniformValues}; nothing is written then.
   */
  public applyUniformValues(values: Readonly<Record<string, FXUniformValue>>): void {
    applyArtifactUniformValues(this.slots, values);
  }

  // No-op: the artifact owns no per-emitter resources. Generated textures are module-scoped and
  // shared (see the `fromArtifacts` texture-ownership contract); external textures are app-owned.
  public destroy(): void {}
}

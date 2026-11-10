import type { Material, ShaderMaterial } from "three";
import type { FXAttributeDecl, FXRenderArtifact } from "../artifact/FXArtifact.js";
import {
  applyArtifactUniformValues,
  assertArtifactUniformValues,
  buildArtifactDepthMaterial,
  buildArtifactMaterial,
  buildTrailArtifactMaterial,
} from "./FXArtifactMaterial.Internal.js";
import { createExternalTextureBindings } from "./FXExternalTexture.Internal.js";
import type { FXExternalTextureBindings } from "./FXExternalTexture.Internal.js";
import type { FXExternalTexture, FXUniformValue } from "./FXExternalTexture.js";
import type {
  FXFrameTimeUniform,
  FXFrameVec3Uniform,
  FXParticleLayout,
  FXTrailLayout,
  FXTrailUniforms,
} from "./FXArtifactMaterial.Internal.js";

/**
 * @internal Runtime material driver: wraps a precompiled {@link FXRenderArtifact} and builds the
 * concrete self-contained `ShaderMaterial` via {@link buildArtifactMaterial}, which picks the flat or
 * lit variant from the artifact's lighting capability ({@link FXRenderArtifact.lightingIntrinsics}).
 * The emitter owns one, calls {@link buildThreeMaterial} once, and pushes the shared clock each frame.
 */
export class FXArtifactMaterial {
  private readonly elapsedTime: FXFrameTimeUniform = { value: 0 };
  private readonly deltaTime: FXFrameTimeUniform = { value: 0 };
  private readonly velocity: FXFrameVec3Uniform = { value: [0, 0, 0] };
  private readonly angularVelocity: FXFrameVec3Uniform = { value: [0, 0, 0] };

  // Durable per-emitter slots for `external` texture uniforms. Unlike non-external uniforms (which
  // bind the shared artifact slot directly), an external uniform resolves per emitter, so it gets
  // its own slot here - and that slot is what gets bound, keeping it live-scrubbable.
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
      "FXArtifactMaterial",
      "pass it via FXEmitter.fromArtifacts({ textures })",
    );
  }

  public get attributeReads(): readonly FXAttributeDecl[] {
    return this.artifact.attributeReads;
  }

  /** The particle material over a mesh of `layout` (its driver's, see `particleLayout`). */
  public buildThreeMaterial(layout: FXParticleLayout): Material {
    return buildArtifactMaterial(
      this.artifact,
      layout,
      this.elapsedTime,
      this.deltaTime,
      this.velocity,
      this.angularVelocity,
      this.externalSlots,
    );
  }

  /**
   * The `customDepthMaterial` for casting shadows: the same artifact IR spliced into a depth-packing
   * material, so the shadow silhouette honors the authored shape/alpha-cutout (see
   * {@link buildArtifactDepthMaterial}). Built only when the emitter opts into `castShadow`.
   */
  public buildThreeDepthMaterial(layout: FXParticleLayout): Material {
    return buildArtifactDepthMaterial(
      this.artifact,
      layout,
      this.elapsedTime,
      this.deltaTime,
      this.velocity,
      this.angularVelocity,
      this.externalSlots,
    );
  }

  /** The trail material over a history of `layout` (see {@link buildTrailArtifactMaterial}). */
  public buildThreeTrailMaterial(
    layout: FXTrailLayout,
    trailUniforms: FXTrailUniforms,
  ): ShaderMaterial {
    return buildTrailArtifactMaterial(
      this.artifact,
      layout,
      this.elapsedTime,
      this.deltaTime,
      this.velocity,
      this.angularVelocity,
      trailUniforms,
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
   * Throws when {@link applyUniformValues} would reject `values` (an external texture of a variant
   * its slot was not built with); writes nothing. Lets the emitter check its particle and trail
   * materials both before either changes.
   */
  public assertUniformValues(values: Readonly<Record<string, FXUniformValue>>): void {
    assertArtifactUniformValues(this.externalSlots, values);
  }

  /**
   * Render half of {@link FXEmitter.applyValues}. A non-external uniform mutates its shared artifact
   * slot (module-scoped); an external uniform mutates this emitter's own slot. Unknown name = no-op.
   * @throws See {@link assertUniformValues}; nothing is written then.
   */
  public applyUniformValues(values: Readonly<Record<string, FXUniformValue>>): void {
    applyArtifactUniformValues(this.artifact, this.externalSlots, values);
  }

  // No-op: the artifact owns no per-emitter resources. Generated textures are module-scoped and
  // shared (see the `fromArtifacts` texture-ownership contract); external textures are app-owned.
  public destroy(): void {}
}

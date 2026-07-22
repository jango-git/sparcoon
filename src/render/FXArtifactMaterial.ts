import type { Material, Texture } from "three";
import type { FXAttributeDecl, FXRenderArtifact, FXValueSlot } from "../artifact/FXArtifact.js";
import type { GLTypeInfo } from "../instancedParticle/glTypeInfo.js";
import {
  buildArtifactDepthMaterial,
  buildArtifactMaterial,
} from "./FXArtifactMaterial.Internal.js";
import type { FXFrameTimeUniform, FXFrameVec3Uniform } from "./FXArtifactMaterial.Internal.js";

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
            `FXArtifactMaterial: no texture supplied for external slot "${uniform.external}" ` +
              `(uniform "${name}"); pass it via FXEmitter.fromArtifacts({ textures })`,
          );
        }
        this.externalSlots[name] = { value: textures[uniform.external] };
      }
    }
  }

  public get attributeReads(): readonly FXAttributeDecl[] {
    return this.artifact.attributeReads;
  }

  public buildThreeMaterial(varyings: Record<string, GLTypeInfo>): Material {
    return buildArtifactMaterial(
      this.artifact,
      varyings,
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
  public buildThreeDepthMaterial(varyings: Record<string, GLTypeInfo>): Material {
    return buildArtifactDepthMaterial(
      this.artifact,
      varyings,
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
   * Render half of {@link FXEmitter.applyValues}. A non-external uniform mutates its shared artifact
   * slot (module-scoped); an external uniform mutates this emitter's own slot. Unknown name = no-op.
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

  // No-op: the artifact owns no per-emitter resources. Generated textures are module-scoped and
  // shared (see the `fromArtifacts` texture-ownership contract); external textures are app-owned.
  public destroy(): void {}
}

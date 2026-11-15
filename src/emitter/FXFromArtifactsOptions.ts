import type { BufferGeometry, WebGLRenderer } from "three";

import type { FXParticleKernelArtifact, FXRenderArtifact } from "../artifact/FXArtifact.js";
import type { FXExternalTexture } from "../render/FXExternalTexture.js";
import type { FXRibbonOptions } from "../ribbon/FXRibbon.js";
import type { FXTrailOptions } from "../trail/FXTrail.js";
import type { FXEmitterOptions } from "./FXEmitter.Internal.js";

/**
 * Options for {@link FXEmitter.fromArtifacts}: the emitter options plus external textures by slot -
 * a uniform declared `{ type: "sampler2D", external: "<slot>" }` binds from `textures[<slot>]` (a
 * whole `Texture`, or a {@link FXTextureRegion} of one) -
 * and custom geometries by name, resolving a `{ type: "custom", external: "<name>" }` geometry
 * source from `geometries[<name>]` and every mesh surface the behavior samples (`meshSurfaces`,
 * required: a missing one throws). The app owns both maps' lifecycle; the runtime never disposes
 * them. A surface is read from its geometry when the emitter is built; a geometry whose attributes
 * changed since is read anew by the next emitter built from it.
 */
export interface FXFromArtifactsOptions extends Partial<FXEmitterOptions> {
  /**
   * The render artifact the particles are drawn with. Without one they are simulated but not
   * drawn - for an emitter shown only by its trail or ribbon. Not with `sort`, and its shadows
   * (`castShadow`, `receiveShadow`) are the particles'.
   */
  readonly particles?: FXRenderArtifact;
  readonly textures?: Record<string, FXExternalTexture>;
  readonly geometries?: Record<string, BufferGeometry>;
  /**
   * The standard-tier (WebGL2, transform-feedback) behavior artifact, present only when the
   * graph's spawn node had "Try GPU simulation" on and the graph compiled to GLSL. `renderer` is
   * required alongside it - without one, or if GPU program setup itself throws (a real
   * driver-level failure), the emitter falls back to the mandatory JS `behavior` artifact in
   * place, never a hard error. `expectedCapacity` is the same fixed ring capacity either way.
   */
  readonly gpuKernel?: FXParticleKernelArtifact;
  readonly renderer?: WebGLRenderer;
  /**
   * A trail behind every particle, drawn from the recorded path of each particle slot - on either
   * backend. Not with `sort`. With `renderer`, a trail whose material takes more of any resource
   * than its GPU offers (a WebGL1 device has 8 attributes) is skipped with a warning - the
   * particles still draw; without one, nothing is checked.
   */
  readonly trail?: FXTrailOptions;
  /**
   * A ribbon through the particles in the order they were born, from each particle to the one born
   * right after it - on either backend. Each birth joins the one before, so a ribbon follows one
   * stream of births: bursts and births from several origins weave it between them. Not with
   * `sort`, and skipped past the GPU's limits as a trail is.
   */
  readonly ribbon?: FXRibbonOptions;
}

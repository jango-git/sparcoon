import type { BufferGeometry, WebGLRenderer } from "three";
import type { FXExternalTexture } from "../render/FXExternalTexture.js";
import type { FXParticleKernelArtifact } from "../artifact/FXArtifact.js";
import type { FXEmitterOptions } from "./FXEmitter.Internal.js";
import type { FXTrailOptions } from "../trail/FXTrail.js";

/**
 * Options for {@link FXEmitter.fromArtifacts}: the emitter options plus external textures by slot -
 * a uniform declared `{ type: "sampler2D", external: "<slot>" }` binds from `textures[<slot>]` (a
 * whole `Texture`, or a {@link FXTextureRegion} of one) -
 * and custom geometries by name, resolving a `{ type: "custom", external: "<name>" }` geometry
 * source from `geometries[<name>]`. The app owns both maps' lifecycle; the runtime never disposes
 * them.
 */
export interface FXFromArtifactsOptions extends Partial<FXEmitterOptions> {
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
   * backend. Sorting is skipped on an emitter with a trail (it would move particles between
   * slots). With `renderer`, a trail whose material takes more vertex attributes or varying
   * vectors than its GPU offers (a WebGL1 device, at 8 attributes) is skipped with a warning -
   * the particles still draw; without one, nothing is checked.
   */
  readonly trail?: FXTrailOptions;
}

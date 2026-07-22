import type { BufferGeometry, Texture, WebGLRenderer } from "three";
import type { FXParticleKernelArtifact } from "../artifact/FXArtifact.js";
import type { FXEmitterOptions } from "./FXEmitter.Internal.js";

/**
 * Options for {@link FXEmitter.fromArtifacts}: the emitter options plus external textures by slot -
 * a uniform declared `{ type: "sampler2D", external: "<slot>" }` binds from `textures[<slot>]` -
 * and custom geometries by name, resolving a `{ type: "custom", external: "<name>" }` geometry
 * source from `geometries[<name>]`. The app owns both maps' lifecycle; the runtime never disposes
 * them.
 */
export interface FXFromArtifactsOptions extends Partial<FXEmitterOptions> {
  readonly textures?: Record<string, Texture>;
  readonly geometries?: Record<string, BufferGeometry>;
  /**
   * The standard-tier (WebGL2, transform-feedback) behavior artifact, present only when the
   * graph's spawn node had "Try GPU simulation" on and the graph compiled to GLSL. `renderer` is
   * required alongside it - without one, or if GPU program setup itself throws (a real
   * driver-level failure), the emitter falls back to the mandatory JS `behavior` artifact in
   * place, never a hard error. `expectedCapacity` becomes this emitter's fixed GPU particle
   * capacity (no growth); `capacityStep` is meaningless for a GPU-driven emitter and is ignored.
   */
  readonly gpuKernel?: FXParticleKernelArtifact;
  readonly renderer?: WebGLRenderer;
}

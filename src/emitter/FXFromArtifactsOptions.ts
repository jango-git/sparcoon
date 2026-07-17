import type { BufferGeometry, Texture } from "three";
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
}

import type { BufferGeometry, Texture } from "three";

/**
 * Options for {@link FXEmitter.applyRenderArtifact}: the render-only subset of
 * {@link FXFromArtifactsOptions} - no `expectedCapacity`/`capacityStep`/`gpuKernel`/`renderer`,
 * since none of those can change without a full {@link FXEmitter.fromArtifacts} rebuild. The app
 * owns `textures`/`geometries`' lifecycle; the runtime never disposes them.
 */
export interface FXApplyRenderArtifactOptions {
  readonly textures?: Record<string, Texture>;
  readonly geometries?: Record<string, BufferGeometry>;
  /** default false */
  readonly receiveShadow?: boolean;
  /** Casts a shape-aware shadow (a customDepthMaterial built from the new render artifact). default false */
  readonly castShadow?: boolean;
}

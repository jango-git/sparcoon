import type { BufferGeometry, Data3DTexture } from "three";

import { type FXSurfaceTable, surfaceTablesOf } from "./FXSurfaceTable.Internal.js";
import { type FXVolumeTable, volumeTablesOf } from "./FXVolumeTable.Internal.js";

/**
 * @internal A table a behavior kernel samples - on the CPU its `data` is a binding of the JS
 * kernel, on the GPU a texture bound to a sampler of the kernel's program.
 */
export type FXKernelResource =
  | { readonly kind: "surface"; readonly table: FXSurfaceTable }
  | { readonly kind: "volume"; readonly table: FXVolumeTable };

/** @internal The resources of a kernel, by the binding or sampler uniform it reads each through. */
export type FXKernelResources = Readonly<Record<string, FXKernelResource>>;

/** @internal What a kernel names its resources by. */
export interface FXKernelResourceNames {
  readonly meshSurfaces?: Readonly<Record<string, string>>;
  readonly volumes?: Readonly<Record<string, string>>;
}

/** @internal The app's assets a kernel's resources are read from. */
export interface FXKernelResourceAssets {
  readonly geometries: Readonly<Record<string, BufferGeometry>>;
  readonly volumes: Readonly<Record<string, Data3DTexture>>;
}

/**
 * @internal The resources `kernel` samples - each mesh surface read from its geometry, each volume
 * from its 3D texture.
 * @throws When one is missing or cannot be read (see `surfaceTablesOf`, `volumeTablesOf`).
 */
export function kernelResourcesOf(
  kernel: FXKernelResourceNames,
  assets: FXKernelResourceAssets,
): FXKernelResources {
  const resources: Record<string, FXKernelResource> = {};
  const surfaces = surfaceTablesOf(kernel.meshSurfaces, assets.geometries);
  for (const binding in surfaces) {
    resources[binding] = { kind: "surface", table: surfaces[binding] };
  }
  const volumes = volumeTablesOf(kernel.volumes, assets.volumes);
  for (const binding in volumes) {
    resources[binding] = { kind: "volume", table: volumes[binding] };
  }
  return resources;
}

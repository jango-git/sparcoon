import type { SkinnedMesh } from "three";

import type { FXKernelResourceField, FXKernelResourceNames } from "../artifact/FXArtifact.js";
import type { FXAppAssets } from "./FXFromArtifactsOptions.js";
import {
  type FXObjectSurface,
  type FXSurfaceTable,
  meshSurfaceOf,
  objectSurfaceOf,
  skinnedSurfaceOf,
} from "./FXSurfaceTable.Internal.js";
import { type FXVolumeTable, volumeTableOf } from "./FXVolumeTable.Internal.js";

/**
 * @internal A table a behavior kernel samples - on the CPU its `data` is a binding of the JS
 * kernel, on the GPU a texture bound to a sampler of the kernel's program. An object surface also
 * reads its object's pose, through the inputs `fxObjectInputNames` names.
 */
export type FXKernelResource =
  | { readonly kind: "surface"; readonly table: FXSurfaceTable }
  | ({ readonly kind: "objectSurface" } & FXObjectSurface)
  | ({ readonly kind: "skinnedSurface" } & FXObjectSurface<SkinnedMesh>)
  | { readonly kind: "volume"; readonly table: FXVolumeTable };

/** @internal The resources of a kernel, by the binding or sampler uniform it reads each through. */
export type FXKernelResources = Readonly<Record<string, FXKernelResource>>;

/** How a kind of resource is read: from which of the app's assets, what the asset is called in an
 *  error, what samples it, and how a resource is made of the asset `name`. */
interface FXResourceKind<A extends keyof FXAppAssets> {
  readonly assets: A;
  readonly noun: string;
  readonly sampler: string;
  read(asset: FXAppAssets[A][string], name: string): FXKernelResource;
}

/** Each kind of resource, by the artifact field naming its assets. A reader throws when the asset
 *  cannot be read (see `meshSurfaceOf`, `objectSurfaceOf`, `skinnedSurfaceOf`, `volumeTableOf`). */
const RESOURCE_KINDS: {
  readonly meshSurfaces: FXResourceKind<"geometries">;
  readonly objectSurfaces: FXResourceKind<"meshes">;
  readonly skinnedSurfaces: FXResourceKind<"meshes">;
  readonly volumes: FXResourceKind<"volumes">;
} = {
  meshSurfaces: {
    assets: "geometries",
    noun: "geometry",
    sampler: "mesh surface",
    read: (geometry, name) => ({ kind: "surface", table: meshSurfaceOf(geometry, name) }),
  },
  objectSurfaces: {
    assets: "meshes",
    noun: "mesh",
    sampler: "object surface",
    read: (mesh, name) => ({ kind: "objectSurface", ...objectSurfaceOf(mesh, name) }),
  },
  skinnedSurfaces: {
    assets: "meshes",
    noun: "mesh",
    sampler: "skinned surface",
    read: (mesh, name) => ({ kind: "skinnedSurface", ...skinnedSurfaceOf(mesh, name) }),
  },
  volumes: {
    assets: "volumes",
    noun: "3D texture",
    sampler: "volume",
    read: (texture, name) => ({ kind: "volume", table: volumeTableOf(texture, name) }),
  },
};

/**
 * @internal The resources `kernel` samples, each read from the app's asset it names.
 * @throws When one is missing or cannot be read.
 */
export function kernelResourcesOf(
  kernel: FXKernelResourceNames,
  assets: FXAppAssets,
): FXKernelResources {
  const resources: Record<string, FXKernelResource> = {};
  for (const field of Object.keys(RESOURCE_KINDS) as FXKernelResourceField[]) {
    const kind = RESOURCE_KINDS[field] as FXResourceKind<keyof FXAppAssets>;
    const names = kernel[field] ?? {};
    for (const binding in names) {
      const name = names[binding];
      const asset = assets[kind.assets][name] as FXAppAssets[keyof FXAppAssets][string] | undefined;
      if (asset === undefined) {
        throw new Error(
          `FXEmitter.fromArtifacts: no ${kind.noun} "${name}" for the ${kind.sampler} it samples`,
        );
      }
      resources[binding] = kind.read(asset, name);
    }
  }
  return resources;
}

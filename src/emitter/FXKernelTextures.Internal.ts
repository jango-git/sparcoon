import type { WebGLRenderer } from "three";

import {
  createDataTexture,
  dataTextureSize,
  uploadDataTexels,
} from "../render/FXDataTexture.Internal.js";
import { FX_BONE_TEXELS, fxObjectInputNames } from "../surfaceTableLayout.js";
import { FXBoneTextureBinding } from "./FXBoneTextureBinding.Internal.js";
import type { FXCameraView } from "./FXCameraView.Internal.js";
import type { FXContextLease } from "./FXContextLeases.Internal.js";
import type { FXKernelResource, FXKernelResources } from "./FXKernelResources.Internal.js";
import type { FXObjectPose, FXObjectPoses } from "./FXObjectPose.Internal.js";
import { FXSceneDepthBinding } from "./FXSceneDepthBinding.Internal.js";
import { acquireSurfaceTexture } from "./FXSurfaceTexture.Internal.js";
import { acquireVolumeTexture } from "./FXVolumeTexture.Internal.js";

/** @internal A texture a built kernel program reads, bound before each pass on its own unit. */
export interface FXTextureBinding {
  bind(renderer: WebGLRenderer, unit: number): void;
}

/**
 * @internal A texture a kernel's program may read, one texture unit each: what it binds in a built
 * program, `undefined` when the program does not read it (compiled away).
 */
export interface FXTextureSource {
  bindingIn(gl: WebGL2RenderingContext, program: WebGLProgram): FXTextureBinding | undefined;
  release(): void;
}

/**
 * @internal The textures of a kernel, in unit order: each resource's table, the bone textures of
 * each skinned surface's pose in `poses` (three's, and a copy of a moving one's previous bone
 * matrices), and
 * the scene depth `view` holds when the kernel reads it. The tables are uploaded now.
 */
export function kernelTextureSources(
  renderer: WebGLRenderer,
  resources: FXKernelResources,
  poses: FXObjectPoses,
  view: FXCameraView | undefined,
): FXTextureSource[] {
  const sources: FXTextureSource[] = [];
  try {
    for (const name in resources) {
      sources.push(resourceTextureSource(renderer, name, resources[name]));
    }
    for (const name in poses.byName) {
      sources.push(...poseTextureSources(renderer, name, poses.byName[name]));
    }
  } catch (error) {
    releaseTextureSources(sources);
    throw error;
  }
  if (view !== undefined) {
    sources.push(unowned((gl, program) => FXSceneDepthBinding.of(gl, program, view)));
  }
  return sources;
}

export function releaseTextureSources(sources: readonly FXTextureSource[]): void {
  for (const source of sources) {
    source.release();
  }
}

/** The table of resource `name`. */
function resourceTextureSource(
  renderer: WebGLRenderer,
  name: string,
  resource: FXKernelResource,
): FXTextureSource {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  switch (resource.kind) {
    case "surface":
    case "objectSurface":
    case "skinnedSurface":
      return samplerSource(name, gl.TEXTURE_2D, acquireSurfaceTexture(renderer, resource.table));
    case "volume":
      return samplerSource(name, gl.TEXTURE_3D, acquireVolumeTexture(renderer, resource.table));
  }
}

/** The bone textures of the pose of the object surface `name`: none for a mesh, three's for a
 *  skinned mesh, and for a moving one the copy of its previous bone matrices. */
function poseTextureSources(
  renderer: WebGLRenderer,
  name: string,
  pose: FXObjectPose,
): FXTextureSource[] {
  if (!pose.skinned) {
    return [];
  }
  const names = fxObjectInputNames(name);
  const current = unowned((gl, program) => FXBoneTextureBinding.of(gl, program, pose, names.bones));
  return pose.moving
    ? [current, previousBonesSource(renderer, names.previousBones, pose)]
    : [current];
}

/** The texture `lease` holds, bound to the sampler uniform `name` through three's state, so its
 *  texture cache stays true to the context. */
function samplerSource(
  name: string,
  target: number,
  lease: FXContextLease<WebGLTexture>,
): FXTextureSource {
  return {
    bindingIn: (gl, program): FXTextureBinding | undefined => {
      const location = gl.getUniformLocation(program, name);
      return location === null
        ? undefined
        : {
            bind: (renderer, unit): void => {
              renderer.state.activeTexture(gl.TEXTURE0 + unit);
              renderer.state.bindTexture(target, lease.resource);
              gl.uniform1i(location, unit);
            },
          };
    },
    release: () => lease.release(),
  };
}

/**
 * The bone matrices of `pose`'s previous pose, bound to the sampler uniform `name`: a data texture
 * of the kernel's own, uploaded again whenever the previous pose has changed since.
 */
function previousBonesSource(
  renderer: WebGLRenderer,
  name: string,
  pose: FXObjectPose,
): FXTextureSource {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const texels = pose.boneCount * FX_BONE_TEXELS;
  const size = dataTextureSize(gl, texels, "FXObjectPose: the previous bone matrices");
  const texture = createDataTexture(gl, gl.RGBA32F, size);
  renderer.resetState();
  let uploaded = -1;
  return {
    bindingIn: (context, program): FXTextureBinding | undefined => {
      const location = context.getUniformLocation(program, name);
      return location === null
        ? undefined
        : {
            bind: (owner, unit): void => {
              owner.state.activeTexture(gl.TEXTURE0 + unit);
              owner.state.bindTexture(gl.TEXTURE_2D, texture);
              if (uploaded !== pose.previousVersion) {
                uploadDataTexels(gl, size, texels, pose.previousBones.value);
                uploaded = pose.previousVersion;
              }
              gl.uniform1i(location, unit);
            },
          };
    },
    release: () => gl.deleteTexture(texture),
  };
}

/** A source of a texture the kernel does not own. */
function unowned(bindingIn: FXTextureSource["bindingIn"]): FXTextureSource {
  return { bindingIn, release: () => undefined };
}

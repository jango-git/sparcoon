import type { WebGLRenderer } from "three";

import { webglTextureOf } from "../render/FXDataTexture.Internal.js";
import type { FXObjectPose } from "./FXObjectPose.Internal.js";

/**
 * @internal The bone texture three keeps for a skinned mesh, as a kernel program reads it, bound
 * each pass. Until three has rendered the mesh there is none, and the program reads the entries of
 * a surface without one (see {@link FXObjectPose.entriesBound}).
 */
export class FXBoneTextureBinding {
  private constructor(
    private readonly pose: FXObjectPose,
    private readonly location: WebGLUniformLocation,
  ) {}

  /** The binding of `pose`'s bone texture to the sampler uniform `name` of `program`, or
   *  `undefined` when the program does not read it (compiled away). */
  public static of(
    gl: WebGL2RenderingContext,
    program: WebGLProgram,
    pose: FXObjectPose,
    name: string,
  ): FXBoneTextureBinding | undefined {
    const location = gl.getUniformLocation(program, name);
    return location === null ? undefined : new FXBoneTextureBinding(pose, location);
  }

  /** Binds the bone texture on `unit` for a pass of the program in use. */
  public bind(renderer: WebGLRenderer, unit: number): void {
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const boneTexture = this.pose.boneTexture;
    const texture = boneTexture === null ? undefined : webglTextureOf(renderer, boneTexture);
    renderer.state.activeTexture(gl.TEXTURE0 + unit);
    renderer.state.bindTexture(gl.TEXTURE_2D, texture ?? null);
    gl.uniform1i(this.location, unit);
  }
}

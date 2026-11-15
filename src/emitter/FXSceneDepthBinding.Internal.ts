import type { WebGLRenderer } from "three";

import {
  FX_TRANSFORM_FEEDBACK_INVERSE_VIEW_PROJECTION_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SCENE_DEPTH_FRAME_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SCENE_DEPTH_UNIFORM,
  FX_TRANSFORM_FEEDBACK_VIEW_PROJECTION_UNIFORM,
} from "../behaviorTransformFeedbackLayout.js";
import { readableCameraDepth } from "../render/FXCameraDepth.Internal.js";
import { webglTextureOf } from "../render/FXDataTexture.Internal.js";
import type { FXCameraView } from "./FXCameraView.Internal.js";

/**
 * @internal The scene depth a kernel program reads, bound each pass: the depth of the camera
 * `view` last captured, with the matrices of that capture. Without a readable depth - none given,
 * not drawn into yet, or owned by the target being drawn into - the program reads that there is
 * none.
 */
export class FXSceneDepthBinding {
  private readonly texture: WebGLUniformLocation;
  private readonly viewProjection: WebGLUniformLocation | null;
  private readonly inverseViewProjection: WebGLUniformLocation | null;
  private readonly frame: WebGLUniformLocation | null;

  private constructor(
    gl: WebGL2RenderingContext,
    program: WebGLProgram,
    texture: WebGLUniformLocation,
    private readonly view: FXCameraView,
  ) {
    this.texture = texture;
    this.viewProjection = gl.getUniformLocation(
      program,
      FX_TRANSFORM_FEEDBACK_VIEW_PROJECTION_UNIFORM,
    );
    this.inverseViewProjection = gl.getUniformLocation(
      program,
      FX_TRANSFORM_FEEDBACK_INVERSE_VIEW_PROJECTION_UNIFORM,
    );
    this.frame = gl.getUniformLocation(program, FX_TRANSFORM_FEEDBACK_SCENE_DEPTH_FRAME_UNIFORM);
  }

  /** The binding for `program`, or `undefined` when it samples no depth (compiled away). */
  public static of(
    gl: WebGL2RenderingContext,
    program: WebGLProgram,
    view: FXCameraView,
  ): FXSceneDepthBinding | undefined {
    const texture = gl.getUniformLocation(program, FX_TRANSFORM_FEEDBACK_SCENE_DEPTH_UNIFORM);
    return texture === null ? undefined : new FXSceneDepthBinding(gl, program, texture, view);
  }

  /** Sets the depth uniforms for a pass of the program in use, the texture on `unit`. */
  public bind(renderer: WebGLRenderer, unit: number): void {
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const camera = this.view.camera;
    const depth = camera === undefined ? undefined : readableCameraDepth(renderer, camera);
    const texture = depth === undefined ? undefined : webglTextureOf(renderer, depth);
    // Through three's state, so its texture cache stays true to the context. Without a depth the
    // unit gets three's empty texture, and the frame's flag tells the program there is none.
    renderer.state.activeTexture(gl.TEXTURE0 + unit);
    renderer.state.bindTexture(gl.TEXTURE_2D, texture ?? null);
    gl.uniform1i(this.texture, unit);
    if (depth === undefined || texture === undefined) {
      gl.uniform3f(this.frame, 0, 0, 0);
      return;
    }
    const { width, height } = depth.image as { width: number; height: number };
    gl.uniform3f(this.frame, 1 / width, 1 / height, 1);
    gl.uniformMatrix4fv(this.viewProjection, false, this.view.viewProjection.elements);
    gl.uniformMatrix4fv(
      this.inverseViewProjection,
      false,
      this.view.inverseViewProjection.elements,
    );
  }
}

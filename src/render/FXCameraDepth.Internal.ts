import type { Camera, IUniform, Scene, ShaderMaterial, Texture, WebGLRenderer } from "three";
import { Vector2, Vector3, Vector4 } from "three";
import type { FXRenderArtifact } from "../artifact/FXArtifact.js";
import { cameraDepthOf } from "./FXCameraDepth.js";
import type { FXRenderMode } from "./FXMaterialOptions.js";

/** The function a Depth Fade node calls - part of the `fx` cross-repo ABI, like the lighting
 *  intrinsics: the compiler emits the call, the runtime defines it. */
const DEPTH_FADE = "fxDepthFade";

const UNIFORMS = {
  texture: "fxCameraDepth",
  // The projection's z and w rows' depth terms, (P[2][2], P[3][2], P[2][3], P[3][3]).
  projection: "fxCameraDepthProjection",
  // (1 / target width, 1 / target height, 1 when the camera has depth else 0).
  frame: "fxCameraDepthFrame",
} as const;

// A window depth back to the distance along the view axis, for any projection: with
// clip = P * view, ndc = (P22 z + P32) / (P23 z + P33), so z = (P32 - ndc P33) / (ndc P23 - P22) -
// one expression for perspective, orthographic and off-axis alike, and no near/far needed.
const DEPTH_FADE_DEFINITION = [
  `uniform sampler2D ${UNIFORMS.texture};`,
  `uniform vec4 ${UNIFORMS.projection};`,
  `uniform vec3 ${UNIFORMS.frame};`,
  "float fxCameraDepthDistance(float windowDepth) {",
  "  float ndc = windowDepth * 2.0 - 1.0;",
  `  vec4 p = ${UNIFORMS.projection};`,
  "  return (ndc * p.w - p.y) / (ndc * p.z - p.x);",
  "}",
  `float ${DEPTH_FADE}(float fadeDistance) {`,
  `  if (${UNIFORMS.frame}.z == 0.0) {`,
  "    return 1.0;",
  "  }",
  `  vec2 uv = gl_FragCoord.xy * ${UNIFORMS.frame}.xy;`,
  `  float scene = fxCameraDepthDistance(texture2D(${UNIFORMS.texture}, uv).r);`,
  "  float gap = scene - fxCameraDepthDistance(gl_FragCoord.z);",
  "  return clamp(gap / max(fadeDistance, 1e-4), 0.0, 1.0);",
  "}",
].join("\n");

// The shadow-caster twin: a light's shadow camera has no view of the scene to fade against, and
// the fade only shapes the cutout there, so it is the camera-without-depth case - no fade at all.
const DEPTH_FADE_STUB = `float ${DEPTH_FADE}(float fadeDistance) { return 1.0; }`;

/** The color fragment stage's definition of `fxDepthFade`, when the artifact reads the scene
 *  depth; placed with the other runtime-defined functions, before the graph's helpers. */
export function cameraDepthFunctions(render: FXRenderArtifact): string {
  return render.sceneDepth ? DEPTH_FADE_DEFINITION : "";
}

/** {@link cameraDepthFunctions} for a shadow-caster (depth) material: the fade-free stub. */
export function cameraDepthStub(render: FXRenderArtifact): string {
  return render.sceneDepth ? DEPTH_FADE_STUB : "";
}

/**
 * Throws when a graph reading the scene depth would also write depth: drawn into the scene's
 * depth, it would then fade against itself.
 */
export function assertCameraDepthMode(render: FXRenderArtifact, renderMode: FXRenderMode): void {
  if (render.sceneDepth && renderMode !== "blending") {
    throw new Error(
      `a graph with Depth Fade must render in "blending" mode, not "${renderMode}": ` +
        "a depth-writing material would read its own depth",
    );
  }
}

const targetSize = new Vector2();

// Three calls `Material.onBeforeRender` before every draw (three r157 included); `@types/three`
// 0.157 just leaves it out.
type FXMaterialDrawHook = (renderer: WebGLRenderer, scene: Scene, camera: Camera) => void;

/**
 * Wires the camera depth into `material`, resolved per draw from the camera drawing it - the same
 * material is drawn by every camera that sees it. A camera without depth, or one drawing into the
 * target that owns its depth (that depth's own pre-pass), gets no fade. Three re-uploads a
 * material's uniforms whenever the camera changes, so a per-draw write is all it takes.
 */
export function bindCameraDepth(material: ShaderMaterial): void {
  const texture: IUniform<Texture | null> = { value: null };
  const projection: IUniform<Vector4> = { value: new Vector4() };
  const frame: IUniform<Vector3> = { value: new Vector3() };
  material.uniforms[UNIFORMS.texture] = texture;
  material.uniforms[UNIFORMS.projection] = projection;
  material.uniforms[UNIFORMS.frame] = frame;
  const hook: FXMaterialDrawHook = (renderer, scene, camera) => {
    const depth = cameraDepthOf(camera);
    const target = renderer.getRenderTarget();
    if (depth === undefined || target?.depthTexture === depth) {
      texture.value = null;
      frame.value.z = 0;
      return;
    }
    const size =
      target === null
        ? renderer.getDrawingBufferSize(targetSize)
        : targetSize.set(target.width, target.height);
    const elements = camera.projectionMatrix.elements;
    projection.value.set(elements[10], elements[14], elements[11], elements[15]);
    frame.value.set(1 / size.x, 1 / size.y, 1);
    texture.value = depth;
  };
  (material as ShaderMaterial & { onBeforeRender: FXMaterialDrawHook }).onBeforeRender = hook;
}

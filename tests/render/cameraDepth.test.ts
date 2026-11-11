import { describe, expect, it } from "vitest";
import {
  DepthTexture,
  LessEqualCompare,
  OrthographicCamera,
  PerspectiveCamera,
  Scene,
  Vector2,
  type Camera,
  type ShaderMaterial,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from "three";
import type { FXRenderArtifact } from "../../src/artifact/FXArtifact";
import { fxSetCameraDepth } from "../../src/render/FXCameraDepth";
import { FXArtifactMaterial } from "../../src/render/FXArtifactMaterial";
import { FXMeshMaterial } from "../../src/render/FXMeshMaterial";
import type { FXRenderMode } from "../../src/render/FXMaterialOptions";
import { layoutOf, unlitArtifact } from "../helpers/artifacts";

const layout = layoutOf({});

/** An artifact whose albedo alpha is a Depth Fade over 0.5 units. */
function fadingArtifact(renderMode: FXRenderMode = "blending"): FXRenderArtifact {
  return {
    ...unlitArtifact({ outputs: { albedo: "vec4(1.0, 1.0, 1.0, fxDepthFade(0.5))" } }),
    sceneDepth: true,
    options: { renderMode },
  };
}

function colorMaterial(render: FXRenderArtifact): ShaderMaterial {
  return new FXArtifactMaterial(render).buildThreeMaterial(layout) as ShaderMaterial;
}

/** A renderer drawing into `target` (null: the canvas, 800x600 device pixels). */
function rendererInto(target: WebGLRenderTarget | null): WebGLRenderer {
  return {
    getRenderTarget: () => target,
    getDrawingBufferSize: (size: Vector2) => size.set(800, 600),
  } as unknown as WebGLRenderer;
}

function targetWith(depthTexture: DepthTexture | null): WebGLRenderTarget {
  return { width: 400, height: 300, depthTexture } as unknown as WebGLRenderTarget;
}

type DrawHook = (renderer: WebGLRenderer, scene: Scene, camera: Camera) => void;

/** Runs the material's per-draw hook as three does before drawing it through `camera`. */
function draw(material: ShaderMaterial, renderer: WebGLRenderer, camera: Camera): void {
  (material as unknown as { onBeforeRender: DrawHook }).onBeforeRender(
    renderer,
    new Scene(),
    camera,
  );
}

function depthUniforms(material: ShaderMaterial): {
  texture: unknown;
  projection: number[];
  frame: number[];
} {
  return {
    texture: material.uniforms["fxCameraDepth"].value,
    projection: (
      material.uniforms["fxCameraDepthProjection"].value as { toArray(): number[] }
    ).toArray(),
    frame: (material.uniforms["fxCameraDepthFrame"].value as { toArray(): number[] }).toArray(),
  };
}

/** The view distance the shader's decode gives a window depth, from the uploaded projection. */
function decode(projection: readonly number[], windowDepth: number): number {
  const [p22, p32, p23, p33] = projection;
  const ndc = windowDepth * 2 - 1;
  return (ndc * p33 - p32) / (ndc * p23 - p22);
}

describe("camera depth", () => {
  it("costs nothing in a graph without Depth Fade", () => {
    const material = colorMaterial(unlitArtifact());
    expect(material.fragmentShader).not.toContain("fxCameraDepth");
    expect(Object.keys(material.uniforms).some((name) => name.startsWith("fxCameraDepth"))).toBe(
      false,
    );
    expect(Object.prototype.hasOwnProperty.call(material, "onBeforeRender")).toBe(false);
  });

  it("defines fxDepthFade before the graph reads it", () => {
    const shader = colorMaterial(fadingArtifact()).fragmentShader;
    const definition = shader.indexOf("float fxDepthFade(float fadeDistance)");
    expect(definition).toBeGreaterThan(-1);
    expect(definition).toBeLessThan(shader.indexOf("void main()"));
  });

  it("binds the depth of whichever camera draws, so one material serves every camera", () => {
    const material = colorMaterial(fadingArtifact());
    const near = new DepthTexture(800, 600);
    const far = new DepthTexture(800, 600);
    const main = new PerspectiveCamera(50, 4 / 3, 0.1, 100);
    const minimap = new OrthographicCamera(-10, 10, 10, -10, 1, 50);
    fxSetCameraDepth(main, near);
    fxSetCameraDepth(minimap, far);

    draw(material, rendererInto(null), main);
    let bound = depthUniforms(material);
    expect(bound.texture).toBe(near);
    expect(bound.frame).toEqual([1 / 800, 1 / 600, 1]);
    expect(decode(bound.projection, 0)).toBeCloseTo(0.1, 6);
    expect(decode(bound.projection, 1)).toBeCloseTo(100, 3);

    draw(material, rendererInto(targetWith(null)), minimap);
    bound = depthUniforms(material);
    expect(bound.texture).toBe(far);
    expect(bound.frame).toEqual([1 / 400, 1 / 300, 1]);
    expect(decode(bound.projection, 0)).toBeCloseTo(1, 6);
    expect(decode(bound.projection, 0.5)).toBeCloseTo(25.5, 6);
    expect(decode(bound.projection, 1)).toBeCloseTo(50, 6);
  });

  it("draws hard for a camera without depth, and once its depth is taken away", () => {
    const material = colorMaterial(fadingArtifact());
    const camera = new PerspectiveCamera();
    draw(material, rendererInto(null), camera);
    expect(depthUniforms(material).frame[2]).toBe(0);
    expect(depthUniforms(material).texture).toBeNull();

    fxSetCameraDepth(camera, new DepthTexture(1, 1));
    draw(material, rendererInto(null), camera);
    expect(depthUniforms(material).frame[2]).toBe(1);

    fxSetCameraDepth(camera, undefined);
    draw(material, rendererInto(null), camera);
    expect(depthUniforms(material).frame[2]).toBe(0);
    expect(depthUniforms(material).texture).toBeNull();
  });

  it("draws hard into the target that owns the camera's depth - its pre-pass, never a feedback loop", () => {
    const material = colorMaterial(fadingArtifact());
    const camera = new PerspectiveCamera();
    const depth = new DepthTexture(400, 300);
    fxSetCameraDepth(camera, depth);
    draw(material, rendererInto(targetWith(depth)), camera);
    expect(depthUniforms(material).texture).toBeNull();
    expect(depthUniforms(material).frame[2]).toBe(0);
    // Another target (the main pass into an offscreen buffer) samples it.
    draw(material, rendererInto(targetWith(new DepthTexture(400, 300))), camera);
    expect(depthUniforms(material).texture).toBe(depth);
  });

  it("rejects a shadow-comparison texture, which a plain sampler cannot read", () => {
    const depth = new DepthTexture(1, 1);
    depth.compareFunction = LessEqualCompare;
    expect(() => {
      fxSetCameraDepth(new PerspectiveCamera(), depth);
    }).toThrow(/compareFunction/);
  });

  it.each<FXRenderMode>(["alphaTest", "alphaHash", "opaque"])(
    "rejects Depth Fade in %s mode, where the material would read its own depth",
    (renderMode) => {
      expect(() => colorMaterial(fadingArtifact(renderMode))).toThrow(/"blending" mode/);
    },
  );

  it("fades a VFX mesh and casts shadows without one: the shadow pass has no view to fade against", () => {
    const render = fadingArtifact();
    const mesh = new FXMeshMaterial(render);
    expect((mesh.buildThreeMaterial() as ShaderMaterial).fragmentShader).toContain(
      "fxCameraDepthDistance",
    );
    for (const depthMaterial of [
      mesh.buildThreeDepthMaterial() as ShaderMaterial,
      new FXArtifactMaterial(render).buildThreeDepthMaterial(layout) as ShaderMaterial,
    ]) {
      expect(depthMaterial.fragmentShader).toContain(
        "float fxDepthFade(float fadeDistance) { return 1.0; }",
      );
      expect(depthMaterial.fragmentShader).not.toContain("fxCameraDepthDistance");
      expect(Object.prototype.hasOwnProperty.call(depthMaterial, "onBeforeRender")).toBe(false);
    }
  });
});

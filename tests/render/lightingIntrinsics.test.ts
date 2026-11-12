import type { ShaderMaterial } from "three";
import { describe, expect, it } from "vitest";

import type { FXRenderArtifact } from "../../src/artifact/FXArtifact";
import { FXArtifactMaterial } from "../../src/render/FXArtifactMaterial";
import { FX_LIGHTING_INTRINSIC } from "../../src/render/FXLightingIntrinsics.Internal";
import { FXMeshMaterial } from "../../src/render/FXMeshMaterial";
import { layoutOf, unlitArtifact, VEC2_VARYING, VEC3_VARYING } from "../helpers/artifacts";

const layout = layoutOf({ position: VEC3_VARYING, lifecycle: VEC2_VARYING });

const HALF_LIT_CALL = "fxHalfLitShade(vec4(1.0), geometryNormal, 1.0, 0.5, 8.0)";

/** A lit artifact listing `intrinsics`, its albedo `albedo` (a call of one of them). */
function litArtifact(intrinsics: readonly string[], albedo = HALF_LIT_CALL): FXRenderArtifact {
  const base = unlitArtifact({ outputs: { albedo } });
  return {
    ...base,
    lightingIntrinsics: intrinsics,
    fragment: { ...base.fragment, surfaceReads: { ...base.fragment.surfaceReads, normal: true } },
  };
}

function colorShader(render: FXRenderArtifact): string {
  return (new FXArtifactMaterial(render).buildThreeMaterial(layout) as ShaderMaterial)
    .fragmentShader;
}

/** The text of the GLSL function `name` defines in `shader`, up to its closing brace. */
function functionBody(shader: string, signatureStart: string): string {
  const start = shader.indexOf(signatureStart);
  expect(start).toBeGreaterThan(-1);
  return shader.slice(start, shader.indexOf("\n}", start) + 2);
}

describe("lighting intrinsics", () => {
  it("defines only the intrinsics the artifact lists", () => {
    const shader = colorShader(litArtifact([FX_LIGHTING_INTRINSIC.halfLit]));
    expect(shader).toContain(
      "vec4 fxHalfLitShade(vec4 diffuseColor, vec3 worldNormal, float wrap, float scatter, float focus) {",
    );
    expect(shader).not.toContain("fxLambertShade");
    expect(shader).not.toContain("fxAmbientShade");
  });

  it("orders the definitions itself, whatever order the artifact lists them in", () => {
    const listed = [FX_LIGHTING_INTRINSIC.halfLit, FX_LIGHTING_INTRINSIC.lambert];
    expect(colorShader(litArtifact(listed))).toBe(colorShader(litArtifact([...listed].reverse())));
  });

  it("swaps in Half-Lit's per-light term for its own light loop only", () => {
    const shader = colorShader(
      litArtifact([FX_LIGHTING_INTRINSIC.halfLit, FX_LIGHTING_INTRINSIC.lambert]),
    );
    // The per-light term is a top-level function, defined before the intrinsic that calls it.
    expect(shader.indexOf("void fxHalfLitDirect(")).toBeGreaterThan(-1);
    expect(shader.indexOf("void fxHalfLitDirect(")).toBeLessThan(
      shader.indexOf("vec4 fxHalfLitShade("),
    );

    const halfLit = functionBody(shader, "vec4 fxHalfLitShade(");
    const swap = halfLit.indexOf("#define RE_Direct( light,");
    const loop = halfLit.indexOf("#include <lights_fragment_begin>");
    const restore = halfLit.indexOf("#define RE_Direct RE_Direct_Lambert");
    expect(halfLit.indexOf("#undef RE_Direct")).toBeLessThan(swap);
    expect(swap).toBeLessThan(loop);
    expect(loop).toBeLessThan(restore);
    // Lambert's loop still runs Lambert's term.
    expect(functionBody(shader, "vec4 fxLambertShade(")).not.toContain("RE_Direct(");
  });

  it("clamps the graph-driven inputs, so the divide and the pow stay defined", () => {
    const halfLit = functionBody(
      colorShader(litArtifact([FX_LIGHTING_INTRINSIC.halfLit])),
      "vec4 fxHalfLitShade(",
    );
    expect(halfLit).toContain(
      "vec3( clamp( wrap, 0.0, 1.0 ), max( scatter, 0.0 ), max( focus, 1.0 ) )",
    );
  });

  it("stubs the listed intrinsics in both depth materials", () => {
    const render = litArtifact([FX_LIGHTING_INTRINSIC.halfLit]);
    for (const depth of [
      new FXArtifactMaterial(render).buildThreeDepthMaterial(layout),
      new FXMeshMaterial(render).buildThreeDepthMaterial(),
    ] as ShaderMaterial[]) {
      expect(depth.fragmentShader).toContain(
        "vec4 fxHalfLitShade(vec4 diffuseColor, vec3 worldNormal, float wrap, float scatter, float focus) { return diffuseColor; }",
      );
      expect(depth.fragmentShader).not.toContain("fxHalfLitDirect");
    }
  });

  it("defines the intrinsics for a VFX mesh too", () => {
    const render = litArtifact([FX_LIGHTING_INTRINSIC.halfLit]);
    expect(
      (new FXMeshMaterial(render).buildThreeMaterial() as ShaderMaterial).fragmentShader,
    ).toContain("void fxHalfLitDirect(");
  });

  it("rejects a name this runtime does not define, rather than failing in the GPU compiler", () => {
    const render = litArtifact(["fxFutureShade"], "fxFutureShade(vec4(1.0), geometryNormal)");
    expect(() => colorShader(render)).toThrow(/unknown lighting intrinsic "fxFutureShade"/);
    expect(() => new FXMeshMaterial(render).buildThreeDepthMaterial()).toThrow(/fxFutureShade/);
  });
});

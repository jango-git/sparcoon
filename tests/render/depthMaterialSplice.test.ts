import { describe, expect, it } from "vitest";
import { FXArtifactMaterial } from "../../src/render/FXArtifactMaterial";
import { FXMeshMaterial } from "../../src/render/FXMeshMaterial";
import type { FXRenderArtifact } from "../../src/artifact/FXArtifact";
import type { GLTypeInfo } from "../../src/instancedParticle/glTypeInfo";
import { unlitArtifact, VEC2_VARYING, VEC3_VARYING } from "../helpers/artifacts";

/** The two fixed core buffers the particle depth material needs declared as varyings. */
function varyings(): Record<string, GLTypeInfo> {
  return {
    position: VEC3_VARYING,
    lifecycle: VEC2_VARYING,
  };
}

function particleDepthShaders(render: FXRenderArtifact): {
  vertexShader: string;
  fragmentShader: string;
} {
  const material = new FXArtifactMaterial(render).buildThreeDepthMaterial(
    varyings(),
  ) as unknown as { vertexShader: string; fragmentShader: string };
  return { vertexShader: material.vertexShader, fragmentShader: material.fragmentShader };
}

function meshDepthShaders(render: FXRenderArtifact): {
  vertexShader: string;
  fragmentShader: string;
} {
  const material = new FXMeshMaterial(render).buildThreeDepthMaterial() as unknown as {
    vertexShader: string;
    fragmentShader: string;
  };
  return { vertexShader: material.vertexShader, fragmentShader: material.fragmentShader };
}

/** A lit fixture: the graph's `albedo` carries the intrinsic call, like a real lighting-node graph. */
function litArtifact(): FXRenderArtifact {
  return {
    ...unlitArtifact(),
    lightingIntrinsics: ["fxLambertShade"],
    outputs: { albedo: "fxLambertShade(vec4(1.0), geometryNormal)" },
  };
}

// Both depth builders (particle + mesh) share the same tail contract, so drive them from one table.
const BUILDERS = [
  { kind: "particle", build: particleDepthShaders },
  { kind: "mesh", build: meshDepthShaders },
] as const;

describe.each(BUILDERS)("$kind depth material assembly", ({ build }) => {
  it("packs RGBA depth instead of the color/tonemap/fog tail", () => {
    const { vertexShader, fragmentShader } = build(unlitArtifact());

    // The depth pack replaced the visible color tail - proof it is not just left in place.
    expect(fragmentShader).toContain("gl_FragColor = packDepthToRGBA( fragCoordZ );");
    expect(fragmentShader).not.toContain("outgoingLight");
    expect(fragmentShader).not.toContain("#include <tonemapping_fragment>");
    expect(fragmentShader).not.toContain("#include <opaque_fragment>");
    // High-precision z/w carried from the vertex for the pack.
    expect(vertexShader).toContain("varying vec2 vHighPrecisionZW;");
    expect(vertexShader).toContain("vHighPrecisionZW = gl_Position.zw;");
  });

  it("keeps the alpha cutout in every non-opaque mode, so the shadow silhouette matches", () => {
    const cutoff = "if (diffuseColor.a < clamp(0.0075, 0.0, 1.0)) discard;";

    const blending = build(unlitArtifact({ outputs: { albedo: "vec4(1.0)" } }));
    expect(blending.fragmentShader).toContain(cutoff);

    const alphaHash = build({
      ...unlitArtifact({ outputs: { albedo: "vec4(1.0)" } }),
      options: { renderMode: "alphaHash" },
    });
    expect(alphaHash.fragmentShader).toContain(cutoff);
    expect(alphaHash.fragmentShader).toContain("#include <alphahash_fragment>");

    const alphaTest = build({
      ...unlitArtifact({ outputs: { albedo: "vec4(1.0)", alphaThreshold: "0.5" } }),
      options: { renderMode: "alphaTest" },
    });
    expect(alphaTest.fragmentShader).toContain(
      "if (diffuseColor.a < clamp(0.5, 0.0, 1.0)) discard;",
    );

    // Opaque keeps the GPU's early depth test - no discard anywhere.
    const opaque = build({
      ...unlitArtifact({ outputs: { albedo: "vec4(1.0)" } }),
      options: { renderMode: "opaque" },
    });
    expect(opaque.fragmentShader).not.toContain("discard");
  });

  it("compiles the fx_ shade intrinsic into the depth fragment for a lit graph", () => {
    const { fragmentShader } = build(litArtifact());
    // The lit branch must be exercised too: the body calls fxLambertShade, so it must be defined -
    // only .a is used (returned unchanged), but the call has to compile.
    expect(fragmentShader).toContain("vec4 fxLambertShade(vec4 diffuseColor, vec3 worldNormal) {");
    expect(fragmentShader).toContain("#include <shadowmap_pars_fragment>");
    expect(fragmentShader).toContain(
      "vec4 diffuseColor = fxLambertShade(vec4(1.0), geometryNormal);",
    );
    expect(fragmentShader).toContain("gl_FragColor = packDepthToRGBA( fragCoordZ );");
  });
});

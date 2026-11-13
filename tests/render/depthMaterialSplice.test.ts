import type { ShaderMaterial } from "three";
import { describe, expect, it } from "vitest";

import type { FXRenderArtifact } from "../../src/artifact/FXArtifact";
import type { GLTypeInfo } from "../../src/instancedParticle/glTypeInfo";
import { FXArtifactMaterial } from "../../src/render/FXArtifactMaterial";
import { FXMeshMaterial } from "../../src/render/FXMeshMaterial";
import { layoutOf, unlitArtifact, VEC2_VARYING, VEC3_VARYING } from "../helpers/artifacts";

/** The two fixed core buffers the particle depth material needs declared as varyings. */
function varyings(): Record<string, GLTypeInfo> {
  return {
    position: VEC3_VARYING,
    lifecycle: VEC2_VARYING,
  };
}

function particleDepthShaders(render: FXRenderArtifact): ShaderMaterial {
  return new FXArtifactMaterial(render).buildThreeDepthMaterial(
    layoutOf(varyings()),
  ) as ShaderMaterial;
}

function meshDepthShaders(render: FXRenderArtifact): ShaderMaterial {
  return new FXMeshMaterial(render).buildThreeDepthMaterial() as ShaderMaterial;
}

/** A lit fixture: the graph's `albedo` carries the intrinsic call, like a real lighting-node graph. */
function litArtifact(): FXRenderArtifact {
  return {
    ...unlitArtifact({ outputs: { albedo: "fxLambertShade(vec4(1.0), geometryNormal)" } }),
    lightingIntrinsics: ["fxLambertShade"],
  };
}

/** `outputs`' artifact drawn in `renderMode`. */
function inMode(
  renderMode: NonNullable<FXRenderArtifact["options"]>["renderMode"],
  outputs: Record<string, string> = { albedo: "vec4(1.0)" },
): FXRenderArtifact {
  return { ...unlitArtifact({ outputs }), options: { renderMode } };
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

  it("draws the shadow program, not the color one", () => {
    const render = unlitArtifact();
    const shadow = {
      ...render.shadow!,
      fragment: { ...render.shadow!.fragment, body: ["float shadowOnly = 0.5;"] },
      outputs: { alpha: "shadowOnly" },
    };
    const { fragmentShader } = build({
      ...render,
      color: {
        ...render.color,
        fragment: { ...render.color.fragment, body: ["float colorOnly;"] },
      },
      shadow,
    });
    expect(fragmentShader).toContain("float shadowOnly = 0.5;");
    expect(fragmentShader).toContain("float fxShadowAlpha = shadowOnly;");
    expect(fragmentShader).not.toContain("colorOnly");
  });

  it("throws on an artifact with no shadow program", () => {
    expect(() => build({ ...unlitArtifact(), shadow: undefined })).toThrow(/no shadow program/);
  });

  it("keeps what the color material keeps when shadowThreshold is unwired", () => {
    const cutoff = "if (fxShadowAlpha < clamp(0.0075, 0.0, 1.0)) discard;";

    const blending = build(inMode("blending")).fragmentShader;
    expect(blending).toContain("if (fxShadowAlpha < 0.0035) discard;");
    expect(blending).toContain(cutoff);

    // Always a hard cutoff: a hashed shadow would only add noise to the shadow map.
    const alphaHash = build(inMode("alphaHash")).fragmentShader;
    expect(alphaHash).toContain(cutoff);
    expect(alphaHash).not.toContain("alphahash");

    const alphaTest = build(inMode("alphaTest", { albedo: "vec4(1.0)", alphaThreshold: "0.5" }));
    expect(alphaTest.fragmentShader).toContain(
      "if (fxShadowAlpha < clamp(0.5, 0.0, 1.0)) discard;",
    );

    // The visible opaque material discards nothing, so neither does its shadow.
    expect(build(inMode("opaque")).fragmentShader).not.toContain("discard");
  });

  it("cuts at a wired shadowThreshold in every mode, opaque included, instead of alphaThreshold", () => {
    const outputs = { albedo: "vec4(1.0)", alphaThreshold: "0.2", shadowThreshold: "0.6" };
    for (const mode of ["blending", "alphaHash", "alphaTest", "opaque"] as const) {
      const { fragmentShader } = build(inMode(mode, outputs));
      expect(fragmentShader).toContain("if (fxShadowAlpha < clamp(0.6, 0.0, 1.0)) discard;");
      expect(fragmentShader).not.toContain("0.2");
      expect(fragmentShader).not.toContain("0.0035");
    }
  });

  it("resolves a lit graph's shade intrinsic without the lights, so it never samples a shadow map", () => {
    const { fragmentShader, vertexShader, lights, uniforms } = build(litArtifact());
    // The body calls fxLambertShade, so it must be defined; depth reads only the alpha it passes on.
    expect(fragmentShader).toContain(
      "vec4 fxLambertShade(vec4 diffuseColor, vec3 worldNormal) { return diffuseColor; }",
    );
    expect(fragmentShader).toContain(
      "float fxShadowAlpha = (fxLambertShade(vec4(1.0), geometryNormal)).a;",
    );
    expect(fragmentShader).toContain("gl_FragColor = packDepthToRGBA( fragCoordZ );");
    // In the shadow pass the light's shadow map is the target being drawn: a material with the
    // lights bound samples it, and the driver drops the draw as a feedback loop.
    expect(lights).toBe(false);
    expect(Object.keys(uniforms)).not.toContain("directionalShadowMap");
    for (const shader of [vertexShader, fragmentShader]) {
      expect(shader).not.toContain("shadowmap");
      expect(shader).not.toContain("lights_");
    }
  });
});

describe("dead-particle hiding (GPU-driven emitters draw their full fixed capacity, JS-driven ones never reach this)", () => {
  it("pushes a dead particle's vertex outside the clip volume, after gl_Position is first computed", () => {
    const { vertexShader } = particleDepthShaders(unlitArtifact());
    const degenerate =
      "if (PARTICLE_AGE >= PARTICLE_LIFETIME) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); }";
    expect(vertexShader).toContain(degenerate);
    expect(vertexShader.indexOf("gl_Position = projectionMatrix * mvPosition;")).toBeLessThan(
      vertexShader.indexOf(degenerate),
    );
  });

  it("does not apply to a VFX mesh - a mesh has no particle age/lifetime state at all", () => {
    const { vertexShader } = meshDepthShaders(unlitArtifact());
    expect(vertexShader).not.toContain("PARTICLE_AGE");
    expect(vertexShader).not.toContain("gl_Position = vec4(2.0, 2.0, 2.0, 1.0)");
  });
});

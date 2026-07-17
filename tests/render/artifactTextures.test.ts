import { describe, expect, it } from "vitest";
import { ClampToEdgeWrapping, FloatType, NearestFilter, RGBAFormat, Texture } from "three";
import { FXEmitter } from "../../src/emitter/FXEmitter";
import { FXArtifactMaterial } from "../../src/render/FXArtifactMaterial";
import type { FXRenderArtifact } from "../../src/artifact/FXArtifact";
import { fxDataTexture } from "../../src/miscellaneous/texture/fxDataTexture";
import type { GLTypeInfo } from "../../src/instancedParticle/glTypeInfo";
import { behaviorArtifact, VEC2_VARYING, VEC3_VARYING } from "../helpers/artifacts";

function coreVaryings(): Record<string, GLTypeInfo> {
  return {
    position: VEC3_VARYING,
    lifecycle: VEC2_VARYING,
  };
}

/** Builds the unlit ShaderMaterial and returns its bound uniforms (fog slots + clock + artifact slots). */
function compiledUniforms(
  render: FXRenderArtifact,
  textures?: Record<string, Texture>,
): Record<string, { value: unknown }> {
  const material = new FXArtifactMaterial(render, textures).buildThreeMaterial(
    coreVaryings(),
  ) as unknown as { uniforms: Record<string, { value: unknown }> };
  return material.uniforms;
}

describe("fxDataTexture", () => {
  it("builds a DataTexture with LUT-friendly defaults", () => {
    const data = new Float32Array([1, 0, 0, 1, 0, 0, 1, 1]); // 2x1 RGBA
    const texture = fxDataTexture(data, 2, 1);
    expect(texture.image.width).toBe(2);
    expect(texture.image.height).toBe(1);
    expect(texture.image.data).toBe(data);
    expect(texture.format).toBe(RGBAFormat);
    expect(texture.type).toBe(FloatType);
    expect(texture.wrapS).toBe(ClampToEdgeWrapping);
    // needsUpdate is a write-only setter (bumps version); observe the version instead.
    expect(texture.version).toBeGreaterThan(0);
  });

  it("honors filter/wrap overrides", () => {
    const texture = fxDataTexture(new Float32Array(4), 1, 1, {
      minFilter: NearestFilter,
      magFilter: NearestFilter,
    });
    expect(texture.magFilter).toBe(NearestFilter);
    expect(texture.minFilter).toBe(NearestFilter);
  });
});

describe("render artifact - generated & external textures", () => {
  const withGeneratedTexture = (texture: Texture): FXRenderArtifact => ({
    lightingIntrinsics: [],
    uniformDeclarations: ["uniform sampler2D u_grad$0;"],
    vertex: { varyingDeclarations: [], helperFunctions: [], body: [] },
    fragment: { varyingDeclarations: [], helperFunctions: [], body: [] },
    outputs: { albedo: "texture2D(u_grad$0, p_uv)" },
    uniforms: { u_grad$0: { type: "sampler2D", value: texture } },
    attributeReads: [],
  });

  const withExternalTexture = (): FXRenderArtifact => ({
    lightingIntrinsics: [],
    uniformDeclarations: ["uniform sampler2D u_flame$0;"],
    vertex: { varyingDeclarations: [], helperFunctions: [], body: [] },
    fragment: { varyingDeclarations: [], helperFunctions: [], body: [] },
    outputs: { albedo: "texture2D(u_flame$0, p_uv)" },
    uniforms: { u_flame$0: { type: "sampler2D", external: "flame" } },
    attributeReads: [],
  });

  it("binds a generated (fxDataTexture) uniform straight through", () => {
    const generated = fxDataTexture(new Float32Array([1, 1, 1, 1]), 1, 1);
    const uniforms = compiledUniforms(withGeneratedTexture(generated));
    expect(uniforms["u_grad$0"].value).toBe(generated);
  });

  it("binds an external texture by slot name from fromArtifacts({ textures })", () => {
    const flame = new Texture();
    const uniforms = compiledUniforms(withExternalTexture(), { flame });
    expect(uniforms["u_flame$0"].value).toBe(flame);
  });

  it("fails fast when an external texture slot is not supplied", () => {
    expect(() => new FXArtifactMaterial(withExternalTexture())).toThrow(
      /no texture supplied for external slot "flame"/,
    );
    // ...and through the emitter entry point.
    expect(() =>
      FXEmitter.fromArtifacts(withExternalTexture(), behaviorArtifact({ lifetime: 1 })),
    ).toThrow(/no texture supplied for external slot "flame"/);
  });

  it("launches an emitter with a generated gradient + external sprite from artifacts", () => {
    const gradient = fxDataTexture(new Float32Array([1, 0, 0, 1, 0, 0, 1, 1]), 2, 1);
    const flame = new Texture();
    const render: FXRenderArtifact = {
      lightingIntrinsics: [],
      uniformDeclarations: ["uniform sampler2D u_grad$0;", "uniform sampler2D u_flame$1;"],
      vertex: { varyingDeclarations: [], helperFunctions: [], body: [] },
      fragment: { varyingDeclarations: [], helperFunctions: [], body: [] },
      outputs: { albedo: "texture2D(u_grad$0, p_uv) * texture2D(u_flame$1, p_uv)" },
      uniforms: {
        u_grad$0: { type: "sampler2D", value: gradient },
        u_flame$1: { type: "sampler2D", external: "flame" },
      },
      attributeReads: [],
    };
    const emitter = FXEmitter.fromArtifacts(render, behaviorArtifact({ lifetime: 5 }), {
      textures: { flame },
    });
    try {
      emitter.burst(2);
      expect(emitter.particleCount).toBe(2);
      expect(() => emitter.prewarm(0.5)).not.toThrow();
    } finally {
      emitter.destroy();
    }
  });
});

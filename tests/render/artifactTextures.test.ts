import {
  FloatType,
  LinearFilter,
  NearestFilter,
  RepeatWrapping,
  type ShaderMaterial,
  Texture,
} from "three";
import { describe, expect, it } from "vitest";

import type { FXRenderArtifact } from "../../src/artifact/FXArtifact";
import { FXEmitter } from "../../src/emitter/FXEmitter";
import type { GLTypeInfo } from "../../src/instancedParticle/glTypeInfo";
import { fxDataTexture } from "../../src/miscellaneous/texture/fxDataTexture";
import { FXArtifactMaterial } from "../../src/render/FXArtifactMaterial";
import {
  behaviorArtifact,
  layoutOf,
  NO_PARTICLE_READS,
  NO_SURFACE_READS,
  VEC2_VARYING,
  VEC3_VARYING,
} from "../helpers/artifacts";
import { particlesOf } from "../helpers/internals";

function coreVaryings(): Record<string, GLTypeInfo> {
  return {
    position: VEC3_VARYING,
    lifecycle: VEC2_VARYING,
  };
}

/** Builds the unlit ShaderMaterial and returns its bound uniforms (fog slots + clock + artifact slots). */
function compiledUniforms(render: FXRenderArtifact): ShaderMaterial["uniforms"] {
  const material = new FXArtifactMaterial(render).buildThreeMaterial(layoutOf(coreVaryings()));
  return (material as ShaderMaterial).uniforms;
}

describe("fxDataTexture", () => {
  it("builds a float DataTexture over the data, filtered linearly, ready to upload", () => {
    // Only what differs from a plain DataTexture's defaults (byte texels, nearest filtering).
    const data = new Float32Array([1, 0, 0, 1, 0, 0, 1, 1]); // 2x1 RGBA
    const texture = fxDataTexture(data, 2, 1);
    expect(texture.image).toMatchObject({ width: 2, height: 1, data });
    expect(texture.type).toBe(FloatType);
    expect(texture.minFilter).toBe(LinearFilter);
    expect(texture.magFilter).toBe(LinearFilter);
    // needsUpdate is a write-only setter (bumps version); observe the version instead.
    expect(texture.version).toBeGreaterThan(0);
  });

  it("honors filter/wrap overrides", () => {
    const texture = fxDataTexture(new Float32Array(4), 1, 1, {
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      wrapS: RepeatWrapping,
    });
    expect(texture.magFilter).toBe(NearestFilter);
    expect(texture.minFilter).toBe(NearestFilter);
    expect(texture.wrapS).toBe(RepeatWrapping);
  });
});

describe("render artifact - generated & external textures", () => {
  const withGeneratedTexture = (texture: Texture): FXRenderArtifact => ({
    lightingIntrinsics: [],
    sceneDepth: false,
    color: {
      varyings: [],
      vertex: {
        uniformDeclarations: [],
        helperFunctions: [],
        body: [],
        particleReads: NO_PARTICLE_READS,
      },
      fragment: {
        uniformDeclarations: ["uniform sampler2D u_grad$0;"],
        helperFunctions: [],
        body: [],
        particleReads: NO_PARTICLE_READS,
        surfaceReads: NO_SURFACE_READS,
      },
      outputs: { albedo: "texture2D(u_grad$0, p_uv)" },
    },
    uniforms: { u_grad$0: { type: "sampler2D", value: texture } },
    attributeReads: [],
  });

  const withExternalTexture = (): FXRenderArtifact => ({
    lightingIntrinsics: [],
    sceneDepth: false,
    color: {
      varyings: [],
      vertex: {
        uniformDeclarations: [],
        helperFunctions: [],
        body: [],
        particleReads: NO_PARTICLE_READS,
      },
      fragment: {
        uniformDeclarations: ["uniform sampler2D u_flame$0;"],
        helperFunctions: [],
        body: [],
        particleReads: NO_PARTICLE_READS,
        surfaceReads: NO_SURFACE_READS,
      },
      outputs: { albedo: "texture2D(u_flame$0, p_uv)" },
    },
    uniforms: { u_flame$0: { type: "sampler2D", external: "flame" } },
    attributeReads: [],
  });

  it("binds a generated (fxDataTexture) uniform straight through", () => {
    const generated = fxDataTexture(new Float32Array([1, 1, 1, 1]), 1, 1);
    const uniforms = compiledUniforms(withGeneratedTexture(generated));
    expect(uniforms["u_grad$0"].value).toBe(generated);
  });

  it("fails fast through fromArtifacts when an external texture slot is not supplied", () => {
    expect(() =>
      FXEmitter.fromArtifacts(withExternalTexture(), behaviorArtifact({ lifetime: 1 })),
    ).toThrow(/no texture supplied for external slot "flame"/);
  });

  it("binds a generated gradient and an external sprite through fromArtifacts({ textures })", () => {
    const gradient = fxDataTexture(new Float32Array([1, 0, 0, 1, 0, 0, 1, 1]), 2, 1);
    const flame = new Texture();
    const render: FXRenderArtifact = {
      lightingIntrinsics: [],
      sceneDepth: false,
      color: {
        varyings: [],
        vertex: {
          uniformDeclarations: [],
          helperFunctions: [],
          body: [],
          particleReads: NO_PARTICLE_READS,
        },
        fragment: {
          uniformDeclarations: ["uniform sampler2D u_grad$0;", "uniform sampler2D u_flame$1;"],
          helperFunctions: [],
          body: [],
          particleReads: NO_PARTICLE_READS,
          surfaceReads: NO_SURFACE_READS,
        },
        outputs: { albedo: "texture2D(u_grad$0, p_uv) * texture2D(u_flame$1, p_uv)" },
      },
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
      const { uniforms } = particlesOf(emitter).material as ShaderMaterial;
      expect(uniforms["u_grad$0"].value).toBe(gradient);
      expect(uniforms["u_flame$1"].value).toBe(flame);
    } finally {
      emitter.destroy();
    }
  });
});

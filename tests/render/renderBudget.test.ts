import { describe, expect, it } from "vitest";
import { ShaderChunk } from "three";
import type { FXRenderArtifact } from "../../src/artifact/FXArtifact";
import {
  buildArtifactDepthMaterial,
  buildArtifactMaterial,
  buildMeshArtifactMaterial,
} from "../../src/render/FXArtifactMaterial.Internal";
import {
  FX_RENDER_BUDGET_MINIMUMS,
  fxEmitterRenderBudget,
  fxMeshRenderBudget,
  packedVaryingVectors,
} from "../../src/render/FXRenderBudget";
import { varyingsFromComponents } from "../../src/emitter/FXEmitterDriver.Internal";
import { layoutOf, unlitArtifact } from "../helpers/artifacts";

const UNIFORMS = [{ value: 0 }, { value: 0 }, { value: [0, 0, 0] }, { value: [0, 0, 0] }] as const;

function lit(render: FXRenderArtifact): FXRenderArtifact {
  return { ...render, lightingIntrinsics: ["lambert"] };
}

/** A vec3 behavior attribute `tint`, read by the fragment stage or not. */
/** A render whose fragment stage reads the tint (`true`), only its vertex stage (`false`), or
 *  neither (`"never"`). */
function withTint(fragmentReads: boolean | "never"): FXRenderArtifact {
  return unlitArtifact({
    attributeReads: [{ name: "tint", components: 3 }],
    vertexBody: fragmentReads === false ? ["float fxTintSum = dot(p_fx_tint, vec3(1.0));"] : [],
    outputs: { albedo: fragmentReads === true ? "vec4(p_fx_tint, 1.0)" : "vec4(1.0)" },
  });
}

describe("packedVaryingVectors (GLSL ES packing rules)", () => {
  it("gives vec4s and vec3s a row each and pairs vec2s", () => {
    expect(packedVaryingVectors([])).toBe(0);
    expect(packedVaryingVectors([{ components: 4, count: 2 }])).toBe(2);
    expect(packedVaryingVectors([{ components: 3, count: 3 }])).toBe(3);
    expect(packedVaryingVectors([{ components: 2, count: 3 }])).toBe(2);
  });

  it("tucks floats into the free columns of vec3 rows and a lone vec2 row first", () => {
    // Three vec3 rows have three free columns.
    expect(
      packedVaryingVectors([
        { components: 3, count: 3 },
        { components: 1, count: 3 },
      ]),
    ).toBe(3);
    // A lone vec2 leaves two columns; the third float needs a row of its own.
    expect(
      packedVaryingVectors([
        { components: 2, count: 1 },
        { components: 1, count: 3 },
      ]),
    ).toBe(2);
    expect(packedVaryingVectors([{ components: 1, count: 9 }])).toBe(3);
  });
});

describe("particle varying compaction", () => {
  it("makes a property a varying only when the fragment stage reads it", () => {
    const varyings = varyingsFromComponents(new Map([["tint", 3]]));
    const unread = buildArtifactMaterial(withTint(false), layoutOf(varyings), ...UNIFORMS);
    expect(unread.fragmentShader).not.toMatch(/\bp_fx_tint\b/);
    // Still a vertex-stage global the generated vertex code can read.
    expect(unread.vertexShader).toMatch(/^vec3 p_fx_tint;$/m);
    expect(unread.vertexShader).toMatch(/^attribute vec3 a_fx_tint;$/m);

    const read = buildArtifactMaterial(withTint(true), layoutOf(varyings), ...UNIFORMS);
    expect(read.fragmentShader).toMatch(/^varying vec3 p_fx_tint;$/m);
    expect(read.vertexShader).toMatch(/^varying vec3 p_fx_tint;$/m);
  });

  it("declares no attribute for a held field the render never reads", () => {
    const varyings = varyingsFromComponents(new Map([["tint", 3]]));
    const never = buildArtifactMaterial(withTint("never"), layoutOf(varyings), ...UNIFORMS);
    expect(never.vertexShader).not.toMatch(/^attribute vec3 a_fx_tint;$/m);
    // The core buffers stay, read or not: the adapters place and hide particles by them.
    expect(never.vertexShader).toMatch(/^attribute vec3 a_position;$/m);
    expect(never.vertexShader).toMatch(/^attribute vec3 a_lifecycle;$/m);
  });

  it("counts the core buffers as read through their macros", () => {
    const render = unlitArtifact({ outputs: { albedo: "vec4(vec3(PARTICLE_AGE), 1.0)" } });
    const material = buildArtifactMaterial(
      render,
      layoutOf(varyingsFromComponents(new Map())),
      ...UNIFORMS,
    );
    expect(material.fragmentShader).toMatch(/^varying vec3 p_lifecycle;$/m);
    expect(material.fragmentShader).not.toMatch(/^varying vec3 p_position;$/m);
  });

  it("applies to the shadow depth material too", () => {
    const varyings = varyingsFromComponents(new Map([["tint", 3]]));
    const depth = buildArtifactDepthMaterial(withTint(false), layoutOf(varyings), ...UNIFORMS);
    expect(depth.fragmentShader).not.toMatch(/\bp_fx_tint\b/);
  });
});

describe("fxEmitterRenderBudget", () => {
  it("counts an unlit emitter: three's three attributes plus one per particle buffer", () => {
    // Fragment varyings: p_uv (vec2), p_cameraDistance (float), vWorldNormal/vWorldTangent/
    // vWorldPos and vNormal (vec3), vFogDepth (float) - 4 vec3 rows and a vec2 row; the floats fit
    // in the vec3 rows' free column.
    expect(fxEmitterRenderBudget(unlitArtifact(), [])).toEqual({
      attributes: 5,
      varyingVectors: 5,
    });
  });

  it("charges a varying only for an attribute the fragment stage reads", () => {
    const attributes = [{ name: "tint", components: 3 }] as const;
    expect(fxEmitterRenderBudget(withTint(false), attributes)).toEqual({
      attributes: 6,
      varyingVectors: 5,
    });
    expect(fxEmitterRenderBudget(withTint(true), attributes)).toEqual({
      attributes: 6,
      varyingVectors: 6,
    });
  });

  it("charges no attribute for a field only the behavior reads", () => {
    const attributes = [{ name: "tint", components: 3 }] as const;
    expect(fxEmitterRenderBudget(withTint("never"), attributes).attributes).toBe(5);
    expect(
      fxEmitterRenderBudget(withTint("never"), attributes, {
        kernelBuffers: [
          { name: "lifecycle", stride: 3 },
          { name: "position", stride: 3 },
          { name: "fx_tint", stride: 3 },
        ],
      }).attributes,
    ).toBe(5);
  });

  it("adds a lit material's view position and the assumed directional shadow", () => {
    expect(fxEmitterRenderBudget(lit(unlitArtifact()), [])).toEqual({
      attributes: 5,
      varyingVectors: 7,
    });
  });

  it("takes the larger of the color and shadow depth materials when casting shadows", () => {
    const render = unlitArtifact();
    const color = fxEmitterRenderBudget(render, []);
    const both = fxEmitterRenderBudget(render, [], { castShadow: true });
    expect(both.varyingVectors).toBeGreaterThanOrEqual(color.varyingVectors);
    expect(both.attributes).toBe(color.attributes);
  });

  it("finds a starter emitter within both tiers' minimums", () => {
    const budget = fxEmitterRenderBudget(unlitArtifact(), [{ name: "velocity", components: 3 }]);
    for (const minimum of Object.values(FX_RENDER_BUDGET_MINIMUMS)) {
      expect(budget.attributes).toBeLessThanOrEqual(minimum.attributes);
      expect(budget.varyingVectors).toBeLessThanOrEqual(minimum.varyingVectors);
    }
  });

  it("packs a matrix a stage bridge carries as its columns", () => {
    const base = unlitArtifact();
    const bridged = (types: readonly string[]): FXRenderArtifact => {
      const declarations = types.map((type, index) => `varying ${type} v_bridge${String(index)};`);
      return {
        ...base,
        vertex: { ...base.vertex, varyingDeclarations: declarations },
        fragment: { ...base.fragment, varyingDeclarations: declarations },
      };
    };
    const plain = fxEmitterRenderBudget(base, []).varyingVectors;
    expect(fxEmitterRenderBudget(bridged(["mat4"]), []).varyingVectors).toBe(plain + 4);
    expect(fxEmitterRenderBudget(bridged(["mat3"]), []).varyingVectors).toBe(plain + 3);
    // Two columns of two pair into one row - alongside the existing lone vec2 (p_uv) row.
    expect(fxEmitterRenderBudget(bridged(["mat2"]), []).varyingVectors).toBe(plain + 1);
  });

  it("counts a VFX mesh, which carries no particle state", () => {
    expect(fxMeshRenderBudget(unlitArtifact()).attributes).toBe(3);
  });
});

describe("render budget chunk table", () => {
  it("knows every three chunk that declares a varying in our fragment shaders", () => {
    // If three starts declaring varyings in another chunk, the budget would undercount it.
    const varyings = varyingsFromComponents(new Map());
    const shaders = [
      buildArtifactMaterial(unlitArtifact(), layoutOf(varyings), ...UNIFORMS),
      buildArtifactMaterial(lit(unlitArtifact()), layoutOf(varyings), ...UNIFORMS),
      buildArtifactDepthMaterial(lit(unlitArtifact()), layoutOf(varyings), ...UNIFORMS),
      buildMeshArtifactMaterial(lit(unlitArtifact()), ...UNIFORMS),
    ].map((material) => material.fragmentShader);
    const chunks = new Set(
      shaders.flatMap((shader) => [...shader.matchAll(/#include\s+<(\w+)>/g)].map((m) => m[1])),
    );
    const declaring = [...chunks].filter((chunk) =>
      /\bvarying\b/.test((ShaderChunk as Record<string, string>)[chunk] ?? ""),
    );
    expect(declaring.sort()).toEqual([
      "common",
      "fog_pars_fragment",
      "lights_lambert_pars_fragment",
      "normal_pars_fragment",
      "shadowmap_pars_fragment",
    ]);
  });
});

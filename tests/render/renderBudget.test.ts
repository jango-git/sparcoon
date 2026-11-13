import { ShaderChunk, type ShaderMaterial } from "three";
import { describe, expect, it } from "vitest";

import type { FXRenderArtifact } from "../../src/artifact/FXArtifact";
import { particleLayout, varyingsFromComponents } from "../../src/emitter/FXEmitterDriver.Internal";
import { particleSlotLayout } from "../../src/instancedParticle/FXParticleSlot";
import {
  buildArtifactDepthMaterial,
  buildArtifactMaterial,
  buildMeshArtifactMaterial,
  createMaterialSlots,
  type FXMaterialSlots,
} from "../../src/render/FXArtifactMaterial.Internal";
import {
  FX_RENDER_BUDGET_MINIMUMS,
  fxEmitterRenderBudget,
  fxGraphUniformAllowance,
  fxGraphVaryingAllowance,
  fxMeshRenderBudget,
  fxPackedShape,
  packedVectors,
  trailMaterialBudget,
} from "../../src/render/FXRenderBudget";
import { layoutOf, unlitArtifact } from "../helpers/artifacts";

/** Live slots for a material under test: what they hold never changes what it declares. */
function slots(): FXMaterialSlots {
  return createMaterialSlots(unlitArtifact());
}

function lit(render: FXRenderArtifact): FXRenderArtifact {
  return { ...render, lightingIntrinsics: ["fxLambertShade"] };
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

describe("packedVectors (GLSL ES packing rules)", () => {
  it("gives vec4s and vec3s a row each and pairs vec2s", () => {
    expect(packedVectors([])).toBe(0);
    expect(packedVectors([{ components: 4, count: 2 }])).toBe(2);
    expect(packedVectors([{ components: 3, count: 3 }])).toBe(3);
    expect(packedVectors([{ components: 2, count: 3 }])).toBe(2);
  });

  it("tucks floats into the free columns of vec3 rows and a lone vec2 row first", () => {
    // Three vec3 rows have three free columns.
    expect(
      packedVectors([
        { components: 3, count: 3 },
        { components: 1, count: 3 },
      ]),
    ).toBe(3);
    // A lone vec2 leaves two columns; the third float needs a row of its own.
    expect(
      packedVectors([
        { components: 2, count: 1 },
        { components: 1, count: 3 },
      ]),
    ).toBe(2);
    expect(packedVectors([{ components: 1, count: 9 }])).toBe(3);
  });
});

describe("particle varying compaction", () => {
  it("makes a property a varying only when the fragment stage reads it", () => {
    const varyings = varyingsFromComponents(new Map([["tint", 3]]));
    const unread = buildArtifactMaterial(withTint(false), layoutOf(varyings), slots());
    expect(unread.fragmentShader).not.toMatch(/\bp_fx_tint\b/);
    // Still a vertex-stage global the generated vertex code can read.
    expect(unread.vertexShader).toMatch(/^vec3 p_fx_tint;$/m);
    expect(unread.vertexShader).toMatch(/^attribute vec3 a_fx_tint;$/m);

    const read = buildArtifactMaterial(withTint(true), layoutOf(varyings), slots());
    expect(read.fragmentShader).toMatch(/^varying vec3 p_fx_tint;$/m);
    expect(read.vertexShader).toMatch(/^varying vec3 p_fx_tint;$/m);
  });

  it("declares no attribute for a held field the render never reads", () => {
    const slot = particleSlotLayout([
      { name: "position", stride: 3 },
      { name: "lifecycle", stride: 3 },
      { name: "tint", stride: 3 },
    ]);
    const layout = particleLayout(slot, withTint("never"));
    const never = buildArtifactMaterial(withTint("never"), layout, slots());
    expect(never.vertexShader).not.toMatch(/\bp_fx_tint\b/);
    // The core buffers stay, read or not: the adapters place and hide particles by them.
    expect(never.vertexShader).toContain("p_position = a_pack0;");
    expect(never.vertexShader).toContain("p_lifecycle = a_pack1;");
    expect(never.vertexShader.match(/^attribute /gm)).toHaveLength(2);
  });

  it("counts the core buffers as read through their macros", () => {
    const render = unlitArtifact({ outputs: { albedo: "vec4(vec3(PARTICLE_AGE), 1.0)" } });
    const material = buildArtifactMaterial(
      render,
      layoutOf(varyingsFromComponents(new Map())),
      slots(),
    );
    expect(material.fragmentShader).toMatch(/^varying vec3 p_lifecycle;$/m);
    expect(material.fragmentShader).not.toMatch(/^varying vec3 p_position;$/m);
  });

  it("applies to the shadow depth material too", () => {
    const varyings = varyingsFromComponents(new Map([["tint", 3]]));
    const depth = buildArtifactDepthMaterial(withTint(false), layoutOf(varyings), slots());
    expect(depth.fragmentShader).not.toMatch(/\bp_fx_tint\b/);
  });
});

// A behavior's slot: the core fields, then `fields` as declared.
function slot(...fields: { name: string; stride: number }[]): { name: string; stride: number }[] {
  return [{ name: "position", stride: 3 }, { name: "lifecycle", stride: 3 }, ...fields];
}

describe("fxEmitterRenderBudget", () => {
  it("counts an unlit emitter: three's three attributes plus one per packed view", () => {
    // Fragment varyings: p_uv (vec2), p_cameraDistance (float), vFogDepth (float) - one vec2 row,
    // the floats in its free half. The surface frame reads nothing, so it adds no varying.
    expect(fxEmitterRenderBudget(unlitArtifact(), slot())).toMatchObject({
      attributes: 5,
      varyingVectors: 1,
    });
  });

  it("charges a row for each surface builtin the fragment reads", () => {
    const reading = (code: string): number =>
      fxEmitterRenderBudget(unlitArtifact({ fragmentBody: [code] }), slot()).varyingVectors;
    expect(reading("vec3 n = geometryNormal;")).toBe(2);
    expect(reading("vec3 n = geometryNormal + geometryTangent + worldPosition;")).toBe(4);
  });

  it("charges a varying only for an attribute the fragment stage reads", () => {
    const attributes = slot({ name: "tint", stride: 3 });
    expect(fxEmitterRenderBudget(withTint(false), attributes)).toMatchObject({
      attributes: 6,
      varyingVectors: 1,
    });
    expect(fxEmitterRenderBudget(withTint(true), attributes)).toMatchObject({
      attributes: 6,
      varyingVectors: 2,
    });
  });

  it("charges no attribute for a field only the behavior reads", () => {
    expect(
      fxEmitterRenderBudget(withTint("never"), slot({ name: "tint", stride: 3 })).attributes,
    ).toBe(5);
    // Packed beside a read field, it shares that field's view and costs nothing either.
    expect(
      fxEmitterRenderBudget(withTint("never"), slot({ name: "glow", stride: 1 })).attributes,
    ).toBe(5);
  });

  it("adds a lit material's view normal and position and the assumed directional shadow", () => {
    // Over the unlit row: vNormal and vViewPosition (vec3, three's light chain) and the shadow
    // coordinate (vec4).
    expect(fxEmitterRenderBudget(lit(unlitArtifact()), slot())).toMatchObject({
      attributes: 5,
      varyingVectors: 4,
    });
  });

  it("takes the larger of the color and shadow depth materials when casting shadows", () => {
    const render = unlitArtifact();
    const color = fxEmitterRenderBudget(render, slot());
    const both = fxEmitterRenderBudget(render, slot(), { castShadow: true });
    expect(both.varyingVectors).toBeGreaterThanOrEqual(color.varyingVectors);
    expect(both.attributes).toBe(color.attributes);
  });

  it("finds a starter emitter within both tiers' minimums", () => {
    const budget = fxEmitterRenderBudget(unlitArtifact(), slot({ name: "velocity", stride: 3 }));
    for (const minimum of Object.values(FX_RENDER_BUDGET_MINIMUMS)) {
      expect(budget.attributes).toBeLessThanOrEqual(minimum.attributes);
      expect(budget.varyingVectors).toBeLessThanOrEqual(minimum.varyingVectors);
    }
  });

  it("packs a matrix a stage bridge carries as its columns", () => {
    const base = unlitArtifact();
    const bridged = (types: readonly string[]): FXRenderArtifact => ({
      ...base,
      color: {
        ...base.color,
        varyings: types.map((type, index) => ({
          name: `v_bridge${String(index)}`,
          type,
          interpolation: "smooth",
        })),
      },
    });
    const plain = fxEmitterRenderBudget(base, slot()).varyingVectors;
    expect(fxEmitterRenderBudget(bridged(["mat4"]), slot()).varyingVectors).toBe(plain + 4);
    expect(fxEmitterRenderBudget(bridged(["mat3"]), slot()).varyingVectors).toBe(plain + 3);
    // Two columns of two pair into one row - alongside the existing lone vec2 (p_uv) row.
    expect(fxEmitterRenderBudget(bridged(["mat2"]), slot()).varyingVectors).toBe(plain + 1);
  });

  it("counts what the shadow program carries when the emitter casts a shadow", () => {
    const base = unlitArtifact();
    const carried = [
      { name: "v_bridge0", type: "vec4", interpolation: "smooth" as const },
      { name: "v_bridge1", type: "vec4", interpolation: "smooth" as const },
      { name: "v_bridge2", type: "vec4", interpolation: "smooth" as const },
    ];
    const shadowing: FXRenderArtifact = { ...base, shadow: { ...base.shadow!, varyings: carried } };
    const color = fxEmitterRenderBudget(shadowing, slot()).varyingVectors;
    // The color program carries nothing, so only a shadowed budget sees the shadow's three rows.
    expect(color).toBe(fxEmitterRenderBudget(base, slot()).varyingVectors);
    expect(fxEmitterRenderBudget(shadowing, slot(), { castShadow: true }).varyingVectors).toBe(
      fxEmitterRenderBudget(base, slot(), { castShadow: true }).varyingVectors + 3,
    );
  });

  it("counts a flat varying as any other", () => {
    const base = unlitArtifact();
    const carrying = (interpolation: "smooth" | "flat"): number =>
      fxEmitterRenderBudget(
        {
          ...base,
          color: { ...base.color, varyings: [{ name: "v_bridge0", type: "vec4", interpolation }] },
        },
        slot(),
      ).varyingVectors;
    expect(carrying("flat")).toBe(carrying("smooth"));
    expect(carrying("flat")).toBe(fxEmitterRenderBudget(base, slot()).varyingVectors + 1);
  });

  it("leaves a graph what the heaviest particle material does not take", () => {
    const none = { normal: false, tangent: false, position: false };
    const lambert = ["fxLambertShade"];
    // Lit, alpha-hashed and shadowed: p_uv (vec2) and two floats, vNormal, vViewPosition and
    // vPosition (vec3), the shadow coordinate (vec4) - five rows.
    expect(fxGraphVaryingAllowance("standard", none, lambert)).toBe(15 - 5);
    expect(fxGraphVaryingAllowance("baseline", none, lambert)).toBe(8 - 5);
    // Each surface builtin read is one more vec3 row.
    expect(
      fxGraphVaryingAllowance("standard", { ...none, normal: true, position: true }, lambert),
    ).toBe(8);
  });

  it("reserves no lighting for an unlit graph, still the worst render mode and shadow", () => {
    const none = { normal: false, tangent: false, position: false };
    // Unlit, alpha-hashed and shadowed: p_uv (vec2) and two floats, vPosition (vec3) - two rows.
    expect(fxGraphVaryingAllowance("baseline", none, [])).toBe(8 - 2);
    expect(fxGraphVaryingAllowance("baseline", none, [])).toBeGreaterThan(
      fxGraphVaryingAllowance("baseline", none, ["fxLambertShade"]),
    );
  });

  it("shapes a varying by the packing rule it is counted with", () => {
    expect(fxPackedShape("vec3")).toEqual({ components: 3, count: 1 });
    expect(fxPackedShape("mat3")).toEqual({ components: 3, count: 3 });
    expect(fxPackedShape("ivec2")).toEqual({ components: 2, count: 1 });
    expect(() => fxPackedShape("sampler2D")).toThrow(/no packing rule/);
  });

  it("counts a VFX mesh, which carries no particle state", () => {
    expect(fxMeshRenderBudget(unlitArtifact()).attributes).toBe(3);
  });
});

describe("render budget chunk table", () => {
  it("counts the varyings of every three chunk that declares one in our fragment shaders", () => {
    // If three starts declaring varyings in another chunk, the budget would undercount it.
    const varyings = varyingsFromComponents(new Map());
    const shaders = [
      buildArtifactMaterial(unlitArtifact(), layoutOf(varyings), slots()),
      buildArtifactMaterial(lit(unlitArtifact()), layoutOf(varyings), slots()),
      buildArtifactDepthMaterial(lit(unlitArtifact()), layoutOf(varyings), slots()),
      buildMeshArtifactMaterial(lit(unlitArtifact()), slots()),
    ].map((material) => material.fragmentShader);
    const chunks = new Set(
      shaders.flatMap((shader) => [...shader.matchAll(/#include\s+<(\w+)>/g)].map((m) => m[1])),
    );
    const declaring = [...chunks].filter((chunk) =>
      /\bvarying\b/.test((ShaderChunk as Record<string, string>)[chunk] ?? ""),
    );
    expect(declaring.length).toBeGreaterThan(0);
    // A fragment shader of that chunk alone, counted as the budget counts one (alphaHash on: a
    // chunk may declare its varying under that define only).
    const countedVectors = (chunk: string): number =>
      trailMaterialBudget(
        { vertexShader: "", fragmentShader: `#include <${chunk}>` } as ShaderMaterial,
        true,
      ).varyingVectors;
    expect(declaring.filter((chunk) => countedVectors(chunk) === 0)).toEqual([]);
  });
});

describe("render budget: uniforms and texture units", () => {
  const varyings = varyingsFromComponents(new Map());
  const budget = (render: FXRenderArtifact, castShadow = false) =>
    fxEmitterRenderBudget(render, slot(), { castShadow });

  it("counts a graph uniform in each stage that reads it, a sampler as a unit of that stage", () => {
    const base = budget(unlitArtifact());
    const withUniform = budget(
      unlitArtifact({
        uniformDeclarations: ["uniform vec4 u_param_tint;", "uniform sampler2D u_param_sheet;"],
        vertexBody: ["vec4 _0 = u_param_tint;"],
        outputs: { albedo: "u_param_tint * texture2D(u_param_sheet, p_uv)" },
      }),
    );
    expect(withUniform.vertexUniformVectors).toBe(base.vertexUniformVectors + 1);
    expect(withUniform.fragmentUniformVectors).toBe(base.fragmentUniformVectors + 1);
    expect(withUniform.fragmentSamplers).toBe(base.fragmentSamplers + 1);
    // Only the fragment stage samples it: a GPU with no vertex texture units still draws it.
    expect(withUniform.vertexSamplers).toBe(base.vertexSamplers);
  });

  it("adds the lights, the probe and the assumed directional shadow to a lit material", () => {
    const unlit = budget(unlitArtifact());
    const lit_ = budget(lit(unlitArtifact()));
    // At least the probe's nine rows and the light's direction and color.
    expect(lit_.fragmentUniformVectors).toBeGreaterThanOrEqual(unlit.fragmentUniformVectors + 11);
    expect(lit_.fragmentSamplers).toBe(unlit.fragmentSamplers + 1); // directionalShadowMap
    expect(lit_.vertexUniformVectors).toBeGreaterThan(unlit.vertexUniformVectors); // shadow matrix
  });

  it("keeps three's own materials within the Baseline floor", () => {
    const heaviest = budget(lit(unlitArtifact()), true);
    const floor = FX_RENDER_BUDGET_MINIMUMS.baseline;
    expect(heaviest.fragmentUniformVectors).toBeLessThan(floor.fragmentUniformVectors);
    expect(heaviest.vertexUniformVectors).toBeLessThan(floor.vertexUniformVectors);
  });

  it("counts the uniforms of every three chunk that declares one in our shaders", () => {
    // If three starts declaring uniforms in another chunk, the budget would undercount it.
    const materials = [
      buildArtifactMaterial(unlitArtifact(), layoutOf(varyings), slots()),
      buildArtifactMaterial(lit(unlitArtifact()), layoutOf(varyings), slots()),
      buildArtifactDepthMaterial(lit(unlitArtifact()), layoutOf(varyings), slots()),
      buildMeshArtifactMaterial(lit(unlitArtifact()), slots()),
    ];
    const empty = trailMaterialBudget(
      { vertexShader: "", fragmentShader: "" } as ShaderMaterial,
      true,
    );
    for (const stage of ["vertexShader", "fragmentShader"] as const) {
      const chunks = new Set(
        materials.flatMap((material) =>
          [...material[stage].matchAll(/#include\s+<(\w+)>/g)].map((m) => m[1]),
        ),
      );
      const declaring = [...chunks].filter((chunk) =>
        /^\s*uniform\s/m.test((ShaderChunk as Record<string, string>)[chunk] ?? ""),
      );
      const counted = (chunk: string): boolean => {
        const only = trailMaterialBudget(
          {
            vertexShader: "",
            fragmentShader: "",
            [stage]: `#include <${chunk}>`,
          } as unknown as ShaderMaterial,
          true,
        );
        return stage === "vertexShader"
          ? only.vertexUniformVectors > empty.vertexUniformVectors
          : only.fragmentUniformVectors > empty.fragmentUniformVectors ||
              only.fragmentSamplers > empty.fragmentSamplers;
      };
      expect(declaring.length).toBeGreaterThan(0);
      expect(declaring.filter((chunk) => !counted(chunk))).toEqual([]);
    }
  });
});

describe("render budget: external textures and the graph's uniform room", () => {
  const external = (name: string): FXRenderArtifact =>
    unlitArtifact({
      uniformDeclarations: [`uniform sampler2D ${name};`],
      uniforms: { [name]: { type: "sampler2D", external: name } },
      outputs: { albedo: `${"fxSample_" + name}(p_uv)` },
    });

  it("counts an external texture bound the heaviest way: a unit and its masked window", () => {
    const base = fxEmitterRenderBudget(unlitArtifact(), slot());
    const sampled = fxEmitterRenderBudget(external("u_param_sheet"), slot());
    expect(sampled.fragmentSamplers).toBe(base.fragmentSamplers + 1);
    // The window's two vec3 rows and its vec4 bounds - less the floats the new vec3 rows take in.
    expect(sampled.fragmentUniformVectors).toBeGreaterThan(base.fragmentUniformVectors);
    expect(sampled.vertexUniformVectors).toBe(base.vertexUniformVectors);
  });

  it("leaves a graph the smaller stage's room, less each external slot's window", () => {
    const none = { normal: false, tangent: false, position: false };
    const unlit = fxGraphUniformAllowance("baseline", none, [], []);
    expect(unlit).toBeGreaterThan(0);
    // Baseline's fragment stage has the less room; the window takes from it what it takes above.
    const window =
      fxEmitterRenderBudget(external("u_param_sheet"), slot()).fragmentUniformVectors -
      fxEmitterRenderBudget(unlitArtifact(), slot()).fragmentUniformVectors;
    expect(fxGraphUniformAllowance("baseline", none, [], ["u_param_sheet"])).toBe(unlit - window);
    expect(fxGraphUniformAllowance("baseline", none, ["fxLambertShade"], [])).toBeLessThan(unlit);
    expect(fxGraphUniformAllowance("standard", none, [], [])).toBeGreaterThan(unlit);
  });
});

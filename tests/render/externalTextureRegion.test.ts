import { describe, expect, it } from "vitest";
import { Texture, type ShaderMaterial } from "three";
import { FXArtifactMaterial } from "../../src/render/FXArtifactMaterial";
import type { FXTextureRegion } from "../../src/render/FXExternalTexture";
import { fxAtlasRegion } from "../../src/miscellaneous/texture/fxAtlasRegion";
import { fxExternalSampleFunction } from "../../src/render/FXExternalTexture.Internal";
import type { FXRenderArtifact } from "../../src/artifact/FXArtifact";
import type { GLTypeInfo } from "../../src/instancedParticle/glTypeInfo";
import {
  NO_PARTICLE_READS,
  NO_SURFACE_READS,
  VEC2_VARYING,
  VEC3_VARYING,
  layoutOf,
} from "../helpers/artifacts";

const ATLAS_W = 100;
const ATLAS_H = 200;

function atlasTexture(): Texture {
  const texture = new Texture();
  texture.image = { width: ATLAS_W, height: ATLAS_H };
  return texture;
}

/** Where the region maps a slot UV. */
function mapUV(region: FXTextureRegion, u: number, v: number): [number, number] {
  const [a, b, c, d, e, f] = region.uvTransform;
  return [a * u + b * v + c, d * u + e * v + f];
}

/** A pixel of the atlas (origin top-left, as packers write it) as a GL UV (V up). */
function atlasUV(x: number, y: number): [number, number] {
  return [x / ATLAS_W, 1 - y / ATLAS_H];
}

function expectUV(actual: [number, number], expected: [number, number]): void {
  expect(actual[0]).toBeCloseTo(expected[0], 10);
  expect(actual[1]).toBeCloseTo(expected[1], 10);
}

describe("fxAtlasRegion", () => {
  it("maps the slot's UV square onto an unrotated, untrimmed frame", () => {
    const region = fxAtlasRegion(atlasTexture(), { frame: { x: 10, y: 20, w: 30, h: 40 } });
    // Slot bottom-left is the frame's bottom-left; top-right its top-right.
    expectUV(mapUV(region, 0, 0), atlasUV(10, 60));
    expectUV(mapUV(region, 1, 1), atlasUV(40, 20));
    expect(region.uvBounds).toBeUndefined();
  });

  it("maps a frame stored 90 degrees clockwise", () => {
    // Unrotated 30x40, so stored 40 wide and 30 tall at (10, 20).
    const region = fxAtlasRegion(atlasTexture(), {
      frame: { x: 10, y: 20, w: 30, h: 40 },
      rotated: true,
    });
    // Clockwise: the sprite's left edge becomes the stored top edge.
    expectUV(mapUV(region, 0, 1), atlasUV(50, 20)); // top-left -> top-right
    expectUV(mapUV(region, 0, 0), atlasUV(10, 20)); // bottom-left -> top-left
    expectUV(mapUV(region, 1, 1), atlasUV(50, 50)); // top-right -> bottom-right
    expectUV(mapUV(region, 1, 0), atlasUV(10, 50)); // bottom-right -> bottom-left
  });

  it("spans the untrimmed source and masks the trimmed margins", () => {
    // A 50x60 source trimmed to 30x40 at (5, 10).
    const sprite = {
      frame: { x: 10, y: 20, w: 30, h: 40 },
      spriteSourceSize: { x: 5, y: 10, w: 30, h: 40 },
      sourceSize: { w: 50, h: 60 },
    };
    const region = fxAtlasRegion(atlasTexture(), sprite);
    if (region.uvBounds === undefined) {
      throw new Error("a frame region has uv bounds");
    }
    const [minU, minV, maxU, maxV] = region.uvBounds;
    expect(minU).toBeCloseTo(5 / 50, 10);
    expect(minV).toBeCloseTo(1 - 50 / 60, 10);
    expect(maxU).toBeCloseTo(35 / 50, 10);
    expect(maxV).toBeCloseTo(1 - 10 / 60, 10);
    // The bounds' corners land on the frame's corners.
    expectUV(mapUV(region, minU, minV), atlasUV(10, 60));
    expectUV(mapUV(region, maxU, maxV), atlasUV(40, 20));

    const rotated = fxAtlasRegion(atlasTexture(), { ...sprite, rotated: true });
    expect(rotated.uvBounds).toEqual(region.uvBounds);
    expectUV(mapUV(rotated, minU, maxV), atlasUV(50, 20));
    expectUV(mapUV(rotated, maxU, minV), atlasUV(10, 50));
  });

  it("drops the mask when spriteSourceSize covers the whole source", () => {
    const region = fxAtlasRegion(atlasTexture(), {
      frame: { x: 10, y: 20, w: 30, h: 40 },
      spriteSourceSize: { x: 0, y: 0, w: 30, h: 40 },
      sourceSize: { w: 30, h: 40 },
    });
    expect(region.uvBounds).toBeUndefined();
  });

  it("takes the packer's atlas size, so the image need not be loaded", () => {
    const sprite = { frame: { x: 10, y: 20, w: 30, h: 40 } };
    const fromSize = fxAtlasRegion(new Texture(), sprite, { w: ATLAS_W, h: ATLAS_H });
    expect(fromSize.uvTransform).toEqual(fxAtlasRegion(atlasTexture(), sprite).uvTransform);
    expect(() => fxAtlasRegion(new Texture(), sprite, { w: 0, h: 1 })).toThrow(RangeError);
  });

  it("throws on an unloaded texture, a bad frame, or a trim without the source size", () => {
    const frame = { x: 0, y: 0, w: 1, h: 1 };
    expect(() => fxAtlasRegion(new Texture(), { frame })).toThrow(/atlas size is unknown/);
    expect(() => fxAtlasRegion(atlasTexture(), { frame: { ...frame, w: 0 } })).toThrow(RangeError);
    expect(() =>
      fxAtlasRegion(atlasTexture(), { frame, spriteSourceSize: { x: 0, y: 0, w: 1, h: 1 } }),
    ).toThrow(/needs sourceSize/);
  });
});

describe("external texture sampling variants", () => {
  const SAMPLER = "u_param_flame";
  const sample = fxExternalSampleFunction(SAMPLER);

  const render = (): FXRenderArtifact => ({
    lightingIntrinsics: [],
    sceneDepth: false,
    varyings: [],
    vertex: {
      uniformDeclarations: [],
      helperFunctions: [],
      body: [],
      particleReads: NO_PARTICLE_READS,
    },
    fragment: {
      uniformDeclarations: [`uniform sampler2D ${SAMPLER};`],
      helperFunctions: [],
      body: [],
      particleReads: NO_PARTICLE_READS,
      surfaceReads: NO_SURFACE_READS,
    },
    outputs: { albedo: `${sample}(p_uv)` },
    uniforms: { [SAMPLER]: { type: "sampler2D", external: SAMPLER } },
    attributeReads: [],
  });

  const layout = layoutOf({
    position: VEC3_VARYING,
    lifecycle: VEC2_VARYING,
  } satisfies Record<string, GLTypeInfo>);

  const region = (bounds: boolean): FXTextureRegion => ({
    texture: new Texture(),
    uvTransform: [0.5, 0, 0.25, 0, 0.5, 0.125],
    ...(bounds ? { uvBounds: [0.1, 0.2, 0.9, 0.8] as const } : {}),
  });

  function build(bound: Texture | FXTextureRegion): {
    driver: FXArtifactMaterial;
    material: ShaderMaterial;
  } {
    const driver = new FXArtifactMaterial(render(), { [SAMPLER]: bound });
    return { driver, material: driver.buildThreeMaterial(layout) as ShaderMaterial };
  }

  it("samples a whole texture through a macro: no extra uniform, no extra instruction", () => {
    const texture = new Texture();
    const { material } = build(texture);
    expect(material.fragmentShader).toContain(`#define ${sample}(uv) texture2D(${SAMPLER}, (uv))`);
    expect(material.fragmentShader).not.toContain("fxRegion");
    expect(material.uniforms[SAMPLER].value).toBe(texture);
    expect(Object.keys(material.uniforms).some((name) => name.startsWith("fxRegion"))).toBe(false);
  });

  it("maps a region slot's UV through its window, masking only when it has bounds", () => {
    const unmasked = build(region(false)).material;
    expect(unmasked.fragmentShader).toContain(`vec4 ${sample}(vec2 uv) {`);
    expect(unmasked.fragmentShader).toContain("clamp(uv, 0.0, 1.0)");
    expect(unmasked.fragmentShader).not.toContain(`fxRegionBounds_${SAMPLER}`);
    expect(unmasked.uniforms[`fxRegionU_${SAMPLER}`].value).toEqual([0.5, 0, 0.25]);
    expect(unmasked.uniforms[`fxRegionV_${SAMPLER}`].value).toEqual([0, 0.5, 0.125]);

    const masked = build(region(true)).material;
    expect(masked.fragmentShader).toContain(`uniform vec4 fxRegionBounds_${SAMPLER};`);
    expect(masked.uniforms[`fxRegionBounds_${SAMPLER}`].value).toEqual([0.1, 0.2, 0.9, 0.8]);
  });

  it("gives each variant its own program cache key", () => {
    const key = (bound: Texture | FXTextureRegion): string =>
      build(bound).material.customProgramCacheKey();
    const plain = key(new Texture());
    expect(key(new Texture())).toBe(plain);
    expect(key(region(false))).not.toBe(plain);
    expect(key(region(true))).not.toBe(key(region(false)));
    expect(key(region(true))).toBe(key(region(true)));
  });

  it("swaps values within a variant, never across one", () => {
    const { driver, material } = build(region(true));
    const next = region(false);
    driver.applyUniformValues({ [SAMPLER]: next });
    expect(material.uniforms[SAMPLER].value).toBe(next.texture);
    // An unmasked region in a masked slot leaves everything visible.
    expect(material.uniforms[`fxRegionBounds_${SAMPLER}`].value).toEqual([0, 0, 1, 1]);
    // A whole texture fits a region slot: the identity window.
    const whole = new Texture();
    driver.applyUniformValues({ [SAMPLER]: whole });
    expect(material.uniforms[SAMPLER].value).toBe(whole);
    expect(material.uniforms[`fxRegionU_${SAMPLER}`].value).toEqual([1, 0, 0]);
    expect(material.uniforms[`fxRegionV_${SAMPLER}`].value).toEqual([0, 1, 0]);

    const plain = build(new Texture()).driver;
    expect(() => plain.applyUniformValues({ [SAMPLER]: region(false) })).toThrow(
      /bound to a whole texture/,
    );
    const unmasked = build(region(false)).driver;
    expect(() => unmasked.applyUniformValues({ [SAMPLER]: region(true) })).toThrow(
      /region without uvBounds/,
    );
  });

  it("writes nothing when any value of an edit is rejected", () => {
    const { driver, material } = build(region(false));
    const before = material.uniforms[SAMPLER].value as Texture;
    const rowU = [...(material.uniforms[`fxRegionU_${SAMPLER}`].value as number[])];
    expect(() => driver.applyUniformValues({ [SAMPLER]: region(true) })).toThrow();
    expect(material.uniforms[SAMPLER].value).toBe(before);
    expect(material.uniforms[`fxRegionU_${SAMPLER}`].value).toEqual(rowU);
    expect(() => driver.assertUniformValues({ [SAMPLER]: region(true) })).toThrow();
    expect(() => driver.assertUniformValues({ [SAMPLER]: new Texture() })).not.toThrow();
  });

  it("swaps a region in place, keeping the uniform arrays three uploads from", () => {
    const { driver, material } = build(region(false));
    const rowU = material.uniforms[`fxRegionU_${SAMPLER}`].value as number[];
    driver.applyUniformValues({
      [SAMPLER]: { texture: new Texture(), uvTransform: [0.25, 0, 0.5, 0, 0.25, 0.75] },
    });
    expect(material.uniforms[`fxRegionU_${SAMPLER}`].value).toBe(rowU);
    expect(rowU).toEqual([0.25, 0, 0.5]);
  });
});

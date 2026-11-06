import type { ShaderMaterial } from "three";
import type {
  FXAttributeDecl,
  FXGLSLRenderTier,
  FXRenderArtifact,
} from "../artifact/FXArtifact.js";
import {
  mergeAttributeWidths,
  varyingsFromComponents,
} from "../emitter/FXEmitterDriver.Internal.js";
import {
  buildArtifactDepthMaterial,
  buildArtifactMaterial,
  buildMeshArtifactDepthMaterial,
  buildMeshArtifactMaterial,
  type FXFrameTimeUniform,
  type FXFrameVec3Uniform,
} from "./FXArtifactMaterial.Internal.js";

/**
 * What one render artifact's materials take of the two vertex-to-fragment resources a GPU has
 * the fewest of: vertex attributes, and varying vectors (4-component rows the varyings pack into).
 * The larger of the color and (when it casts shadows) depth material's needs.
 */
export interface FXRenderBudget {
  readonly attributes: number;
  readonly varyingVectors: number;
}

/**
 * The least of each resource every GPU of a tier offers: WebGL2's guaranteed minimums for
 * Standard, WebGL1's for Baseline. A budget within them runs anywhere the tier runs.
 */
export const FX_RENDER_BUDGET_MINIMUMS: Readonly<Record<FXGLSLRenderTier, FXRenderBudget>> = {
  standard: { attributes: 16, varyingVectors: 15 },
  baseline: { attributes: 8, varyingVectors: 8 },
};

/**
 * Assumed of the host scene, which a budget cannot see: fog on, and one shadow-casting directional
 * light (a lit effect needs a directional light anyway). Each further shadow-casting light a lit
 * material receives from takes one more varying vector.
 */
const ASSUMED_DIRECTIONAL_SHADOWS = 1;

interface FXVarying {
  /** Components of one element: 1 (float) to 4 (vec4). */
  readonly components: number;
  readonly count: number;
}

/**
 * Each varying type as the vectors it packs as: a matN as N columns of an N-vector (a mat2 then
 * pairs up into one row, as the packing rules place it), an integer type like its float twin.
 */
const PACKED_SHAPES: Readonly<
  Partial<Record<string, { readonly components: number; readonly vectors: number }>>
> = {
  float: { components: 1, vectors: 1 },
  vec2: { components: 2, vectors: 1 },
  vec3: { components: 3, vectors: 1 },
  vec4: { components: 4, vectors: 1 },
  int: { components: 1, vectors: 1 },
  ivec2: { components: 2, vectors: 1 },
  ivec3: { components: 3, vectors: 1 },
  ivec4: { components: 4, vectors: 1 },
  mat2: { components: 2, vectors: 2 },
  mat3: { components: 3, vectors: 3 },
  mat4: { components: 4, vectors: 4 },
};

/**
 * The varyings three's shader chunks declare in a fragment shader, by chunk, under the defines our
 * materials compile with. Kept in step with three by a test that reads the chunks themselves.
 */
function chunkVaryings(chunk: string, alphaHash: boolean): readonly FXVarying[] {
  switch (chunk) {
    case "common":
      return alphaHash ? [{ components: 3, count: 1 }] : []; // vPosition
    case "normal_pars_fragment":
      return [{ components: 3, count: 1 }]; // vNormal (not FLAT_SHADED, no USE_TANGENT)
    case "fog_pars_fragment":
      return [{ components: 1, count: 1 }]; // vFogDepth
    case "lights_lambert_pars_fragment":
      return [{ components: 3, count: 1 }]; // vViewPosition
    case "shadowmap_pars_fragment":
      return [{ components: 4, count: ASSUMED_DIRECTIONAL_SHADOWS }]; // vDirectionalShadowCoord[]
    default:
      return [];
  }
}

/** Every varying `fragmentShader` declares, its own lines and its chunks' alike. */
function fragmentVaryings(fragmentShader: string, alphaHash: boolean): readonly FXVarying[] {
  const varyings: FXVarying[] = [];
  for (const match of fragmentShader.matchAll(
    /^\s*varying\s+(?:(?:lowp|mediump|highp)\s+)?(\w+)\s+\w+\s*(?:\[\s*(\d+)\s*\])?\s*;/gm,
  )) {
    const [, type, arraySize] = match as unknown as [string, string, string | undefined];
    const shape = PACKED_SHAPES[type];
    if (shape === undefined) {
      throw new Error(`fxRenderBudget: no packing rule for varying type "${type}"`);
    }
    const count = arraySize === undefined ? 1 : Number(arraySize);
    varyings.push({ components: shape.components, count: count * shape.vectors });
  }
  for (const match of fragmentShader.matchAll(/^\s*#include\s+<(\w+)>/gm)) {
    varyings.push(...chunkVaryings(match[1], alphaHash));
  }
  return varyings;
}

/**
 * The varying vectors `varyings` pack into under GLSL ES's packing rules (GLSL ES 1.00, appendix
 * A.7) - which every implementation must accept, so this is what is guaranteed to link: each vec4
 * and vec3 takes a row, two vec2s share one, and floats fill the fourth column of vec3 rows and the
 * free half of a lone vec2 row before taking rows of four.
 */
export function packedVaryingVectors(
  varyings: readonly { readonly components: number; readonly count: number }[],
): number {
  const total = (components: number): number =>
    varyings
      .filter((varying) => varying.components === components)
      .reduce((sum, varying) => sum + varying.count, 0);
  const vec4s = total(4);
  const vec3s = total(3);
  const vec2s = total(2);
  const floats = total(1);
  const vec2Rows = Math.ceil(vec2s / 2);
  const freeColumns = vec3s + (vec2s % 2 === 1 ? 2 : 0);
  return vec4s + vec3s + vec2Rows + Math.ceil(Math.max(0, floats - freeColumns) / 4);
}

/** The attribute slots `vertexShader` takes: three's position, uv and normal, plus its own. */
function vertexAttributes(vertexShader: string): number {
  const own = [...vertexShader.matchAll(/^\s*attribute\s+\w+\s+\w+\s*;/gm)].length;
  return 3 + own;
}

function budgetOf(materials: readonly ShaderMaterial[], alphaHash: boolean): FXRenderBudget {
  let attributes = 0;
  let varyingVectors = 0;
  for (const material of materials) {
    attributes = Math.max(attributes, vertexAttributes(material.vertexShader));
    varyingVectors = Math.max(
      varyingVectors,
      packedVaryingVectors(fragmentVaryings(material.fragmentShader, alphaHash)),
    );
    material.dispose();
  }
  return { attributes, varyingVectors };
}

function frameUniforms(): [
  FXFrameTimeUniform,
  FXFrameTimeUniform,
  FXFrameVec3Uniform,
  FXFrameVec3Uniform,
] {
  return [{ value: 0 }, { value: 0 }, { value: [0, 0, 0] }, { value: [0, 0, 0] }];
}

/**
 * What an emitter's render artifact takes of a GPU's attributes and varyings, read off the very
 * shaders the runtime builds for it - with the behavior's `attributes` (the buffers its kernel
 * keeps; the render may read only some) in the particle state they carry. Compare against
 * {@link FX_RENDER_BUDGET_MINIMUMS} for the artifact's tier.
 */
export function fxEmitterRenderBudget(
  render: FXRenderArtifact,
  attributes: readonly FXAttributeDecl[],
  options: { readonly castShadow?: boolean } = {},
): FXRenderBudget {
  const varyings = varyingsFromComponents(mergeAttributeWidths(attributes, render.attributeReads));
  const materials = [buildArtifactMaterial(render, varyings, ...frameUniforms())];
  if (options.castShadow === true) {
    materials.push(buildArtifactDepthMaterial(render, varyings, ...frameUniforms()));
  }
  return budgetOf(materials, render.options?.renderMode === "alphaHash");
}

/** The same for a VFX mesh's render artifact, which carries no particle state. */
export function fxMeshRenderBudget(
  render: FXRenderArtifact,
  options: { readonly castShadow?: boolean } = {},
): FXRenderBudget {
  const materials = [buildMeshArtifactMaterial(render, ...frameUniforms())];
  if (options.castShadow === true) {
    materials.push(buildMeshArtifactDepthMaterial(render, ...frameUniforms()));
  }
  return budgetOf(materials, render.options?.renderMode === "alphaHash");
}

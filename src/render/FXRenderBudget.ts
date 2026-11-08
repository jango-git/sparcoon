import type { ShaderMaterial } from "three";
import {
  heldBehaviorFields,
  trailHistoryLayout,
  trailReadFields,
} from "../trail/FXTrailFields.Internal.js";
import type {
  FXAttributeDecl,
  FXBufferLayout,
  FXGLSLRenderTier,
  FXRenderArtifact,
} from "../artifact/FXArtifact.js";
import {
  gpuHeldFields,
  jsHeldFields,
  particleLayout,
} from "../emitter/FXEmitterDriver.Internal.js";
import { kernelSlotLayout } from "../instancedParticle/FXTransformFeedbackParticle.js";
import {
  buildArtifactDepthMaterial,
  buildArtifactMaterial,
  buildMeshArtifactDepthMaterial,
  buildMeshArtifactMaterial,
  buildTrailArtifactMaterial,
  createTrailUniforms,
  type FXFrameTimeUniform,
  type FXFrameVec3Uniform,
  type FXTrailLayout,
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

/**
 * The attribute slots `vertexShader` takes: the base geometry's (`baseAttributes` - three's
 * position, uv and normal for a particle or mesh), plus its own.
 */
function vertexAttributes(vertexShader: string, baseAttributes: number): number {
  const own = [...vertexShader.matchAll(/^\s*attribute\s+\w+\s+\w+\s*;/gm)].length;
  return baseAttributes + own;
}

function materialBudget(
  material: ShaderMaterial,
  alphaHash: boolean,
  baseAttributes: number,
): FXRenderBudget {
  return {
    attributes: vertexAttributes(material.vertexShader, baseAttributes),
    varyingVectors: packedVaryingVectors(fragmentVaryings(material.fragmentShader, alphaHash)),
  };
}

function budgetOf(
  materials: readonly ShaderMaterial[],
  alphaHash: boolean,
  baseAttributes = 3,
): FXRenderBudget {
  let attributes = 0;
  let varyingVectors = 0;
  for (const material of materials) {
    const budget = materialBudget(material, alphaHash, baseAttributes);
    attributes = Math.max(attributes, budget.attributes);
    varyingVectors = Math.max(varyingVectors, budget.varyingVectors);
    material.dispose();
  }
  return { attributes, varyingVectors };
}

/**
 * @internal What a built trail material takes, counted as {@link fxTrailRenderBudget} counts it -
 * so a trail's own check against the device and the editor's budget can never disagree.
 */
export function trailMaterialBudget(material: ShaderMaterial, alphaHash: boolean): FXRenderBudget {
  return materialBudget(material, alphaHash, 1);
}

function frameUniforms(): [
  FXFrameTimeUniform,
  FXFrameTimeUniform,
  FXFrameVec3Uniform,
  FXFrameVec3Uniform,
] {
  return [{ value: 0 }, { value: 0 }, { value: [0, 0, 0] }, { value: [0, 0, 0] }];
}

/** Options of {@link fxEmitterRenderBudget}. */
export interface FXEmitterRenderBudgetOptions {
  /** Also count the shadow depth material (the larger of the two is the budget). */
  readonly castShadow?: boolean;
  /**
   * The emitter's GPU kernel's `buffers`, in its order (`FXParticleKernelArtifact.buffers`): then
   * the budget is the GPU-driven mesh's - the kernel's slot, read through its packed views (several
   * fields per attribute), with `attributes` unused, as the GPU driver ignores the JS behavior's.
   * Without it, the JS-driven mesh's: one attribute per field. Pass it for a Standard-tier budget
   * of an emitter that has a kernel; the Baseline tier always runs the JS backend.
   */
  readonly kernelBuffers?: readonly FXBufferLayout[];
}

/**
 * What an emitter's render artifact takes of a GPU's attributes and varyings, read off the very
 * shaders the runtime builds for it, through the same layout its driver builds (`particleLayout`)
 * - with the behavior's `attributes` (the buffers its kernel keeps; the render may read only some)
 * in the particle state they carry. A field the render reads that nothing writes is a zero
 * constant, so it takes no attribute. Compare against {@link FX_RENDER_BUDGET_MINIMUMS} for the
 * artifact's tier.
 */
export function fxEmitterRenderBudget(
  render: FXRenderArtifact,
  attributes: readonly FXAttributeDecl[],
  options: FXEmitterRenderBudgetOptions = {},
): FXRenderBudget {
  const held =
    options.kernelBuffers === undefined
      ? jsHeldFields(attributes)
      : gpuHeldFields(kernelSlotLayout(options.kernelBuffers));
  const layout = particleLayout(held, render.attributeReads);
  const materials = [buildArtifactMaterial(render, layout, ...frameUniforms())];
  if (options.castShadow === true) {
    materials.push(buildArtifactDepthMaterial(render, layout, ...frameUniforms()));
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

/** Options of {@link fxTrailRenderBudget}. */
export interface FXTrailRenderBudgetOptions {
  /** The history the trail draws over: `"js"` (the default, and the only one a WebGL1 tier ever
   *  runs) or `"gpu"`. */
  readonly backend?: "js" | "gpu";
  /**
   * With `backend: "gpu"`, the emitter's GPU kernel's `buffers`, in its order: the history copies
   * that slot whole, so its packed views are what is mounted. Without it, a `"gpu"` budget gives
   * every recorded field an attribute of its own - the most any kernel order could need. Unused on
   * `"js"`, whose history lays its own point out.
   */
  readonly kernelBuffers?: readonly FXBufferLayout[];
}

/**
 * The same for an emitter's trail artifact, for an emitter whose behavior writes `attributes`. A
 * trail's base segment has a position only, so it takes no uv or normal slot; every packed view of
 * the history takes two (the segment's two points), and a GPU history adds its frame index and the
 * previous point's views. Laid out and packed by the same
 * `trailHistoryLayout` the emitter's drivers mount from - with the behavior's attribute writes, or
 * on `"gpu"` the kernel's slot when `kernelBuffers` is given, standing in for what the emitter holds.
 */
export function fxTrailRenderBudget(
  render: FXRenderArtifact,
  attributes: readonly FXAttributeDecl[],
  options: FXTrailRenderBudgetOptions = {},
): FXRenderBudget {
  const reads = trailReadFields(render);
  let layout: FXTrailLayout;
  if (options.backend !== "gpu") {
    layout = trailHistoryLayout("cpu", reads, heldBehaviorFields(attributes));
  } else if (options.kernelBuffers === undefined) {
    layout = trailHistoryLayout("gpu", reads, heldBehaviorFields(attributes));
  } else {
    const slot = kernelSlotLayout(options.kernelBuffers);
    layout = trailHistoryLayout("gpu", reads, gpuHeldFields(slot).fields, slot);
  }
  const material = buildTrailArtifactMaterial(
    render,
    layout,
    ...frameUniforms(),
    createTrailUniforms(2, 1),
  );
  return budgetOf([material], render.options?.renderMode === "alphaHash", 1);
}

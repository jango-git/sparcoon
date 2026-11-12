import { Texture, type ShaderMaterial } from "three";
import { trailHistoryLayout, trailReadFields } from "../trail/FXTrailFields.Internal.js";
import { FX_CORE_BUFFERS } from "../coreLayout.js";
import type {
  FXBufferLayout,
  FXGLSLRenderTier,
  FXRenderArtifact,
  FXSurfaceReads,
} from "../artifact/FXArtifact.js";
import { particleLayout } from "../emitter/FXEmitterDriver.Internal.js";
import { particleSlotLayout } from "../instancedParticle/FXParticleSlot.js";
import {
  buildArtifactDepthMaterial,
  buildArtifactMaterial,
  buildMeshArtifactDepthMaterial,
  buildMeshArtifactMaterial,
  buildTrailArtifactMaterial,
  createMaterialSlots,
  createTrailUniforms,
  type FXMaterialSlots,
  type FXTrailLayout,
} from "./FXArtifactMaterial.Internal.js";
import type { FXExternalTextureBinding } from "./FXExternalTexture.Internal.js";

/**
 * What one render artifact's materials take of the resources a GPU has the fewest of: vertex
 * attributes, varying vectors (4-component rows the varyings pack into), uniform vectors (rows the
 * uniforms pack into, per stage) and texture units (samplers, per stage). The larger of the color
 * and (when it casts shadows) depth material's needs.
 */
export interface FXRenderBudget {
  readonly attributes: number;
  readonly varyingVectors: number;
  readonly vertexUniformVectors: number;
  readonly fragmentUniformVectors: number;
  readonly vertexSamplers: number;
  readonly fragmentSamplers: number;
}

/**
 * The least of each resource every GPU of a tier offers: WebGL2's guaranteed minimums for
 * Standard. For Baseline, WebGL1's for attributes and varyings; for uniforms and samplers the
 * least iOS ever offered (WebKit's OpenGL ES 2 backend: 128 vertex and 64 fragment vectors, 8
 * units a stage) - WebGL1's own 16 fragment vectors and no vertex units would rule out three's
 * lit materials, which no WebGL1 device that runs them offers so little for. A budget within them
 * runs anywhere the tier runs.
 */
export const FX_RENDER_BUDGET_MINIMUMS: Readonly<Record<FXGLSLRenderTier, FXRenderBudget>> = {
  standard: {
    attributes: 16,
    varyingVectors: 15,
    vertexUniformVectors: 256,
    fragmentUniformVectors: 224,
    vertexSamplers: 16,
    fragmentSamplers: 16,
  },
  baseline: {
    attributes: 8,
    varyingVectors: 8,
    vertexUniformVectors: 128,
    fragmentUniformVectors: 64,
    vertexSamplers: 8,
    fragmentSamplers: 8,
  },
};

/**
 * Assumed of the host scene, which a budget cannot see: linear fog on, tone mapping on, a light
 * probe and one shadow-casting directional light (a lit effect needs both anyway). Each further
 * light a lit material receives takes more varying and uniform vectors.
 */
const ASSUMED_SCENE = { directionalLights: 1, directionalShadows: 1 } as const;

/** One variable as it packs: its components (1 to 4) per vector, and its vectors. */
export interface FXPackedShape {
  readonly components: number;
  readonly count: number;
}

/**
 * Each variable type as the vectors it packs as: a matN as N columns of an N-vector (a mat2 then
 * pairs up into one row, as the packing rules place it), an integer or bool type like its float
 * twin. Every non-sampler type GLSL ES 3.00 has a uniform of, so measuring a shader never throws.
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
  uint: { components: 1, vectors: 1 },
  uvec2: { components: 2, vectors: 1 },
  uvec3: { components: 3, vectors: 1 },
  uvec4: { components: 4, vectors: 1 },
  bool: { components: 1, vectors: 1 },
  bvec2: { components: 2, vectors: 1 },
  bvec3: { components: 3, vectors: 1 },
  bvec4: { components: 4, vectors: 1 },
  mat2: { components: 2, vectors: 2 },
  mat3: { components: 3, vectors: 3 },
  mat4: { components: 4, vectors: 4 },
};

/** The sampler types: a texture unit each, no uniform vector. */
const SAMPLER_TYPES: ReadonlySet<string> = new Set([
  "sampler2D",
  "samplerCube",
  "sampler3D",
  "sampler2DArray",
  "sampler2DShadow",
  "samplerCubeShadow",
  "sampler2DArrayShadow",
  "isampler2D",
  "isampler3D",
  "isamplerCube",
  "isampler2DArray",
  "usampler2D",
  "usampler3D",
  "usamplerCube",
  "usampler2DArray",
]);

const FLOAT: FXPackedShape = { components: 1, count: 1 };
const VEC3: FXPackedShape = { components: 3, count: 1 };

/** `count` of `packed`. */
function times(packed: FXPackedShape, count: number): FXPackedShape {
  return { components: packed.components, count: packed.count * count };
}

/** `DirectionalLightShadow`'s members (three 0.157: three floats and a vec2; newer three adds
 *  `shadowIntensity`, a fourth float - counted for every supported three), `count` of them. */
function directionalShadows(count: number): FXPackedShape[] {
  return [times(FLOAT, 4 * count), { components: 2, count }];
}

/**
 * The varyings three's shader chunks declare in a fragment shader, by chunk, under the defines our
 * materials compile with. Kept in step with three by a test that reads the chunks themselves.
 */
function chunkVaryings(chunk: string, alphaHash: boolean): readonly FXPackedShape[] {
  switch (chunk) {
    case "common":
      return alphaHash ? [VEC3] : []; // vPosition
    case "normal_pars_fragment":
      return [VEC3]; // vNormal (not FLAT_SHADED, no USE_TANGENT)
    case "fog_pars_fragment":
      return [FLOAT]; // vFogDepth
    case "lights_lambert_pars_fragment":
      return [VEC3]; // vViewPosition
    case "shadowmap_pars_fragment":
      return [{ components: 4, count: ASSUMED_SCENE.directionalShadows }]; // vDirectionalShadowCoord[]
    default:
      return [];
  }
}

/** What a stage's declarations take: the uniforms as they pack, and its texture units. */
interface FXStageUniforms {
  readonly vectors: readonly FXPackedShape[];
  readonly samplers: number;
}

const NO_UNIFORMS: FXStageUniforms = { vectors: [], samplers: 0 };

/**
 * The uniforms three's shader chunks declare, by chunk and stage, under the defines our materials
 * compile with in the assumed scene. Kept in step with three by a test that reads the chunks.
 */
function chunkUniforms(chunk: string, stage: FXShaderStageKind): FXStageUniforms {
  const { directionalLights, directionalShadows: shadows } = ASSUMED_SCENE;
  switch (`${stage}:${chunk}`) {
    case "fragment:fog_pars_fragment":
      return { vectors: [VEC3, FLOAT, FLOAT], samplers: 0 }; // fogColor, fogNear, fogFar
    case "fragment:lights_pars_begin":
      // receiveShadow, ambientLightColor, lightProbe[9], directionalLights[] (direction, color).
      return {
        vectors: [FLOAT, VEC3, times(VEC3, 9), times(VEC3, 2 * directionalLights)],
        samplers: 0,
      };
    case "fragment:shadowmap_pars_fragment":
      return { vectors: directionalShadows(shadows), samplers: shadows }; // + directionalShadowMap[]
    case "vertex:shadowmap_pars_vertex":
      // directionalShadowMatrix[], directionalLightShadows[].
      return {
        vectors: [times({ components: 4, count: 4 }, shadows), ...directionalShadows(shadows)],
        samplers: 0,
      };
    default:
      return NO_UNIFORMS;
  }
}

/** The stages a material's uniforms are counted for. */
type FXShaderStageKind = "vertex" | "fragment";

/**
 * The uniforms three's prefix declares for every `ShaderMaterial`, by stage - the vertex stage's
 * matrices, camera and projection kind; the fragment stage's view matrix, camera, projection kind
 * and (tone mapping on) exposure.
 */
const PREFIX_UNIFORMS: Readonly<Record<FXShaderStageKind, readonly FXPackedShape[]>> = {
  vertex: [{ components: 4, count: 16 }, { components: 3, count: 3 }, VEC3, FLOAT],
  fragment: [{ components: 4, count: 4 }, VEC3, FLOAT, FLOAT],
};

/**
 * How one varying or uniform of GLSL type `glslTypeName` packs (see {@link packedVectors}): its
 * components per vector and its vectors - for a compiler weighing what it carries between stages,
 * or declares as uniforms, by the same rule this budget counts with.
 * @throws For a type no rule here packs (a sampler takes a texture unit, no vector).
 */
export function fxPackedShape(glslTypeName: string): FXPackedShape {
  const shape = PACKED_SHAPES[glslTypeName];
  if (shape === undefined) {
    throw new Error(`fxPackedShape: no packing rule for type "${glslTypeName}"`);
  }
  return { components: shape.components, count: shape.vectors };
}

/** Every varying `fragmentShader` declares, its own lines and its chunks' alike. */
function fragmentVaryings(fragmentShader: string, alphaHash: boolean): readonly FXPackedShape[] {
  const varyings: FXPackedShape[] = [];
  for (const match of fragmentShader.matchAll(
    /^\s*(?:flat\s+|FX_FLAT\s+)?varying\s+(?:(?:lowp|mediump|highp)\s+)?(\w+)\s+\w+\s*(?:\[\s*(\d+)\s*\])?\s*;/gm,
  )) {
    const [, type, arraySize] = match as unknown as [string, string, string | undefined];
    const count = arraySize === undefined ? 1 : Number(arraySize);
    varyings.push(times(fxPackedShape(type), count));
  }
  for (const match of fragmentShader.matchAll(/^\s*#include\s+<(\w+)>/gm)) {
    varyings.push(...chunkVaryings(match[1], alphaHash));
  }
  return varyings;
}

/**
 * Every uniform one stage's shader declares: three's prefix, its own lines (a name declared twice,
 * once per precision branch of an `#ifdef`, counts once) and its chunks'.
 * @throws For a uniform of a type no rule here packs (see {@link fxPackedShape}).
 */
function stageUniforms(shader: string, stage: FXShaderStageKind): FXStageUniforms {
  const vectors: FXPackedShape[] = [...PREFIX_UNIFORMS[stage]];
  let samplers = 0;
  const seen = new Set<string>();
  for (const match of shader.matchAll(
    /^\s*uniform\s+(?:(?:lowp|mediump|highp)\s+)?(\w+)\s+(\w+)\s*(?:\[\s*(\d+)\s*\])?\s*;/gm,
  )) {
    const [, type, name, arraySize] = match as unknown as [
      string,
      string,
      string,
      string | undefined,
    ];
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    const count = arraySize === undefined ? 1 : Number(arraySize);
    if (SAMPLER_TYPES.has(type)) {
      samplers += count;
      continue;
    }
    vectors.push(times(fxPackedShape(type), count));
  }
  for (const match of shader.matchAll(/^\s*#include\s+<(\w+)>/gm)) {
    const chunk = chunkUniforms(match[1], stage);
    vectors.push(...chunk.vectors);
    samplers += chunk.samplers;
  }
  return { vectors, samplers };
}

/**
 * The vectors `variables` pack into under GLSL ES's packing rules (GLSL ES 1.00, appendix A.7) -
 * which every implementation must accept, so this is what is guaranteed to link, for varyings and
 * uniforms alike: each vec4 and vec3 takes a row, two vec2s share one, and floats fill the fourth
 * column of vec3 rows and the free half of a lone vec2 row before taking rows of four.
 */
export function packedVectors(variables: readonly FXPackedShape[]): number {
  const total = (components: number): number =>
    variables
      .filter((variable) => variable.components === components)
      .reduce((sum, variable) => sum + variable.count, 0);
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
  const vertex = stageUniforms(material.vertexShader, "vertex");
  const fragment = stageUniforms(material.fragmentShader, "fragment");
  return {
    attributes: vertexAttributes(material.vertexShader, baseAttributes),
    varyingVectors: packedVectors(fragmentVaryings(material.fragmentShader, alphaHash)),
    vertexUniformVectors: packedVectors(vertex.vectors),
    fragmentUniformVectors: packedVectors(fragment.vectors),
    vertexSamplers: vertex.samplers,
    fragmentSamplers: fragment.samplers,
  };
}

/** The larger of each resource across `budgets` (a resource the materials need at once). */
function largest(budgets: readonly FXRenderBudget[]): FXRenderBudget {
  const most = {} as Record<keyof FXRenderBudget, number>;
  for (const key of BUDGET_RESOURCES) {
    most[key] = budgets.reduce((best, budget) => Math.max(best, budget[key]), 0);
  }
  return most;
}

function budgetOf(
  materials: readonly ShaderMaterial[],
  alphaHash: boolean,
  baseAttributes = 3,
): FXRenderBudget {
  const budgets = materials.map((material) => materialBudget(material, alphaHash, baseAttributes));
  for (const material of materials) {
    material.dispose();
  }
  return largest(budgets);
}

/** One resource a budget takes more of than a limit allows. */
export interface FXBudgetOverrun {
  /** The resource, worded for a message (e.g. `"varying vectors"`). */
  readonly resource: string;
  readonly used: number;
  readonly limit: number;
}

/** Each resource's wording, in the order a message lists them. */
const RESOURCE_NAMES: Readonly<Record<keyof FXRenderBudget, string>> = {
  attributes: "vertex attributes",
  varyingVectors: "varying vectors",
  vertexUniformVectors: "vertex uniform vectors",
  fragmentUniformVectors: "fragment uniform vectors",
  vertexSamplers: "vertex texture units",
  fragmentSamplers: "fragment texture units",
};

/** Every resource of a budget, in {@link RESOURCE_NAMES} order. */
const BUDGET_RESOURCES = Object.keys(RESOURCE_NAMES) as readonly (keyof FXRenderBudget)[];

/** The resources `budget` takes more of than `limits` allow, in {@link RESOURCE_NAMES} order. */
export function fxBudgetOverruns(
  budget: FXRenderBudget,
  limits: FXRenderBudget,
): FXBudgetOverrun[] {
  return BUDGET_RESOURCES.filter((key) => budget[key] > limits[key]).map((key) => ({
    resource: RESOURCE_NAMES[key],
    used: budget[key],
    limit: limits[key],
  }));
}

/**
 * The slots a budget builds a material over: each external texture bound the heaviest way, as a
 * masked region (its window's uniforms declared), so the budget holds whatever the host binds.
 */
function budgetSlots(render: FXRenderArtifact): FXMaterialSlots {
  const external: Record<string, FXExternalTextureBinding> = {};
  // A stand-in for every external texture: only its declaration is counted.
  let texture: Texture | undefined;
  for (const name in render.uniforms) {
    if ("external" in render.uniforms[name]) {
      external[name] = {
        slot: name,
        sampler: { value: (texture ??= new Texture()) },
        region: {
          rowU: { value: [1, 0, 0] },
          rowV: { value: [0, 1, 0] },
          bounds: { value: [0, 0, 1, 1] },
        },
      };
    }
  }
  return createMaterialSlots(render, external);
}

/**
 * @internal What a built trail material takes, counted as {@link fxTrailRenderBudget} counts it -
 * so a trail's own check against the device and the editor's budget can never disagree.
 */
export function trailMaterialBudget(material: ShaderMaterial, alphaHash: boolean): FXRenderBudget {
  return materialBudget(material, alphaHash, 1);
}

/** Options of {@link fxEmitterRenderBudget}. */
export interface FXEmitterRenderBudgetOptions {
  /** Also count the shadow depth material (the larger of the two is the budget). */
  readonly castShadow?: boolean;
}

/**
 * What an emitter's render artifact takes of a GPU's attributes and varyings, read off the very
 * shaders the runtime builds for it, through the same layout its driver builds (`particleLayout`)
 * - over the particle slot `buffers` lays out (the JS behavior's or the GPU kernel's `buffers`,
 * whichever backend the budget is for; the render may read only some), read through its packed
 * views. A field the render reads that nothing writes is a zero constant, so it takes no
 * attribute. Compare against {@link FX_RENDER_BUDGET_MINIMUMS} for the artifact's tier.
 */
export function fxEmitterRenderBudget(
  render: FXRenderArtifact,
  buffers: readonly FXBufferLayout[],
  options: FXEmitterRenderBudgetOptions = {},
): FXRenderBudget {
  const layout = particleLayout(particleSlotLayout(buffers), render);
  const materials = [buildArtifactMaterial(render, layout, budgetSlots(render))];
  if (options.castShadow === true) {
    materials.push(buildArtifactDepthMaterial(render, layout, budgetSlots(render)));
  }
  return budgetOf(materials, render.options?.renderMode === "alphaHash");
}

/**
 * The heaviest particle material a render graph's code fixes only `surfaceReads`, `lightingIntrinsics`
 * (empty: unlit) and `externalSlots` of: heaviest over what is set outside the graph's code -
 * alpha-hashed and casting a shadow, since the render mode and the shadow flags change the
 * material, not the compiled graph - with none of the graph's own code, varyings or numeric
 * uniforms.
 */
function heaviestMaterialBudget(
  surfaceReads: FXSurfaceReads,
  lightingIntrinsics: readonly string[],
  externalSlots: readonly string[],
): FXRenderBudget {
  const noReads = { position: false, lifecycle: false, attributes: [] };
  const heaviest: FXRenderArtifact = {
    lightingIntrinsics,
    sceneDepth: false,
    options: { renderMode: "alphaHash" },
    varyings: [],
    vertex: { uniformDeclarations: [], helperFunctions: [], body: [], particleReads: noReads },
    fragment: {
      // An external texture is sampled in the fragment stage (see `fxExternalSampleFunction`).
      uniformDeclarations: externalSlots.map((name) => `uniform sampler2D ${name};`),
      helperFunctions: [],
      body: [],
      particleReads: noReads,
      surfaceReads,
    },
    outputs: { albedo: "vec4(1.0)" },
    uniforms: Object.fromEntries(
      externalSlots.map((name) => [name, { type: "sampler2D", external: name }]),
    ),
    attributeReads: [],
  };
  return fxEmitterRenderBudget(heaviest, FX_CORE_BUFFERS, { castShadow: true });
}

/**
 * The varying vectors a particle render graph may spend on what it carries itself between its
 * stages on `tier`: the tier's minimum less what the heaviest material its code fixes takes (see
 * `heaviestMaterialBudget`: exact for the surface frame `surfaceReads` asks for and the lighting
 * `lightingIntrinsics` its nodes call, a change to which recompiles it). What a compiler deciding
 * how much to carry may count on, whatever the effect is configured to.
 */
export function fxGraphVaryingAllowance(
  tier: FXGLSLRenderTier,
  surfaceReads: FXSurfaceReads,
  lightingIntrinsics: readonly string[],
): number {
  const used = heaviestMaterialBudget(surfaceReads, lightingIntrinsics, []).varyingVectors;
  return FX_RENDER_BUDGET_MINIMUMS[tier].varyingVectors - used;
}

/**
 * The uniform vectors a render graph may spend on its own numeric uniforms - its parameters and
 * draw uniforms - on `tier`, beside the heaviest material its code fixes (see
 * `fxGraphVaryingAllowance`) with its `externalSlots` bound the heaviest way. A graph uniform is
 * declared in both stages, so this is the smaller of the two stages' room.
 */
export function fxGraphUniformAllowance(
  tier: FXGLSLRenderTier,
  surfaceReads: FXSurfaceReads,
  lightingIntrinsics: readonly string[],
  externalSlots: readonly string[],
): number {
  const used = heaviestMaterialBudget(surfaceReads, lightingIntrinsics, externalSlots);
  const minimum = FX_RENDER_BUDGET_MINIMUMS[tier];
  return Math.min(
    minimum.vertexUniformVectors - used.vertexUniformVectors,
    minimum.fragmentUniformVectors - used.fragmentUniformVectors,
  );
}

/** The same for a VFX mesh's render artifact, which carries no particle state. */
export function fxMeshRenderBudget(
  render: FXRenderArtifact,
  options: { readonly castShadow?: boolean } = {},
): FXRenderBudget {
  const materials = [buildMeshArtifactMaterial(render, budgetSlots(render))];
  if (options.castShadow === true) {
    materials.push(buildMeshArtifactDepthMaterial(render, budgetSlots(render)));
  }
  return budgetOf(materials, render.options?.renderMode === "alphaHash");
}

/** Options of {@link fxTrailRenderBudget}. */
export interface FXTrailRenderBudgetOptions {
  /** The history the trail draws over: `"js"` (the default, and the only one a WebGL1 tier ever
   *  runs) or `"gpu"`. */
  readonly backend?: "js" | "gpu";
}

/**
 * The same for an emitter's trail artifact, over the particle slot `buffers` lays out (as for
 * {@link fxEmitterRenderBudget}). A trail's base segment has a position only, so it takes no uv or
 * normal slot; every packed view of the history takes two (the segment's two points), and a GPU
 * history adds its frame index and the previous point's views. Laid out and packed by the same
 * `trailHistoryLayout` the emitter's drivers mount from.
 */
export function fxTrailRenderBudget(
  render: FXRenderArtifact,
  buffers: readonly FXBufferLayout[],
  options: FXTrailRenderBudgetOptions = {},
): FXRenderBudget {
  const layout: FXTrailLayout = trailHistoryLayout(
    options.backend === "gpu" ? "gpu" : "cpu",
    trailReadFields(render),
    particleSlotLayout(buffers),
  );
  const material = buildTrailArtifactMaterial(
    render,
    layout,
    budgetSlots(render),
    createTrailUniforms(2, 1),
  );
  return budgetOf([material], render.options?.renderMode === "alphaHash", 1);
}

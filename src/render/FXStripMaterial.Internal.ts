import type { IUniform, ShaderMaterial } from "three";
import { UniformsLib, UniformsUtils } from "three";

import type { FXRenderArtifact, FXRenderProgram } from "../artifact/FXArtifact.js";
import {
  FX_CORE_LIFECYCLE,
  FX_CORE_PARTICLE_DEFINES,
  FX_CORE_POSITION,
  FX_PARTICLE_ID_RANGE,
} from "../coreLayout.js";
import type { GLTypeInfo } from "../instancedParticle/glTypeInfo.js";
import type { FXStripKind } from "../strip/FXStripOptions.js";
import {
  bindUniforms,
  colorFragmentTail,
  colorMaterial,
  fragmentReadProperties,
  FX_FRAGMENT_MODEL_MATRIX,
  type FXMaterialSlots,
  graphVaryings,
  outputOrDefault,
  programCacheKey,
  surfaceFrame,
  unpackStatements,
  viewType,
} from "./FXArtifactMaterial.Internal.js";
import type { FXPackedAttribute } from "./FXAttributePacking.js";
import { floatGLSLType } from "./FXAttributePacking.js";
import { cameraDepthFunctions } from "./FXCameraDepth.Internal.js";
import { externalSamplingFunctions } from "./FXExternalTexture.Internal.js";
import { isLitArtifact } from "./FXLightingIntrinsics.Internal.js";

// Trail material path: one ribbon segment per (history frame, particle slot) instance, compiled
// against the editor's trail render target. It shares the particle path's attribute-free helpers
// and the particle builtins - each one interpolated along the segment between two recorded points
// of a particle's path instead of read off a live particle.

/** The most history frames a trail may keep - the size of the shader's packed age table. */
export const FX_TRAIL_MAX_FRAMES = 64;

/** The trail's per-tick uniforms, updated in place by the trail that owns them. */
export interface FXTrailUniforms {
  /** The frame being recorded into (a `"gpu"` history: the segment starting there is skipped). */
  readonly head: { value: number };
  /** The history length in frames. */
  readonly frames: { value: number };
  /** Seconds the whole trail spans, head to tail - what `p_uv.x` runs 0 -> 1 over. */
  readonly span: { value: number };
  /** The trail's clock: a `"cpu"` point's age is this minus the time it was recorded. */
  readonly now: { value: number };
  /**
   * A `"cpu"` history's oldest valid start time: a segment starting at a point recorded before it
   * is not part of the trail. Lies strictly between the tail frame's time and the time of the
   * point the head frame held one lap ago - the one a `"cpu"` history leaves un-uploaded in frame
   * 0 while the head is there (see `FXCPUTrailHistory`), which this rejects.
   */
  readonly tail: { value: number };
  /** A `"gpu"` history's seconds since each frame was recorded, four per vec4. */
  readonly ages: { value: Float32Array };
}

/** A trail's uniforms as they read before its first record: `frames` frames spanning `span`. */
export function createTrailUniforms(frames: number, span: number): FXTrailUniforms {
  return {
    head: { value: 0 },
    frames: { value: frames },
    span: { value: span },
    now: { value: 0 },
    tail: { value: 0 },
    ages: { value: new Float32Array(FX_TRAIL_MAX_FRAMES) },
  };
}

/** A ribbon's uniforms (see `FXRibbon`), fixed once it is built. */
export interface FXRibbonUniforms {
  /** Particles per repeat of `p_uv.x` along the ribbon, or 0: `p_uv.x` is each point's age over
   *  its lifetime. */
  readonly tile: { value: number };
  /** Particles per section, or 0: one ribbon through every particle (see `FXRibbonOptions`). */
  readonly section: { value: number };
}

/** A ribbon's uniforms for `tile` particles per repeat and `section` per section (0: none). */
export function createRibbonUniforms(tile: number, section: number): FXRibbonUniforms {
  return { tile: { value: tile }, section: { value: section } };
}

/**
 * The names the trail shader reads one recorded field by at a segment's start (A) and end (B) -
 * vertex-shader globals the prologue fills from the packed views (see {@link FXStripLayout.packed}),
 * which are themselves named by this applied to the view's name (`a_tA_pack0`). The CPU point and
 * joint vec4s are real attributes under these names.
 */
export function stripAttributeNames(name: string): { readonly a: string; readonly b: string } {
  return { a: `a_tA_${name}`, b: `a_tB_${name}` };
}

/** The same for a `"gpu"` history's point before a segment's start (position and lifecycle). */
export function stripPreviousAttributeName(name: string): string {
  return `a_tC_${name}`;
}

/** A `"gpu"` history's per-instance attribute: the frame a segment starts at. */
export const FX_TRAIL_FRAME_ATTRIBUTE = "a_trailFrame";

/** A `"cpu"` history's packed point: `vec4(position, id + 1)`, `0` when dead. */
export const FX_STRIP_CPU_POINT = "trailPoint";
/** A `"cpu"` history's packed joint: `vec4(tangent, time recorded)`. */
export const FX_STRIP_CPU_TANGENT = "trailTangent";

/**
 * What a trail material reads from its history: the layout (see `FXTrailHistory.kind`), the
 * particle fields it records and how they are packed into attributes, and the fields the trail
 * reads that it does not hold - read as zero, the value the particle path gives an attribute
 * nothing simulates. Built only by `stripLayout`, which both drivers and the trail budget go
 * through; the history mounts exactly these views and the material declares exactly these.
 */
export interface FXStripLayout {
  readonly kind: "cpu" | "gpu";
  readonly recorded: Readonly<Record<string, GLTypeInfo>>;
  readonly missing: Readonly<Record<string, GLTypeInfo>>;
  /**
   * The recorded fields as packed views of one point, each mounted twice - at the segment's start
   * and end, named by {@link stripAttributeNames} of the view's name. Offsets are in floats into a
   * point: on `"cpu"` the history's own point (after its packed point and joint), on `"gpu"` the
   * kernel's slot, which the history copies whole.
   */
  readonly packed: readonly FXPackedAttribute[];
  /** `"gpu"` only (empty on `"cpu"`): views of the position and lifecycle at the point before a
   *  segment's start, named by {@link stripPreviousAttributeName}. */
  readonly previous: readonly FXPackedAttribute[];
  /** Floats per point: the `"cpu"` history's stride, or the kernel's slot stride on `"gpu"`. */
  readonly stride: number;
}

/**
 * The segment's two points and how they join, per history layout. Both define `fxStripPosA` /
 * `fxStripPosB`, `fxStripLinked` (both points alive, one particle, and a real segment of its
 * path), `fxStripTangent` (the joint direction at this vertex's end, zero when there is none) and
 * the vertex's `p_trailAge`.
 *
 * The joint tangent at a point is the direction the path arrived there from - one value for both
 * segments meeting at the point, so their shared vertices coincide and the ribbon has no seams.
 */
function trailPrologue(kind: "cpu" | "gpu"): string[] {
  if (kind === "cpu") {
    const point = stripAttributeNames(FX_STRIP_CPU_POINT);
    const tangent = stripAttributeNames(FX_STRIP_CPU_TANGENT);
    return [
      `vec3 fxStripPosA = ${point.a}.xyz;`,
      `vec3 fxStripPosB = ${point.b}.xyz;`,
      // The end must be newer than the start (from the head frame on lies the oldest one), and
      // the start no older than the tail (frame 0 still holds last lap's point while the head is
      // there - see FXTrailUniforms.tail).
      "bool fxStripLinked =",
      `  ${point.a}.w > 0.5 && abs(${point.a}.w - ${point.b}.w) < 0.5 &&`,
      `  ${tangent.b}.w > ${tangent.a}.w && ${tangent.a}.w >= u_trailTail;`,
      `vec3 fxStripTangent = fxStripT < 0.5 ? ${tangent.a}.xyz : ${tangent.b}.xyz;`,
      `p_trailAge = u_trailNow - mix(${tangent.a}.w, ${tangent.b}.w, fxStripT);`,
      TRAIL_STRIP_U,
    ];
  }
  const position = stripAttributeNames(FX_CORE_POSITION);
  const lifecycle = stripAttributeNames(FX_CORE_LIFECYCLE);
  const previousPosition = stripPreviousAttributeName(FX_CORE_POSITION);
  const previousLifecycle = stripPreviousAttributeName(FX_CORE_LIFECYCLE);
  const frame = FX_TRAIL_FRAME_ATTRIBUTE;
  return [
    `vec3 fxStripPosA = ${position.a};`,
    `vec3 fxStripPosB = ${position.b};`,
    "bool fxStripLinked =",
    `  abs(${frame} - u_trailHead) > 0.5 &&`,
    `  abs(${lifecycle.a}.z - ${lifecycle.b}.z) < 0.5 &&`,
    `  ${lifecycle.a}.x < ${lifecycle.a}.y && ${lifecycle.b}.x < ${lifecycle.b}.y;`,
    // The point before the start is this particle's previous point when the segment ending at the
    // start is itself linked - the same test, one frame earlier.
    `float fxTrailPrevious = mod(${frame} + u_trailFrames - 1.0, u_trailFrames);`,
    "bool fxStripHasPrevious =",
    "  abs(fxTrailPrevious - u_trailHead) > 0.5 &&",
    `  abs(${previousLifecycle}.z - ${lifecycle.a}.z) < 0.5 &&`,
    `  ${previousLifecycle}.x < ${previousLifecycle}.y;`,
    "vec3 fxStripTangent = fxStripPosB - fxStripPosA;",
    `if (fxStripT < 0.5) { fxStripTangent = fxStripHasPrevious ? fxStripPosA - ${previousPosition} : vec3(0.0); }`,
    `float fxTrailNext = mod(${frame} + 1.0, u_trailFrames);`,
    `p_trailAge = mix(fxTrailAgeOf(${frame}), fxTrailAgeOf(fxTrailNext), fxStripT);`,
    TRAIL_STRIP_U,
  ];
}

// Along the trail from its head (0) to its tail (1), by how long ago the point was recorded.
const TRAIL_STRIP_U = "float fxStripU = clamp(p_trailAge / max(u_trailSpan, 1e-6), 0.0, 1.0);";

/**
 * Whether particle id `b` was born right after id `a` (see `FX_PARTICLE_ID_RANGE`: the last id is
 * followed by the first) and in the same section: with `u_ribbonSection` particles per section, `b`
 * starts a new one where it is a multiple of it. The section is a power of two, so the float
 * remainder is exact.
 */
const RIBBON_FOLLOWS = [
  "bool fxRibbonFollows(float a, float b) {",
  `  bool next = abs(b - a - 1.0) < 0.5 || (a > ${String(FX_PARTICLE_ID_RANGE - 1)}.0 - 0.5 && b < 0.5);`,
  "  return next && (u_ribbonSection < 0.5 || mod(b, u_ribbonSection) > 0.5);",
  "}",
].join("\n");

/**
 * The same as {@link trailPrologue} for a ribbon, whose segment runs from one point to the next -
 * a particle to the one born right after it (or to the head, which takes the next birth's id), when
 * the two are linked (see `FXRibbonPoints`). Its `fxStripU` runs from the
 * newest particle (0) to the oldest: the point's age over its lifetime, or with `u_ribbonTile`
 * particles per repeat, falling by `1 / u_ribbonTile` from each particle to the next newer one -
 * so the end of a segment is its start's value less that, even where the repeat wraps.
 */
function ribbonPrologue(kind: "cpu" | "gpu"): string[] {
  const nextU = (startU: string, endU: string): string =>
    `u_ribbonTile > 0.0 ? ${startU} - 1.0 / u_ribbonTile : ${endU}`;
  if (kind === "cpu") {
    const point = stripAttributeNames(FX_STRIP_CPU_POINT);
    const tangent = stripAttributeNames(FX_STRIP_CPU_TANGENT);
    return [
      `vec3 fxStripPosA = ${point.a}.xyz;`,
      `vec3 fxStripPosB = ${point.b}.xyz;`,
      // Tags are id + 1, 0 when dead.
      "bool fxStripLinked =",
      `  ${point.a}.w > 0.5 && fxRibbonFollows(${point.a}.w - 1.0, ${point.b}.w - 1.0);`,
      `vec3 fxStripTangent = fxStripT < 0.5 ? ${tangent.a}.xyz : ${tangent.b}.xyz;`,
      `float fxStripU = mix(${tangent.a}.w, ${nextU(`${tangent.a}.w`, `${tangent.b}.w`)}, fxStripT);`,
    ];
  }
  const position = stripAttributeNames(FX_CORE_POSITION);
  const lifecycle = stripAttributeNames(FX_CORE_LIFECYCLE);
  const previousPosition = stripPreviousAttributeName(FX_CORE_POSITION);
  const previousLifecycle = stripPreviousAttributeName(FX_CORE_LIFECYCLE);
  const alive = (point: string): string => `${point}.x < ${point}.y`;
  return [
    `vec3 fxStripPosA = ${position.a};`,
    `vec3 fxStripPosB = ${position.b};`,
    "bool fxStripLinked =",
    `  ${alive(lifecycle.a)} && ${alive(lifecycle.b)} &&`,
    `  fxRibbonFollows(${lifecycle.a}.z, ${lifecycle.b}.z);`,
    "bool fxStripHasPrevious =",
    `  ${alive(previousLifecycle)} && fxRibbonFollows(${previousLifecycle}.z, ${lifecycle.a}.z);`,
    "vec3 fxStripTangent = fxStripPosB - fxStripPosA;",
    `if (fxStripT < 0.5) { fxStripTangent = fxStripHasPrevious ? fxStripPosA - ${previousPosition} : vec3(0.0); }`,
    `float fxRibbonStartU = fxRibbonU(${lifecycle.a});`,
    `float fxStripU = mix(fxRibbonStartU, ${nextU("fxRibbonStartU", `fxRibbonU(${lifecycle.b})`)}, fxStripT);`,
  ];
}

/** A `"gpu"` ribbon point's `fxStripU` (see {@link ribbonPrologue}) - a WebGL2 shader, where the
 *  integer remainder of an id is exact. */
const RIBBON_GPU_U = [
  "float fxRibbonU(vec3 lifecycle) {",
  "  if (u_ribbonTile > 0.0) {",
  "    int tile = int(u_ribbonTile + 0.5);",
  "    return float(tile - int(lifecycle.z + 0.5) % tile) / float(tile);",
  "  }",
  "  return clamp(lifecycle.x / max(lifecycle.y, 1e-6), 0.0, 1.0);",
  "}",
].join("\n");

/**
 * The attribute declarations a history layout's prologue reads, and the statements that split its
 * packed views back into the A / B / previous globals of every field ({@link stripAttributeNames}),
 * which the prologue and the property assignments read - unchanged by packing.
 */
function stripLayoutAttributes(
  layout: FXStripLayout,
  strip: FXStripKind,
): {
  readonly declarations: string[];
  readonly unpack: string[];
} {
  const declarations: string[] = [];
  const unpack: string[] = [];
  if (layout.kind === "cpu") {
    for (const name of [FX_STRIP_CPU_POINT, FX_STRIP_CPU_TANGENT]) {
      const { a, b } = stripAttributeNames(name);
      declarations.push(`attribute vec4 ${a};`, `attribute vec4 ${b};`);
    }
  } else if (strip === "trail") {
    declarations.push(`attribute float ${FX_TRAIL_FRAME_ATTRIBUTE};`);
  }
  const ends = [
    { views: layout.packed, named: (name: string): string => stripAttributeNames(name).a },
    { views: layout.packed, named: (name: string): string => stripAttributeNames(name).b },
    { views: layout.previous, named: stripPreviousAttributeName },
  ];
  for (const { views, named } of ends) {
    for (const view of views) {
      declarations.push(`attribute ${viewType(view)} ${named(view.name)};`);
      for (const member of view.members) {
        declarations.push(`${floatGLSLType(member.components)} ${named(member.name)};`);
      }
    }
    unpack.push(
      ...unpackStatements(
        views,
        (view) => named(view.name),
        (member) => named(member.name),
      ),
    );
  }
  return { declarations, unpack };
}

/**
 * The `p_<name>` property each particle field becomes - the same names the particle path declares,
 * a varying only when the fragment stage reads it. The position is always one (the ribbon is built
 * around it); a recorded field is interpolated between the segment's points; a missing one is zero.
 */
function declareStripProperties(
  program: FXRenderProgram,
  layout: FXStripLayout,
): {
  vertexDeclarations: string;
  fragmentDeclarations: string;
  assignments: string;
} {
  const properties: Record<string, GLTypeInfo> = {
    ...layout.missing,
    ...layout.recorded,
    [FX_CORE_POSITION]: { glslTypeName: "vec3", bufferSize: 3, instantiable: true },
  };
  const fragmentReads = fragmentReadProperties(program);
  const vertexDeclarations: string[] = [];
  const fragmentDeclarations: string[] = [];
  const assignments: string[] = [];
  for (const name in properties) {
    const { glslTypeName } = properties[name];
    if (fragmentReads.has(name)) {
      vertexDeclarations.push(`varying ${glslTypeName} p_${name};`);
      fragmentDeclarations.push(`varying ${glslTypeName} p_${name};`);
    } else {
      vertexDeclarations.push(`${glslTypeName} p_${name};`);
    }
    if (name === FX_CORE_POSITION) {
      assignments.push(`p_${name} = mix(fxStripPosA, fxStripPosB, fxStripT);`);
    } else if (name in layout.recorded) {
      const { a, b } = stripAttributeNames(name);
      assignments.push(`p_${name} = mix(${a}, ${b}, fxStripT);`);
    } else {
      assignments.push(`p_${name} = ${glslTypeName}(0.0);`);
    }
  }
  return {
    vertexDeclarations: vertexDeclarations.join("\n"),
    fragmentDeclarations: fragmentDeclarations.join("\n"),
    assignments: assignments.join("\n"),
  };
}

/** Seconds since `frame` was recorded, from the packed age table - a vertex shader may index a
 *  uniform array dynamically, WebGL1 included. */
const TRAIL_AGE_LOOKUP = [
  "float fxTrailAgeOf(float frame) {",
  "  float index = floor(frame + 0.5);",
  "  float row = floor(index / 4.0);",
  "  float column = index - row * 4.0;",
  "  vec4 ages = u_trailAges[int(row)];",
  "  return column < 0.5 ? ages.x : (column < 1.5 ? ages.y : (column < 2.5 ? ages.z : ages.w));",
  "}",
].join("\n");

/** What one kind of strip adds to the shared strip shader: its prologue and its own uniforms. */
interface FXStripShader {
  readonly kind: FXStripKind;
  readonly name: string;
  readonly declarations: readonly string[];
  readonly helpers: readonly string[];
  readonly prologue: readonly string[];
  readonly uniforms: Readonly<Record<string, IUniform>>;
}

/**
 * Builds a trail artifact's material: a camera-facing ribbon through every particle's recorded
 * path. Each instance is the segment from history frame `f` to the next one, for one particle slot.
 * See {@link buildStripMaterial}.
 */
export function buildTrailArtifactMaterial(
  render: FXRenderArtifact,
  layout: FXStripLayout,
  slots: FXMaterialSlots,
  trailUniforms: FXTrailUniforms,
): ShaderMaterial {
  const ageVectors = FX_TRAIL_MAX_FRAMES / 4;
  return buildStripMaterial(render, layout, slots, {
    kind: "trail",
    name: "FXTrailArtifactMaterial",
    declarations: [
      // Seconds since this vertex's point of the path was recorded - what p_uv.x is made of.
      "float p_trailAge;",
      "uniform float u_trailSpan;",
      ...(layout.kind === "cpu"
        ? ["uniform float u_trailNow;", "uniform float u_trailTail;"]
        : [
            "uniform float u_trailHead;",
            "uniform float u_trailFrames;",
            `uniform vec4 u_trailAges[${String(ageVectors)}];`,
          ]),
    ],
    helpers: layout.kind === "gpu" ? [TRAIL_AGE_LOOKUP] : [],
    prologue: trailPrologue(layout.kind),
    uniforms: {
      ["u_trailHead"]: trailUniforms.head,
      ["u_trailFrames"]: trailUniforms.frames,
      ["u_trailSpan"]: trailUniforms.span,
      ["u_trailNow"]: trailUniforms.now,
      ["u_trailTail"]: trailUniforms.tail,
      ["u_trailAges"]: trailUniforms.ages,
    },
  });
}

/**
 * Builds a ribbon artifact's material: a camera-facing ribbon through an emitter's particles in the
 * order they were born. Each instance is the segment from one particle slot to the next. See
 * {@link buildStripMaterial}.
 */
export function buildRibbonArtifactMaterial(
  render: FXRenderArtifact,
  layout: FXStripLayout,
  slots: FXMaterialSlots,
  ribbonUniforms: FXRibbonUniforms,
): ShaderMaterial {
  return buildStripMaterial(render, layout, slots, {
    kind: "ribbon",
    name: "FXRibbonArtifactMaterial",
    declarations: ["uniform float u_ribbonTile;", "uniform float u_ribbonSection;"],
    helpers: [RIBBON_FOLLOWS, ...(layout.kind === "gpu" ? [RIBBON_GPU_U] : [])],
    prologue: ribbonPrologue(layout.kind),
    uniforms: {
      ["u_ribbonTile"]: ribbonUniforms.tile,
      ["u_ribbonSection"]: ribbonUniforms.section,
    },
  });
}

/**
 * The material of a strip - a trail or a ribbon: a camera-facing band of segments, each instance
 * one segment between two points the strip's prologue picks. The base quad's `position.x` runs
 * along it (0 -> 1) and `position.y` across it (-1 -> 1). Unlit and without a surface frame: a
 * strip has no authored normal (the editor keeps the nodes that read one out of its graphs).
 *
 * A segment whose points are not linked (see {@link trailPrologue}, {@link ribbonPrologue}), or
 * that has no length, is pushed outside the clip volume, as the particle path hides a dead
 * particle.
 */
function buildStripMaterial(
  render: FXRenderArtifact,
  layout: FXStripLayout,
  slots: FXMaterialSlots,
  strip: FXStripShader,
): ShaderMaterial {
  const program = render.color;
  const renderMode = render.options?.renderMode ?? "blending";
  const context = `build${strip.kind === "trail" ? "Trail" : "Ribbon"}ArtifactMaterial`;
  if (!("albedo" in program.outputs)) {
    throw new Error(`${context}: render artifact has no 'albedo' output`);
  }
  if (isLitArtifact(render)) {
    throw new Error(`${context}: a ${strip.kind} is unlit - its graph calls lighting`);
  }
  if (
    layout.kind === "gpu" &&
    (!(FX_CORE_POSITION in layout.recorded) || !(FX_CORE_LIFECYCLE in layout.recorded))
  ) {
    throw new Error(`${context}: a gpu layout must record position and lifecycle`);
  }
  // A strip has no surface normal or tangent of its own (the editor's strip targets offer neither).
  const { surfaceReads } = program.fragment;
  if (surfaceReads.normal || surfaceReads.tangent) {
    throw new Error(`${context}: a ${strip.kind} has no surface normal or tangent`);
  }
  const frame = surfaceFrame(surfaceReads, false);
  const width = outputOrDefault(program.outputs, "width", "0.1");
  const properties = declareStripProperties(program, layout);
  const attributes = stripLayoutAttributes(layout, strip.kind);
  const sharedDeclarations = [
    "varying vec2 p_uv;",
    "uniform float u_time;",
    "uniform float u_deltaTime;",
    "uniform vec3 objectVelocity;",
    "uniform vec3 objectAngularVelocity;",
    "varying float p_cameraDistance;",
    frame.varyings,
  ];

  const vertexShader = [
    FX_CORE_PARTICLE_DEFINES,
    ...attributes.declarations,
    ...sharedDeclarations,
    ...strip.declarations,
    properties.vertexDeclarations,
    graphVaryings(program),
    program.vertex.uniformDeclarations.join("\n"),
    program.vertex.helperFunctions.join("\n"),
    "#include <common>",
    "#include <fog_pars_vertex>",
    ...strip.helpers,
    "void main() {",
    "float fxStripT = position.x;",
    "float fxStripSide = position.y;",
    ...attributes.unpack,
    ...strip.prologue,
    properties.assignments,
    // Along the strip from its head (0) to its tail (1), and across it (0 -> 1).
    "p_uv = vec2(fxStripU, fxStripSide * 0.5 + 0.5);",
    program.vertex.body.join("\n"),
    `float fxStripWidth = ${width};`,
    "vec3 fxStripDirection = fxStripPosB - fxStripPosA;",
    // A point with no joint (the first or last point of a path) faces its own segment.
    "if (dot(fxStripTangent, fxStripTangent) < 1e-12) { fxStripTangent = fxStripDirection; }",
    "vec3 fxStripAcross = cross(fxStripTangent, cameraPosition - PARTICLE_POSITION);",
    "float fxStripAcrossLength = length(fxStripAcross);",
    "bool fxStripVisible = fxStripLinked && dot(fxStripDirection, fxStripDirection) > 1e-12 && fxStripAcrossLength > 1e-10;",
    "fxStripAcross = fxStripVisible ? fxStripAcross / fxStripAcrossLength : vec3(0.0);",
    "vec3 fxModelPos = PARTICLE_POSITION + fxStripAcross * (fxStripSide * 0.5 * fxStripWidth);",
    frame.vertex,
    "vec4 mvPosition = viewMatrix * vec4(fxModelPos, 1.0);",
    "p_cameraDistance = length(mvPosition.xyz);",
    "gl_Position = projectionMatrix * mvPosition;",
    "if (!fxStripVisible) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); }",
    "#ifdef USE_ALPHAHASH",
    "  vPosition = fxModelPos;",
    "#endif",
    "#include <fog_vertex>",
    "}",
  ].join("\n");

  const fragmentShader = [
    FX_FRAGMENT_MODEL_MATRIX,
    FX_CORE_PARTICLE_DEFINES,
    ...sharedDeclarations,
    properties.fragmentDeclarations,
    graphVaryings(program),
    program.fragment.uniformDeclarations.join("\n"),
    externalSamplingFunctions(slots.external),
    cameraDepthFunctions(render),
    program.fragment.helperFunctions.join("\n"),
    "#include <common>",
    "#include <alphahash_pars_fragment>",
    "#include <fog_pars_fragment>",
    "void main() {",
    frame.fragment,
    program.fragment.body.join("\n"),
    ...colorFragmentTail(program, renderMode),
    "}",
  ].join("\n");

  const uniforms: Record<string, IUniform> = { ...UniformsUtils.clone(UniformsLib.fog) };
  bindUniforms(uniforms, slots);
  Object.assign(uniforms, strip.uniforms);

  return colorMaterial({
    render,
    name: strip.name,
    uniforms,
    vertexShader,
    fragmentShader,
    renderMode,
    lit: false,
    cacheKey: `fx-${strip.kind}-${layout.kind}_${programCacheKey(render, program, slots.external)}`,
  });
}

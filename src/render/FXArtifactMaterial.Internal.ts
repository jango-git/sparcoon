import type { IUniform } from "three";
import { DoubleSide, NormalBlending, ShaderMaterial, UniformsLib, UniformsUtils } from "three";
import type {
  FXParticleReads,
  FXRenderArtifact,
  FXSurfaceReads,
  FXValueSlot,
} from "../artifact/FXArtifact.js";
import {
  FX_CORE_LIFECYCLE,
  FX_CORE_PARTICLE_DEFINES,
  FX_CORE_POSITION,
  meshPropertyKeyFor,
} from "../coreLayout.js";
import type { GLTypeInfo } from "../instancedParticle/glTypeInfo.js";
import type { FXPackedAttribute, FXPackedMember } from "./FXAttributePacking.js";
import {
  assertCameraDepthMode,
  bindCameraDepth,
  cameraDepthFunctions,
  cameraDepthStub,
} from "./FXCameraDepth.Internal.js";
import {
  isLitArtifact,
  lightingFunctions,
  lightingStubs,
} from "./FXLightingIntrinsics.Internal.js";
import { floatGLSLType } from "./FXAttributePacking.js";
import {
  assertExternalTexture,
  bindExternalTextures,
  externalSamplingFunctions,
  externalSamplingKey,
  writeExternalTexture,
} from "./FXExternalTexture.Internal.js";
import type { FXExternalTextureBindings } from "./FXExternalTexture.Internal.js";
import type { FXExternalTexture, FXUniformValue } from "./FXExternalTexture.js";
import type { FXRenderMode } from "./FXMaterialOptions.js";
import { ownSlot } from "../artifact/FXValueSlots.Internal.js";
import type { FXDrawInputs } from "./FXDrawInputs.js";

// Three declares `modelMatrix` in the vertex prefix only, yet sets it on every program it draws: a
// fragment-stage read (`world-matrix`, `inverse-world-matrix` - the artifact's targets list it in
// both stages) needs its own declaration, or the fragment shader fails to compile. At the vertex
// stage's precision (highp) where the fragment stage has it, so the two declarations link.
const FX_FRAGMENT_MODEL_MATRIX = [
  "#ifdef GL_FRAGMENT_PRECISION_HIGH",
  "uniform highp mat4 modelMatrix;",
  "#else",
  "uniform mat4 modelMatrix;",
  "#endif",
].join("\n");

// Mutable holder wired into the Three material as `u_time`/`u_deltaTime`; shape-compatible with IUniform.
export interface FXFrameTimeUniform {
  value: number;
}

// Mutable holder wired into a material as `objectVelocity`/`objectAngularVelocity`;
// shape-compatible with IUniform.
export interface FXFrameVec3Uniform {
  value: readonly [number, number, number];
}

/** Render options shared by every artifact material kind. */
interface RenderMaterialOptions {
  renderMode?: FXRenderMode;
}

/** The Three material transparency/depth flags for a render mode. Blending is always `NormalBlending`
 *  (`premultipliedAlpha`) - additive is done in-shader (see {@link blendTail}), not a separate mode. */
function materialFlags(renderMode: FXRenderMode): {
  transparent: boolean;
  depthWrite: boolean;
  alphaHash: boolean;
} {
  const blended = renderMode === "blending";
  return { transparent: blended, depthWrite: !blended, alphaHash: renderMode === "alphaHash" };
}

/** The particle properties (`position`, `lifecycle`, `fx_<name>`) `reads` names. */
function readProperties(reads: FXParticleReads): string[] {
  const properties = reads.attributes.map(meshPropertyKeyFor);
  if (reads.position) {
    properties.push(FX_CORE_POSITION);
  }
  if (reads.lifecycle) {
    properties.push(FX_CORE_LIFECYCLE);
  }
  return properties;
}

/** The particle properties the fragment stage reads - each one a varying. */
function fragmentReadProperties(render: FXRenderArtifact): ReadonlySet<string> {
  return new Set(readProperties(render.fragment.particleReads));
}

/** The particle properties either stage reads. */
export function renderReadProperties(render: FXRenderArtifact): ReadonlySet<string> {
  return new Set([
    ...readProperties(render.vertex.particleReads),
    ...readProperties(render.fragment.particleReads),
  ]);
}

/**
 * What a particle material reads from its mesh (built by the driver that owns the mesh, see
 * `particleLayout`, and by the render budget the same way): the packed attribute views the mesh
 * binds the fields the render reads through, plus the fields the render reads that the mesh does
 * not hold at all.
 */
export interface FXParticleLayout {
  /** The views the mesh binds, each as `a_<view.name>` - every field the render reads that the
   *  mesh holds is a member of exactly one. */
  readonly packed: readonly FXPackedAttribute[];
  /**
   * The fields the render reads that nothing writes. Attributes have no defaults, so such a field
   * is always zero: the shader declares it as that constant - no buffer, no attribute slot - the
   * same as a trail reading a field its emitter does not hold (see {@link FXTrailLayout.missing}).
   */
  readonly missing: Readonly<Record<string, GLTypeInfo>>;
}

/** The GLSL type of a packed view: `float` .. `vec4`. */
function viewType(view: FXPackedAttribute): string {
  return floatGLSLType(view.components);
}

/**
 * `attribute`'s components holding `member`: a swizzle (`.xyz`, `.w`), or nothing when the member
 * is the whole view - so an unpacked field reads exactly as it did before packing.
 */
function memberSwizzle(view: FXPackedAttribute, member: FXPackedMember): string {
  if (member.componentOffset === 0 && member.components === view.components) {
    return "";
  }
  return `.${"xyzw".slice(member.componentOffset, member.componentOffset + member.components)}`;
}

/**
 * The statements splitting packed views back into one value per field: `target(member)` takes
 * the member's components of the view bound as `attributeName(view)`. GLSL ES 1.00 throughout -
 * a swizzle of an attribute is an ordinary expression.
 */
function unpackStatements(
  views: readonly FXPackedAttribute[],
  attributeName: (view: FXPackedAttribute) => string,
  target: (member: FXPackedMember) => string,
): string[] {
  return views.flatMap((view) =>
    view.members.map(
      (member) => `${target(member)} = ${attributeName(view)}${memberSwizzle(view, member)};`,
    ),
  );
}

/**
 * Each packed view becomes an `a_<view.name>` attribute, split back into the `p_<name>` property
 * of every field it carries, which the generated code reads (directly, or through
 * FX_CORE_PARTICLE_DEFINES' macros) - unchanged by packing. The layout's views carry only fields
 * the render reads (see `particleLayout`), so each is declared. A missing field's property is a
 * zero constant instead. Only a property the fragment stage reads makes `p_<name>` a varying; for
 * the rest it is a plain vertex-shader global, so it costs none of the GPU's few varying vectors.
 * Shared by both adapters and the depth material.
 */
function declareVaryings(
  render: FXRenderArtifact,
  layout: FXParticleLayout,
): {
  attributeDeclarations: string;
  vertexVaryingDeclarations: string;
  fragmentVaryingDeclarations: string;
  vertexAssignments: string;
} {
  const properties: Record<string, string> = {};
  for (const view of layout.packed) {
    for (const member of view.members) {
      properties[member.name] = floatGLSLType(member.components);
    }
  }
  for (const name in layout.missing) {
    properties[name] = layout.missing[name].glslTypeName;
  }
  const fragmentReads = fragmentReadProperties(render);
  const vertexVaryingDeclarations: string[] = [];
  const fragmentVaryingDeclarations: string[] = [];
  for (const name in properties) {
    const glslTypeName = properties[name];
    if (fragmentReads.has(name)) {
      vertexVaryingDeclarations.push(`varying ${glslTypeName} p_${name};`);
      fragmentVaryingDeclarations.push(`varying ${glslTypeName} p_${name};`);
    } else {
      vertexVaryingDeclarations.push(`${glslTypeName} p_${name};`);
    }
  }
  const views = layout.packed;
  const attributeName = (view: FXPackedAttribute): string => `a_${view.name}`;
  const vertexAssignments = [
    ...unpackStatements(views, attributeName, (member) => `p_${member.name}`),
    ...Object.keys(layout.missing).map(
      (name) => `p_${name} = ${layout.missing[name].glslTypeName}(0.0);`,
    ),
  ];
  return {
    attributeDeclarations: views
      .map((view) => `attribute ${viewType(view)} ${attributeName(view)};`)
      .join("\n"),
    vertexVaryingDeclarations: vertexVaryingDeclarations.join("\n"),
    fragmentVaryingDeclarations: fragmentVaryingDeclarations.join("\n"),
    vertexAssignments: vertexAssignments.join("\n"),
  };
}

/**
 * `FX_FLAT`: the `flat` qualifier where the shader's GLSL has one (ES 3.00 - three upgrades a
 * material to it on WebGL2), nothing on GLSL ES 1.00 - where interpolating a value the same at all
 * of a primitive's vertices gives it back.
 */
const FX_FLAT_DEFINE = [
  "#if __VERSION__ >= 300",
  "#define FX_FLAT flat",
  "#else",
  "#define FX_FLAT",
  "#endif",
].join("\n");

/** The declarations of what the graph carries between its stages - the same in both stages. */
function graphVaryings(render: FXRenderArtifact): string {
  const flat = render.varyings.some((varying) => varying.interpolation === "flat");
  return [
    ...(flat ? [FX_FLAT_DEFINE] : []),
    ...render.varyings.map(
      (varying) =>
        `${varying.interpolation === "flat" ? "FX_FLAT " : ""}varying ${varying.type} ${varying.name};`,
    ),
  ].join("\n");
}

/** GLSL expression for a vertex output slot, or its default when the slot is unbound. */
function outputOrDefault(
  outputs: Readonly<Record<string, string>>,
  slot: string,
  fallback: string,
): string {
  return slot in outputs ? outputs[slot] : fallback;
}

/**
 * Builds `fxModelPos = particleCenter + (particleTransform * (vertexTransform * position)).xyz` from
 * the two optional mat4 outputs (identity when unwired). Geometry-agnostic - a billboard is just a
 * plane whose `particleTransform` is a camera-facing rotation. `withNormal` also emits `fxNormalXform`
 * (mat3) for the lambert adapter's real mesh normal.
 */
function transformPreamble(outputs: Readonly<Record<string, string>>, withNormal: boolean): string {
  const particleTransform = outputOrDefault(outputs, "particleTransform", "mat4(1.0)");
  const vertexTransform = outputOrDefault(outputs, "vertexTransform", "mat4(1.0)");
  const lines = [
    `mat4 fxParticleXform = ${particleTransform};`,
    `mat4 fxVertexXform = ${vertexTransform};`,
    "vec3 particleCenter = vec3(PARTICLE_POSITION_X, PARTICLE_POSITION_Y, PARTICLE_POSITION_Z);",
    "vec3 fxModelPos = particleCenter + (fxParticleXform * (fxVertexXform * vec4(position, 1.0))).xyz;",
  ];
  if (withNormal) {
    lines.push("mat3 fxNormalXform = mat3(fxParticleXform) * mat3(fxVertexXform);");
  }
  return lines.join("\n");
}

/**
 * The world-space surface frame, built for exactly what the fragment code reads
 * ({@link FXSurfaceReads}) - `geometryNormal`, `geometryTangent`, `worldPosition`, the canonical
 * author space for normals. Each builtin rides a varying vector, and the fixed part of a material is
 * what a graph's own varyings have to fit beside, so an unread one is not declared at all.
 * `fxModelPos`/`objectNormal` are already world space (no modelMatrix step - see fxWorldMatrix for
 * the explicit emitter-attach opt-in); the tangent is the plane's local +X (the u axis), so
 * billboard roll/orientation is baked in here once for every consumer (normal maps, spherical
 * normal, fresnel).
 *
 * `threeNormals` keeps three's view-space chain (`defaultnormal_vertex` -> `transformedNormal`,
 * `normal_vertex` -> `vNormal`), which a lit material's light and shadow chunks read whatever the
 * graph does; nothing of ours reads it.
 */
interface FXSurfaceFrame {
  /** Varying declarations, the same in both stages. */
  readonly varyings: string;
  /** Vertex pars, after `#include <common>`. */
  readonly vertexPars: string;
  /** Vertex statements, after the transform preamble (reads `fxModelPos`, `fxNormalXform`). */
  readonly vertex: string;
  /** Fragment pars, after `#include <common>`. */
  readonly fragmentPars: string;
  /** Fragment statements, at the top of `main` before the node body. */
  readonly fragment: string;
  /** Whether the transform preamble must emit `fxNormalXform`. */
  readonly normalTransform: boolean;
}

function surfaceFrame(reads: FXSurfaceReads, threeNormals: boolean): FXSurfaceFrame {
  const varyings: string[] = [];
  const vertex: string[] = [];
  const fragment: string[] = [];
  if (reads.normal || threeNormals) {
    vertex.push("vec3 objectNormal = fxNormalXform * normal;");
  }
  if (threeNormals) {
    vertex.push("#include <defaultnormal_vertex>", "#include <normal_vertex>");
  }
  if (reads.normal) {
    varyings.push("varying vec3 vWorldNormal;");
    vertex.push("vWorldNormal = normalize( objectNormal );");
    // Front-facing sign (matching `normal_fragment_begin` under DOUBLE_SIDED): a back-facing
    // fragment flips the normal.
    fragment.push(
      "float fxFaceDirection = gl_FrontFacing ? 1.0 : - 1.0;",
      "vec3 geometryNormal = normalize( vWorldNormal ) * fxFaceDirection;",
    );
  }
  if (reads.tangent) {
    varyings.push("varying vec3 vWorldTangent;");
    vertex.push("vWorldTangent = normalize( fxNormalXform * vec3( 1.0, 0.0, 0.0 ) );");
    fragment.push("vec3 geometryTangent = normalize( vWorldTangent );");
  }
  if (reads.position) {
    varyings.push("varying vec3 vWorldPos;");
    vertex.push("vWorldPos = fxModelPos;");
    fragment.push("vec3 worldPosition = vWorldPos;");
  }
  return {
    varyings: varyings.join("\n"),
    vertexPars: threeNormals ? "#include <normal_pars_vertex>" : "",
    vertex: vertex.join("\n"),
    fragmentPars: threeNormals ? "#include <normal_pars_fragment>" : "",
    fragment: fragment.join("\n"),
    normalTransform: reads.normal || reads.tangent || threeNormals,
  };
}

// `#include <project_vertex>` replacement: projects `fxModelPos`, records camera distance, feeds alpha-hash.
// World -> view via `viewMatrix` only, deliberately skipping `modelMatrix`: particle simulation
// authors `fxModelPos` directly in world space (reference space == world by convention), so the
// emitter's own scene transform must never re-enter here - see fxWorldMatrix for the explicit
// opt-in a graph uses when it wants particles attached to the emitter instead.
function projectFromModelPos(): string {
  return [
    "vec4 mvPosition = viewMatrix * vec4(fxModelPos, 1.0);",
    "p_cameraDistance = length(mvPosition.xyz);",
    "gl_Position = projectionMatrix * mvPosition;",
    // A dead particle (age >= lifetime, coreLayout.ts's convention) is pushed outside the clip
    // volume on every axis so the GPU's trivial-reject clip test drops the whole primitive before
    // rasterization - a fragment discard would defeat opaque mode's early-Z instead (see
    // alphaDiscardLines, which already skips discard for that reason). Both backends keep dead
    // slots in place in a fixed ring (FXInstancedParticle, FXTransformFeedbackParticle) and draw
    // them, so this is what actually hides them - in the depth (shadow) material too.
    "if (PARTICLE_AGE >= PARTICLE_LIFETIME) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); }",
    "#ifdef USE_ALPHAHASH",
    "  vPosition = fxModelPos;",
    "#endif",
  ].join("\n");
}

/**
 * One material driver's live uniform slots: the clock and the object's motion it pushes each
 * frame, the artifact's own uniforms (seeded from their initial values) and its external texture
 * bindings. Every instance owns its set, so instances of one (module-scoped) artifact never share a
 * value; the artifact's `uniforms` stay its initial values, which nothing writes.
 */
export interface FXMaterialSlots {
  readonly time: FXFrameTimeUniform;
  readonly deltaTime: FXFrameTimeUniform;
  readonly velocity: FXFrameVec3Uniform;
  readonly angularVelocity: FXFrameVec3Uniform;
  /** The artifact's non-external uniforms, by name. */
  readonly values: Readonly<Record<string, FXValueSlot<FXUniformValue>>>;
  readonly external: FXExternalTextureBindings;
}

/** A fresh slot set for `render`: the clock at 0, at rest, each uniform at its initial value. */
export function createMaterialSlots(
  render: FXRenderArtifact,
  external: FXExternalTextureBindings = {},
): FXMaterialSlots {
  const values: Record<string, FXValueSlot<FXUniformValue>> = {};
  for (const name in render.uniforms) {
    const uniform = render.uniforms[name];
    if (!("external" in uniform)) {
      values[name] = ownSlot<FXUniformValue>(uniform);
    }
  }
  return {
    time: { value: 0 },
    deltaTime: { value: 0 },
    velocity: { value: [0, 0, 0] },
    angularVelocity: { value: [0, 0, 0] },
    values,
    external,
  };
}

/** Wires `slots` into a material's uniforms by reference: a later write is drawn next frame. */
function bindUniforms(uniforms: Record<string, IUniform>, slots: FXMaterialSlots): void {
  uniforms["u_time"] = slots.time;
  uniforms["u_deltaTime"] = slots.deltaTime;
  uniforms["objectVelocity"] = slots.velocity;
  uniforms["objectAngularVelocity"] = slots.angularVelocity;
  for (const name in slots.values) {
    uniforms[name] = slots.values[name];
  }
  bindExternalTextures(uniforms, slots.external);
}

/** Throws when any external texture in `values` cannot be a value edit of its slot (see
 *  {@link assertExternalTexture}); writes nothing. */
export function assertArtifactUniformValues(
  slots: FXMaterialSlots,
  values: Readonly<Record<string, FXUniformValue>>,
): void {
  for (const name in values) {
    if (name in slots.external) {
      assertExternalTexture(slots.external[name], values[name] as FXExternalTexture, name);
    }
  }
}

/**
 * One tick's draw inputs into `slots`: the clock and motion the shaders read, and `render`'s draw
 * stage (when it has one) computed from them into the instance's draw uniforms.
 */
export function advanceMaterialSlots(
  slots: FXMaterialSlots,
  render: FXRenderArtifact,
  frame: FXDrawInputs,
): void {
  slots.time.value = frame.time;
  slots.deltaTime.value = frame.deltaTime;
  slots.velocity.value = frame.objectVelocity;
  slots.angularVelocity.value = frame.objectAngularVelocity;
  render.compute?.(frame, slots.values);
}

/**
 * A value edit of a material's own slots, the counterpart of {@link bindUniforms}. Unknown name =
 * no-op (an editor<->runtime name drift never corrupts values). All or nothing: every value is
 * checked before the first write.
 */
export function applyArtifactUniformValues(
  slots: FXMaterialSlots,
  values: Readonly<Record<string, FXUniformValue>>,
): void {
  assertArtifactUniformValues(slots, values);
  for (const name in values) {
    const value = values[name];
    if (name in slots.external) {
      writeExternalTexture(slots.external[name], value as FXExternalTexture);
    } else if (name in slots.values) {
      slots.values[name].value = value;
    }
  }
}

/** Deterministic djb2 hash of the artifact's GLSL - a content-addressed program cache key. */
function hashString(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

// Stable program-cache key from the artifact's GLSL and how its external textures are bound (a region
// slot is its own program variant): identical artifacts bound alike share one compiled program.
export function fxRenderArtifactCacheKey(
  render: FXRenderArtifact,
  external: FXExternalTextureBindings = {},
): string {
  return hashString(
    [
      externalSamplingKey(external),
      render.lightingIntrinsics.join(","),
      render.vertex.uniformDeclarations.join("|"),
      render.fragment.uniformDeclarations.join("|"),
      graphVaryings(render),
      render.vertex.helperFunctions.join("|"),
      render.vertex.body.join("|"),
      render.fragment.helperFunctions.join("|"),
      render.fragment.body.join("|"),
      Object.entries(render.outputs)
        .map(([slot, expression]) => `${slot}=${expression}`)
        .join("|"),
    ].join("\n"),
  );
}

// The fragment alpha-discard for a render mode (operates on `diffuseColor`). `alphaThresholdExpression`
// is the hard cutoff (default 0.0075, clamped to [0,1] so an out-of-range graph expression can't force
// an always/never discard), applied in every mode except `opaque` - `opaque` returns early with no
// discard at all, so it keeps the GPU's early depth test. `blending` also drops near-zero fragments;
// `alphaHash` adds the stochastic `alphahash_fragment` discard (needs `alphahash_pars_fragment` +
// `vPosition` in scope).
function alphaDiscardLines(renderMode: FXRenderMode, alphaThresholdExpression: string): string {
  if (renderMode === "opaque") {
    return "";
  }
  const cutoff = `if (diffuseColor.a < clamp(${alphaThresholdExpression}, 0.0, 1.0)) discard;`;
  switch (renderMode) {
    case "blending":
      return `if (diffuseColor.a < 0.0035) discard;\n${cutoff}`;
    case "alphaHash":
      return `${cutoff}\n#include <alphahash_fragment>`;
    case "alphaTest":
      return cutoff;
  }
}

// The blend tail after the color is assembled: premultiply, then (blending mode only) fold `additivity`
// into the OUTPUT alpha so a single premultiplied `NormalBlending` interpolates over -> additive: the
// color stays premultiplied by the true alpha, but reducing `gl_FragColor.a` toward 0 preserves more of
// the destination (`a=0` => pure additive). `additivity` defaults to 0 (plain "over").
function blendTail(renderMode: FXRenderMode, outputs: Readonly<Record<string, string>>): string {
  const lines = ["gl_FragColor.rgb *= gl_FragColor.a;"];
  if (renderMode === "blending") {
    lines.push(
      `gl_FragColor.a *= (1.0 - clamp(${outputOrDefault(outputs, "additivity", "0.0")}, 0.0, 1.0));`,
    );
  }
  return lines.join("\n");
}

// The optional `intensity` slot: a multiplier on the color alone, never its alpha - so a glow can be
// brightened or dimmed without the discard floor or the additive weight (both off the alpha) moving.
// Applied before tone mapping and the color-space conversion, in linear light. Absent: no line.
function intensityLine(outputs: Readonly<Record<string, string>>): string {
  return "intensity" in outputs ? `diffuseColor.rgb *= max(${outputs["intensity"]}, 0.0);` : "";
}

/** The fragment tail every color material ends with: the graph's `albedo`, the render mode's
 *  discard, the `intensity` multiplier, then three's opaque -> tone mapping -> color space -> fog
 *  chunks and the blend tail. */
function colorFragmentTail(render: FXRenderArtifact, renderMode: FXRenderMode): string[] {
  const alphaThreshold = outputOrDefault(render.outputs, "alphaThreshold", "0.0075");
  return [
    `vec4 diffuseColor = ${render.outputs["albedo"]};`,
    alphaDiscardLines(renderMode, alphaThreshold),
    intensityLine(render.outputs),
    "vec3 outgoingLight = diffuseColor.rgb;",
    "#include <opaque_fragment>",
    "#include <tonemapping_fragment>",
    "#include <colorspace_fragment>",
    "#include <fog_fragment>",
    blendTail(renderMode, render.outputs),
  ];
}

/**
 * The `ShaderMaterial` every color material is: fogged, double-sided, premultiplied normal
 * blending (additive is in-shader), the render mode's transparency/depth flags, a program
 * cache key from the artifact's GLSL, and - when the artifact reads it - the camera depth.
 */
function colorMaterial(options: {
  readonly render: FXRenderArtifact;
  readonly name: string;
  readonly uniforms: Record<string, IUniform>;
  readonly vertexShader: string;
  readonly fragmentShader: string;
  readonly renderMode: FXRenderMode;
  readonly lit: boolean;
  readonly cacheKey: string;
}): ShaderMaterial {
  assertCameraDepthMode(options.render, options.renderMode);
  const flags = materialFlags(options.renderMode);
  const material = new ShaderMaterial({
    name: options.name,
    uniforms: options.uniforms,
    vertexShader: options.vertexShader,
    fragmentShader: options.fragmentShader,
    ...(options.lit ? { lights: true } : {}),
    fog: true,
    ...flags,
    depthTest: true,
    blending: NormalBlending,
    side: DoubleSide,
    forceSinglePass: true,
    premultipliedAlpha: true,
  });
  // `alphaHash` pulls in Three's own alphahash_pars_fragment chunk, which calls dFdx/dFdy - under
  // a real WebGL1 context those need an explicit extension request or the shader fails to
  // compile ("extension is disabled"); under WebGL2 this is a no-op (dFdx/dFdy are core there,
  // and three skips extension generation entirely for a WebGL2 context either way).
  material.extensions.derivatives = flags.alphaHash;
  material.customProgramCacheKey = (): string => options.cacheKey;
  if (options.render.sceneDepth) {
    bindCameraDepth(material);
  }
  return material;
}

// Builds an unlit artifact as a self-contained ShaderMaterial: fog uniforms/defines come from Three
// (`fog: true`), the tone-mapping + output-colorspace functions from Three's fragment prefix; the rest
// is ours. The fragment tail mirrors MeshBasic (`opaque_fragment` -> tonemapping -> colorspace -> fog
// -> premultiply) by reusing those exact ShaderChunks, so pixels match the former onBeforeCompile splice.
// Deliberately dropped vs MeshBasic: clipping planes, logarithmic depth, dithering (unused by particles).
// The surface frame is built for what the fragment reads (see surfaceFrame), so the
// `geometryNormal` builtin - fresnel, rim, normal masks - works with no lighting node present.
export function buildUnlitArtifactMaterial(
  render: FXRenderArtifact,
  layout: FXParticleLayout,
  slots: FXMaterialSlots,
): ShaderMaterial {
  const options: RenderMaterialOptions = render.options ?? {};
  const renderMode = options.renderMode ?? "blending";

  if (!("albedo" in render.outputs)) {
    throw new Error("buildUnlitArtifactMaterial: render artifact has no 'albedo' output");
  }
  const {
    attributeDeclarations,
    vertexVaryingDeclarations,
    fragmentVaryingDeclarations,
    vertexAssignments,
  } = declareVaryings(render, layout);
  const cacheKey = fxRenderArtifactCacheKey(render, slots.external);
  const frame = surfaceFrame(render.fragment.surfaceReads, false);

  const vertexShader = [
    FX_CORE_PARTICLE_DEFINES,
    attributeDeclarations,
    "varying vec2 p_uv;",
    "uniform float u_time;",
    "uniform float u_deltaTime;",
    "uniform vec3 objectVelocity;",
    "uniform vec3 objectAngularVelocity;",
    "varying float p_cameraDistance;",
    frame.varyings,
    vertexVaryingDeclarations,
    graphVaryings(render),
    render.vertex.uniformDeclarations.join("\n"),
    render.vertex.helperFunctions.join("\n"),
    // `common` declares `vPosition` (under USE_ALPHAHASH); `fog_pars_vertex` declares `vFogDepth`.
    "#include <common>",
    "#include <fog_pars_vertex>",
    frame.vertexPars,
    "void main() {",
    "p_uv = uv;",
    vertexAssignments,
    render.vertex.body.join("\n"),
    transformPreamble(render.outputs, frame.normalTransform),
    frame.vertex,
    projectFromModelPos(),
    "#include <fog_vertex>",
    "}",
  ].join("\n");

  // `opaque_fragment` below forces alpha to 1 when the material is opaque (the hash case,
  // `transparent: false`), exactly as MeshBasic did.
  const fragmentShader = [
    FX_FRAGMENT_MODEL_MATRIX,
    FX_CORE_PARTICLE_DEFINES,
    "varying vec2 p_uv;",
    "uniform float u_time;",
    "uniform float u_deltaTime;",
    "uniform vec3 objectVelocity;",
    "uniform vec3 objectAngularVelocity;",
    "varying float p_cameraDistance;",
    frame.varyings,
    fragmentVaryingDeclarations,
    graphVaryings(render),
    render.fragment.uniformDeclarations.join("\n"),
    externalSamplingFunctions(slots.external),
    cameraDepthFunctions(render),
    render.fragment.helperFunctions.join("\n"),
    "#include <common>",
    "#include <alphahash_pars_fragment>",
    "#include <fog_pars_fragment>",
    frame.fragmentPars,
    "void main() {",
    frame.fragment,
    render.fragment.body.join("\n"),
    ...colorFragmentTail(render, renderMode),
    "}",
  ].join("\n");

  // ShaderMaterial does not auto-merge fog uniforms (unlike the built-in materials), so seed the fog
  // slots here; `bindUniforms` then wires the instance's live slots by reference (live scrub).
  const uniforms: Record<string, IUniform> = { ...UniformsUtils.clone(UniformsLib.fog) };
  bindUniforms(uniforms, slots);

  return colorMaterial({
    render,
    name: "FXUnlitArtifactMaterial",
    uniforms,
    vertexShader,
    fragmentShader,
    renderMode,
    lit: false,
    cacheKey: `fx-unlit_${cacheKey}`,
  });
}

// The lit material variant ({@link buildArtifactMaterial} picks it when the capability is non-empty):
// the graph's `albedo` already carries the shaded color (a lighting node emitted an intrinsic call -
// FXLightingIntrinsics.Internal defines the ones the artifact lists), so `main` uses the flat unlit tail (`outgoingLight = diffuseColor.rgb`) - no
// stock light chain runs in `main`. The material supplies Three's full Lambert light infrastructure
// (light + fog uniforms, pars chunks, view-space `vNormal`/`vViewPosition` + per-particle shadow
// plumbing) so the intrinsics resolve. The `geometryNormal` builtin (the surface normal every fragment
// node may read, and a lighting node's default `normal` argument) is computed at the top of `main`. Shading
// normal/emission are node inputs, not surface slots.
function buildLitArtifactMaterial(
  render: FXRenderArtifact,
  layout: FXParticleLayout,
  slots: FXMaterialSlots,
): ShaderMaterial {
  const options: RenderMaterialOptions = render.options ?? {};
  const renderMode = options.renderMode ?? "blending";

  if (!("albedo" in render.outputs)) {
    throw new Error("buildLitArtifactMaterial: render artifact has no 'albedo' output");
  }
  const {
    attributeDeclarations,
    vertexVaryingDeclarations,
    fragmentVaryingDeclarations,
    vertexAssignments,
  } = declareVaryings(render, layout);
  const cacheKey = fxRenderArtifactCacheKey(render, slots.external);
  const frame = surfaceFrame(render.fragment.surfaceReads, true);

  const vertexShader = [
    "#define LAMBERT",
    FX_CORE_PARTICLE_DEFINES,
    attributeDeclarations,
    "varying vec2 p_uv;",
    "uniform float u_time;",
    "uniform float u_deltaTime;",
    "uniform vec3 objectVelocity;",
    "uniform vec3 objectAngularVelocity;",
    "varying float p_cameraDistance;",
    frame.varyings,
    "varying vec3 vViewPosition;",
    vertexVaryingDeclarations,
    graphVaryings(render),
    render.vertex.uniformDeclarations.join("\n"),
    render.vertex.helperFunctions.join("\n"),
    "#include <common>",
    "#include <fog_pars_vertex>",
    frame.vertexPars,
    "#include <shadowmap_pars_vertex>",
    "void main() {",
    "p_uv = uv;",
    vertexAssignments,
    render.vertex.body.join("\n"),
    transformPreamble(render.outputs, frame.normalTransform),
    frame.vertex,
    "vec3 transformed = position;",
    projectFromModelPos(),
    "vViewPosition = - mvPosition.xyz;",
    "#if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined( USE_SHADOWMAP ) || defined( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0",
    "  vec4 worldPosition = vec4(particleCenter, 1.0);",
    "#endif",
    "#include <shadowmap_vertex>",
    "#include <fog_vertex>",
    "}",
  ].join("\n");

  const fragmentShader = [
    FX_FRAGMENT_MODEL_MATRIX,
    "#define LAMBERT",
    FX_CORE_PARTICLE_DEFINES,
    "varying vec2 p_uv;",
    "uniform float u_time;",
    "uniform float u_deltaTime;",
    "uniform vec3 objectVelocity;",
    "uniform vec3 objectAngularVelocity;",
    "varying float p_cameraDistance;",
    frame.varyings,
    fragmentVaryingDeclarations,
    graphVaryings(render),
    render.fragment.uniformDeclarations.join("\n"),
    externalSamplingFunctions(slots.external),
    cameraDepthFunctions(render),
    render.fragment.helperFunctions.join("\n"),
    "#include <common>",
    "#include <packing>",
    "#include <alphahash_pars_fragment>",
    "#include <fog_pars_fragment>",
    "#include <bsdfs>",
    "#include <lights_pars_begin>",
    frame.fragmentPars,
    "#include <lights_lambert_pars_fragment>",
    "#include <shadowmap_pars_fragment>",
    lightingFunctions(render),
    "void main() {",
    // The lighting intrinsics convert the world-space frame to view space at their own boundary.
    frame.fragment,
    render.fragment.body.join("\n"),
    ...colorFragmentTail(render, renderMode),
    "}",
  ].join("\n");

  const uniforms: Record<string, IUniform> = UniformsUtils.merge([
    UniformsLib.lights,
    UniformsLib.fog,
  ]);
  bindUniforms(uniforms, slots);

  return colorMaterial({
    render,
    name: "FXLightingNodesArtifactMaterial",
    uniforms,
    vertexShader,
    fragmentShader,
    renderMode,
    lit: true,
    cacheKey: `fx-lit-nodes_${cacheKey}`,
  });
}

// Single entry point the material driver calls: the render artifact's lighting capability
// ({@link FXRenderArtifact.lightingIntrinsics}) picks the variant. Empty => unlit (flat albedo, no
// light infrastructure); non-empty => the lit variant, which defines the listed intrinsics and lights up
// Three's infrastructure. There is no per-model dispatch - the shading lives in the graph.
export function buildArtifactMaterial(
  render: FXRenderArtifact,
  layout: FXParticleLayout,
  slots: FXMaterialSlots,
): ShaderMaterial {
  const build = isLitArtifact(render) ? buildLitArtifactMaterial : buildUnlitArtifactMaterial;
  return build(render, layout, slots);
}

// VFX-mesh material path: a single, non-instanced mesh (compiled against the mesh render target).
// Everything below reuses the particle path's shared, attribute-free helpers (bindUniforms,
// alphaDiscardLines, blendTail, materialFlags, the lighting intrinsics, the cache key) but drops the
// three per-particle couplings: FX_CORE_PARTICLE_DEFINES, the `a_`/`p_` instanced-attribute varyings
// (declareVaryings), and the particle-center vertex epilogue. It never touches the particle builders.

// Mesh twin of transformPreamble with NO particle center: a mesh is one object, so its vertices
// project straight from model space. The two optional mat4 outputs are the mesh's object-local
// transform (identity when unwired); withNormal emits fxNormalXform for the real mesh normal.
function meshTransformPreamble(
  outputs: Readonly<Record<string, string>>,
  withNormal: boolean,
): string {
  const particleTransform = outputOrDefault(outputs, "particleTransform", "mat4(1.0)");
  const vertexTransform = outputOrDefault(outputs, "vertexTransform", "mat4(1.0)");
  const lines = [
    `mat4 fxParticleXform = ${particleTransform};`,
    `mat4 fxVertexXform = ${vertexTransform};`,
    "vec3 fxModelPos = (fxParticleXform * (fxVertexXform * vec4(position, 1.0))).xyz;",
  ];
  if (withNormal) {
    lines.push("mat3 fxNormalXform = mat3(fxParticleXform) * mat3(fxVertexXform);");
  }
  return lines.join("\n");
}

// Mesh `#include <project_vertex>` replacement: plain world-space projection (`viewMatrix` only,
// no `modelMatrix` - see {@link projectFromModelPos}). No `p_cameraDistance` (a mesh has no
// per-particle camera-distance builtin); still feeds alpha-hash `vPosition`.
function meshProjectFromModelPos(): string {
  return [
    "vec4 mvPosition = viewMatrix * vec4(fxModelPos, 1.0);",
    "gl_Position = projectionMatrix * mvPosition;",
    "#ifdef USE_ALPHAHASH",
    "  vPosition = fxModelPos;",
    "#endif",
  ].join("\n");
}

// Unlit mesh material: the flat-albedo twin of buildUnlitArtifactMaterial with the particle plumbing
// removed. The world surface frame (geometryNormal/geometryTangent/worldPosition) is built from the
// mesh's real normal, so fresnel/rim/normal-maps work with no lighting node present.
function buildMeshUnlitArtifactMaterial(
  render: FXRenderArtifact,
  slots: FXMaterialSlots,
): ShaderMaterial {
  const options: RenderMaterialOptions = render.options ?? {};
  const renderMode = options.renderMode ?? "blending";

  if (!("albedo" in render.outputs)) {
    throw new Error("buildMeshUnlitArtifactMaterial: render artifact has no 'albedo' output");
  }
  const cacheKey = fxRenderArtifactCacheKey(render, slots.external);
  const frame = surfaceFrame(render.fragment.surfaceReads, false);

  const vertexShader = [
    "varying vec2 p_uv;",
    "uniform float u_time;",
    "uniform float u_deltaTime;",
    "uniform vec3 objectVelocity;",
    "uniform vec3 objectAngularVelocity;",
    frame.varyings,
    graphVaryings(render),
    render.vertex.uniformDeclarations.join("\n"),
    render.vertex.helperFunctions.join("\n"),
    "#include <common>",
    "#include <fog_pars_vertex>",
    frame.vertexPars,
    "void main() {",
    "p_uv = uv;",
    render.vertex.body.join("\n"),
    meshTransformPreamble(render.outputs, frame.normalTransform),
    frame.vertex,
    meshProjectFromModelPos(),
    "#include <fog_vertex>",
    "}",
  ].join("\n");

  const fragmentShader = [
    FX_FRAGMENT_MODEL_MATRIX,
    "varying vec2 p_uv;",
    "uniform float u_time;",
    "uniform float u_deltaTime;",
    "uniform vec3 objectVelocity;",
    "uniform vec3 objectAngularVelocity;",
    frame.varyings,
    graphVaryings(render),
    render.fragment.uniformDeclarations.join("\n"),
    externalSamplingFunctions(slots.external),
    cameraDepthFunctions(render),
    render.fragment.helperFunctions.join("\n"),
    "#include <common>",
    "#include <alphahash_pars_fragment>",
    "#include <fog_pars_fragment>",
    frame.fragmentPars,
    "void main() {",
    frame.fragment,
    render.fragment.body.join("\n"),
    ...colorFragmentTail(render, renderMode),
    "}",
  ].join("\n");

  const uniforms: Record<string, IUniform> = { ...UniformsUtils.clone(UniformsLib.fog) };
  bindUniforms(uniforms, slots);

  return colorMaterial({
    render,
    name: "FXMeshUnlitArtifactMaterial",
    uniforms,
    vertexShader,
    fragmentShader,
    renderMode,
    lit: false,
    cacheKey: `fx-mesh-unlit_${cacheKey}`,
  });
}

// Lit mesh material: the lighting-nodes twin of buildLitArtifactMaterial (Three's Lambert light
// infrastructure + the fx_ shade intrinsics) with the particle plumbing removed. The graph's `albedo`
// already carries the shaded color, so `main` uses the flat tail.
function buildMeshLitArtifactMaterial(
  render: FXRenderArtifact,
  slots: FXMaterialSlots,
): ShaderMaterial {
  const options: RenderMaterialOptions = render.options ?? {};
  const renderMode = options.renderMode ?? "blending";

  if (!("albedo" in render.outputs)) {
    throw new Error("buildMeshLitArtifactMaterial: render artifact has no 'albedo' output");
  }
  const cacheKey = fxRenderArtifactCacheKey(render, slots.external);
  const frame = surfaceFrame(render.fragment.surfaceReads, true);

  const vertexShader = [
    "#define LAMBERT",
    "varying vec2 p_uv;",
    "uniform float u_time;",
    "uniform float u_deltaTime;",
    "uniform vec3 objectVelocity;",
    "uniform vec3 objectAngularVelocity;",
    frame.varyings,
    "varying vec3 vViewPosition;",
    graphVaryings(render),
    render.vertex.uniformDeclarations.join("\n"),
    render.vertex.helperFunctions.join("\n"),
    "#include <common>",
    "#include <fog_pars_vertex>",
    frame.vertexPars,
    "#include <shadowmap_pars_vertex>",
    "void main() {",
    "p_uv = uv;",
    render.vertex.body.join("\n"),
    meshTransformPreamble(render.outputs, frame.normalTransform),
    frame.vertex,
    "vec3 transformed = position;",
    meshProjectFromModelPos(),
    "vViewPosition = - mvPosition.xyz;",
    "#if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined( USE_SHADOWMAP ) || defined( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0",
    "  vec4 worldPosition = vec4(fxModelPos, 1.0);",
    "#endif",
    "#include <shadowmap_vertex>",
    "#include <fog_vertex>",
    "}",
  ].join("\n");

  const fragmentShader = [
    FX_FRAGMENT_MODEL_MATRIX,
    "#define LAMBERT",
    "varying vec2 p_uv;",
    "uniform float u_time;",
    "uniform float u_deltaTime;",
    "uniform vec3 objectVelocity;",
    "uniform vec3 objectAngularVelocity;",
    frame.varyings,
    graphVaryings(render),
    render.fragment.uniformDeclarations.join("\n"),
    externalSamplingFunctions(slots.external),
    cameraDepthFunctions(render),
    render.fragment.helperFunctions.join("\n"),
    "#include <common>",
    "#include <packing>",
    "#include <alphahash_pars_fragment>",
    "#include <fog_pars_fragment>",
    "#include <bsdfs>",
    "#include <lights_pars_begin>",
    frame.fragmentPars,
    "#include <lights_lambert_pars_fragment>",
    "#include <shadowmap_pars_fragment>",
    lightingFunctions(render),
    "void main() {",
    frame.fragment,
    render.fragment.body.join("\n"),
    ...colorFragmentTail(render, renderMode),
    "}",
  ].join("\n");

  const uniforms: Record<string, IUniform> = UniformsUtils.merge([
    UniformsLib.lights,
    UniformsLib.fog,
  ]);
  bindUniforms(uniforms, slots);

  return colorMaterial({
    render,
    name: "FXMeshLightingNodesArtifactMaterial",
    uniforms,
    vertexShader,
    fragmentShader,
    renderMode,
    lit: true,
    cacheKey: `fx-mesh-lit-nodes_${cacheKey}`,
  });
}

// Mesh entry point (the mesh twin of buildArtifactMaterial): the lighting capability picks flat vs lit.
// No `varyings` argument - a VFX mesh has no per-particle instanced attributes.
export function buildMeshArtifactMaterial(
  render: FXRenderArtifact,
  slots: FXMaterialSlots,
): ShaderMaterial {
  const build = isLitArtifact(render)
    ? buildMeshLitArtifactMaterial
    : buildMeshUnlitArtifactMaterial;
  return build(render, slots);
}

// The fragment tail that replaces the color output (opaque_fragment -> tonemapping -> ... ->
// blendTail) in the depth builders below. `packDepthToRGBA` (from `<packing>`) always packs RGBA:
// Three's shadow map only ever requests `RGBADepthPacking`, so `BasicDepthPacking` is unsupported.
const DEPTH_FRAGMENT_TAIL = [
  "float fragCoordZ = 0.5 * vHighPrecisionZW[0] / vHighPrecisionZW[1] + 0.5;",
  "gl_FragColor = packDepthToRGBA( fragCoordZ );",
];

// Depth (shadow-caster) twin of buildArtifactMaterial: the SAME compiled render IR spliced into a
// customDepthMaterial so a cast shadow's silhouette honors the authored shape/deformation and the
// exact same alpha cutout (dissolve, spherical-clip, blend-mode trim - all via alphaDiscardLines) as
// the visible material. A stock MeshDepthMaterial would ignore all of that and, worse, collapse every
// instanced particle onto one un-instanced vertex. It mirrors buildUnlit/LitArtifactMaterial's whole
// vertex+fragment scope (every builtin the IR body reads must be declared, since the body is the same
// IR) and only swaps the color tail for the RGBA depth pack. A lit graph's shade intrinsics resolve to
// their stubs (`lightingStubs`): only the discarded RGB depends on shading, and every intrinsic returns
// its input alpha unchanged, so the depth cutout stays correct. No light uniforms (`lights: true`): in
// the shadow pass Three would bind the light's shadow map - the very target being drawn - to a sampler
// the shade intrinsics read, a feedback loop the driver answers by dropping the draw (no shadow).
// Fog/logdepth/clipping-planes are dropped, same as the 4 color builders.
export function buildArtifactDepthMaterial(
  render: FXRenderArtifact,
  layout: FXParticleLayout,
  slots: FXMaterialSlots,
): ShaderMaterial {
  const options: RenderMaterialOptions = render.options ?? {};
  const renderMode = options.renderMode ?? "blending";
  const alphaThreshold = outputOrDefault(render.outputs, "alphaThreshold", "0.0075");

  if (!("albedo" in render.outputs)) {
    throw new Error("buildArtifactDepthMaterial: render artifact has no 'albedo' output");
  }
  const albedo = render.outputs["albedo"];
  const {
    attributeDeclarations,
    vertexVaryingDeclarations,
    fragmentVaryingDeclarations,
    vertexAssignments,
  } = declareVaryings(render, layout);
  const cacheKey = fxRenderArtifactCacheKey(render, slots.external);
  const frame = surfaceFrame(render.fragment.surfaceReads, false);

  const vertexShader = [
    FX_CORE_PARTICLE_DEFINES,
    attributeDeclarations,
    "varying vec2 p_uv;",
    "uniform float u_time;",
    "uniform float u_deltaTime;",
    "uniform vec3 objectVelocity;",
    "uniform vec3 objectAngularVelocity;",
    "varying float p_cameraDistance;",
    frame.varyings,
    // High-precision NDC z/w carried to the fragment for the depth pack (mirrors stock depth.glsl.js).
    "varying vec2 vHighPrecisionZW;",
    vertexVaryingDeclarations,
    graphVaryings(render),
    render.vertex.uniformDeclarations.join("\n"),
    render.vertex.helperFunctions.join("\n"),
    "#include <common>",
    frame.vertexPars,
    "void main() {",
    "p_uv = uv;",
    vertexAssignments,
    render.vertex.body.join("\n"),
    transformPreamble(render.outputs, frame.normalTransform),
    frame.vertex,
    projectFromModelPos(),
    "vHighPrecisionZW = gl_Position.zw;",
    "}",
  ].join("\n");

  const fragmentShader = [
    FX_FRAGMENT_MODEL_MATRIX,
    FX_CORE_PARTICLE_DEFINES,
    "varying vec2 p_uv;",
    "uniform float u_time;",
    "uniform float u_deltaTime;",
    "uniform vec3 objectVelocity;",
    "uniform vec3 objectAngularVelocity;",
    "varying float p_cameraDistance;",
    frame.varyings,
    "varying vec2 vHighPrecisionZW;",
    fragmentVaryingDeclarations,
    graphVaryings(render),
    render.fragment.uniformDeclarations.join("\n"),
    externalSamplingFunctions(slots.external),
    cameraDepthStub(render),
    render.fragment.helperFunctions.join("\n"),
    "#include <common>",
    "#include <packing>",
    "#include <alphahash_pars_fragment>",
    frame.fragmentPars,
    lightingStubs(render),
    "void main() {",
    frame.fragment,
    render.fragment.body.join("\n"),
    `vec4 diffuseColor = ${albedo};`,
    alphaDiscardLines(renderMode, alphaThreshold),
    ...DEPTH_FRAGMENT_TAIL,
    "}",
  ].join("\n");

  // A pure depth target: blending/transparency are meaningless, so force the depth flags regardless
  // of the color material's render mode (never `materialFlags`). DoubleSide so a two-sided billboard
  // or open mesh casts from both faces.
  const uniforms: Record<string, IUniform> = {};
  bindUniforms(uniforms, slots);

  const material = new ShaderMaterial({
    name: "FXArtifactDepthMaterial",
    uniforms,
    vertexShader,
    fragmentShader,
    depthTest: true,
    depthWrite: true,
    side: DoubleSide,
  });

  material.customProgramCacheKey = (): string => `fx-depth_${cacheKey}`;

  return material;
}

// Mesh twin of buildArtifactDepthMaterial (the mesh-path depth builder): mirrors buildMeshUnlit/
// LitArtifactMaterial's scope with the particle plumbing removed, swapping the color tail for the
// depth pack. The same lighting stubs. No `varyings` - a VFX mesh has no instanced attributes.
export function buildMeshArtifactDepthMaterial(
  render: FXRenderArtifact,
  slots: FXMaterialSlots,
): ShaderMaterial {
  const options: RenderMaterialOptions = render.options ?? {};
  const renderMode = options.renderMode ?? "blending";
  const alphaThreshold = outputOrDefault(render.outputs, "alphaThreshold", "0.0075");

  if (!("albedo" in render.outputs)) {
    throw new Error("buildMeshArtifactDepthMaterial: render artifact has no 'albedo' output");
  }
  const albedo = render.outputs["albedo"];
  const cacheKey = fxRenderArtifactCacheKey(render, slots.external);
  const frame = surfaceFrame(render.fragment.surfaceReads, false);

  const vertexShader = [
    "varying vec2 p_uv;",
    "uniform float u_time;",
    "uniform float u_deltaTime;",
    "uniform vec3 objectVelocity;",
    "uniform vec3 objectAngularVelocity;",
    frame.varyings,
    "varying vec2 vHighPrecisionZW;",
    graphVaryings(render),
    render.vertex.uniformDeclarations.join("\n"),
    render.vertex.helperFunctions.join("\n"),
    "#include <common>",
    frame.vertexPars,
    "void main() {",
    "p_uv = uv;",
    render.vertex.body.join("\n"),
    meshTransformPreamble(render.outputs, frame.normalTransform),
    frame.vertex,
    meshProjectFromModelPos(),
    "vHighPrecisionZW = gl_Position.zw;",
    "}",
  ].join("\n");

  const fragmentShader = [
    FX_FRAGMENT_MODEL_MATRIX,
    "varying vec2 p_uv;",
    "uniform float u_time;",
    "uniform float u_deltaTime;",
    "uniform vec3 objectVelocity;",
    "uniform vec3 objectAngularVelocity;",
    frame.varyings,
    "varying vec2 vHighPrecisionZW;",
    graphVaryings(render),
    render.fragment.uniformDeclarations.join("\n"),
    externalSamplingFunctions(slots.external),
    cameraDepthStub(render),
    render.fragment.helperFunctions.join("\n"),
    "#include <common>",
    "#include <packing>",
    "#include <alphahash_pars_fragment>",
    frame.fragmentPars,
    lightingStubs(render),
    "void main() {",
    frame.fragment,
    render.fragment.body.join("\n"),
    `vec4 diffuseColor = ${albedo};`,
    alphaDiscardLines(renderMode, alphaThreshold),
    ...DEPTH_FRAGMENT_TAIL,
    "}",
  ].join("\n");

  const uniforms: Record<string, IUniform> = {};
  bindUniforms(uniforms, slots);

  const material = new ShaderMaterial({
    name: "FXMeshArtifactDepthMaterial",
    uniforms,
    vertexShader,
    fragmentShader,
    depthTest: true,
    depthWrite: true,
    side: DoubleSide,
  });

  material.customProgramCacheKey = (): string => `fx-mesh-depth_${cacheKey}`;

  return material;
}

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

/**
 * The names the trail shader reads one recorded field by at a segment's start (A) and end (B) -
 * vertex-shader globals the prologue fills from the packed views (see {@link FXTrailLayout.packed}),
 * which are themselves named by this applied to the view's name (`a_tA_pack0`). The CPU point and
 * joint vec4s are real attributes under these names.
 */
export function trailAttributeNames(name: string): { readonly a: string; readonly b: string } {
  return { a: `a_tA_${name}`, b: `a_tB_${name}` };
}

/** The same for a `"gpu"` history's point before a segment's start (position and lifecycle). */
export function trailPreviousAttributeName(name: string): string {
  return `a_tC_${name}`;
}

/** A `"gpu"` history's per-instance attribute: the frame a segment starts at. */
export const FX_TRAIL_FRAME_ATTRIBUTE = "a_trailFrame";

/** A `"cpu"` history's packed point: `vec4(position, id + 1)`, `0` when dead. */
export const FX_TRAIL_CPU_POINT = "trailPoint";
/** A `"cpu"` history's packed joint: `vec4(tangent, time recorded)`. */
export const FX_TRAIL_CPU_TANGENT = "trailTangent";

/**
 * What a trail material reads from its history: the layout (see `FXTrailHistory.kind`), the
 * particle fields it records and how they are packed into attributes, and the fields the trail
 * reads that it does not hold - read as zero, the value the particle path gives an attribute
 * nothing simulates. Built only by `trailHistoryLayout`, which both drivers and the trail budget go
 * through; the history mounts exactly these views and the material declares exactly these.
 */
export interface FXTrailLayout {
  readonly kind: "cpu" | "gpu";
  readonly recorded: Readonly<Record<string, GLTypeInfo>>;
  readonly missing: Readonly<Record<string, GLTypeInfo>>;
  /**
   * The recorded fields as packed views of one point, each mounted twice - at the segment's start
   * and end, named by {@link trailAttributeNames} of the view's name. Offsets are in floats into a
   * point: on `"cpu"` the history's own point (after its packed point and joint), on `"gpu"` the
   * kernel's slot, which the history copies whole.
   */
  readonly packed: readonly FXPackedAttribute[];
  /** `"gpu"` only (empty on `"cpu"`): views of the position and lifecycle at the point before a
   *  segment's start, named by {@link trailPreviousAttributeName}. */
  readonly previous: readonly FXPackedAttribute[];
  /** Floats per point: the `"cpu"` history's stride, or the kernel's slot stride on `"gpu"`. */
  readonly stride: number;
}

/**
 * The segment's two points and how they join, per history layout. Both define `fxTrailPosA` /
 * `fxTrailPosB`, `fxTrailLinked` (both points alive, one particle, and a real segment of its
 * path), `fxTrailTangent` (the joint direction at this vertex's end, zero when there is none) and
 * the vertex's `p_trailAge`.
 *
 * The joint tangent at a point is the direction the path arrived there from - one value for both
 * segments meeting at the point, so their shared vertices coincide and the ribbon has no seams.
 */
function trailPrologue(kind: "cpu" | "gpu"): string[] {
  if (kind === "cpu") {
    const point = trailAttributeNames(FX_TRAIL_CPU_POINT);
    const tangent = trailAttributeNames(FX_TRAIL_CPU_TANGENT);
    return [
      `vec3 fxTrailPosA = ${point.a}.xyz;`,
      `vec3 fxTrailPosB = ${point.b}.xyz;`,
      // The end must be newer than the start (from the head frame on lies the oldest one), and
      // the start no older than the tail (frame 0 still holds last lap's point while the head is
      // there - see FXTrailUniforms.tail).
      "bool fxTrailLinked =",
      `  ${point.a}.w > 0.5 && abs(${point.a}.w - ${point.b}.w) < 0.5 &&`,
      `  ${tangent.b}.w > ${tangent.a}.w && ${tangent.a}.w >= u_trailTail;`,
      `vec3 fxTrailTangent = fxTrailT < 0.5 ? ${tangent.a}.xyz : ${tangent.b}.xyz;`,
      `p_trailAge = u_trailNow - mix(${tangent.a}.w, ${tangent.b}.w, fxTrailT);`,
    ];
  }
  const position = trailAttributeNames(FX_CORE_POSITION);
  const lifecycle = trailAttributeNames(FX_CORE_LIFECYCLE);
  const previousPosition = trailPreviousAttributeName(FX_CORE_POSITION);
  const previousLifecycle = trailPreviousAttributeName(FX_CORE_LIFECYCLE);
  const frame = FX_TRAIL_FRAME_ATTRIBUTE;
  return [
    `vec3 fxTrailPosA = ${position.a};`,
    `vec3 fxTrailPosB = ${position.b};`,
    "bool fxTrailLinked =",
    `  abs(${frame} - u_trailHead) > 0.5 &&`,
    `  abs(${lifecycle.a}.z - ${lifecycle.b}.z) < 0.5 &&`,
    `  ${lifecycle.a}.x < ${lifecycle.a}.y && ${lifecycle.b}.x < ${lifecycle.b}.y;`,
    // The point before the start is this particle's previous point when the segment ending at the
    // start is itself linked - the same test, one frame earlier.
    `float fxTrailPrevious = mod(${frame} + u_trailFrames - 1.0, u_trailFrames);`,
    "bool fxTrailHasPrevious =",
    "  abs(fxTrailPrevious - u_trailHead) > 0.5 &&",
    `  abs(${previousLifecycle}.z - ${lifecycle.a}.z) < 0.5 &&`,
    `  ${previousLifecycle}.x < ${previousLifecycle}.y;`,
    "vec3 fxTrailTangent = fxTrailPosB - fxTrailPosA;",
    `if (fxTrailT < 0.5) { fxTrailTangent = fxTrailHasPrevious ? fxTrailPosA - ${previousPosition} : vec3(0.0); }`,
    `float fxTrailNext = mod(${frame} + 1.0, u_trailFrames);`,
    `p_trailAge = mix(fxTrailAgeOf(${frame}), fxTrailAgeOf(fxTrailNext), fxTrailT);`,
  ];
}

/**
 * The attribute declarations a history layout's prologue reads, and the statements that split its
 * packed views back into the A / B / previous globals of every field ({@link trailAttributeNames}),
 * which the prologue and the property assignments read - unchanged by packing.
 */
function trailLayoutAttributes(layout: FXTrailLayout): {
  readonly declarations: string[];
  readonly unpack: string[];
} {
  const declarations: string[] = [];
  const unpack: string[] = [];
  if (layout.kind === "cpu") {
    for (const name of [FX_TRAIL_CPU_POINT, FX_TRAIL_CPU_TANGENT]) {
      const { a, b } = trailAttributeNames(name);
      declarations.push(`attribute vec4 ${a};`, `attribute vec4 ${b};`);
    }
  } else {
    declarations.push(`attribute float ${FX_TRAIL_FRAME_ATTRIBUTE};`);
  }
  const ends = [
    { views: layout.packed, named: (name: string): string => trailAttributeNames(name).a },
    { views: layout.packed, named: (name: string): string => trailAttributeNames(name).b },
    { views: layout.previous, named: trailPreviousAttributeName },
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
function declareTrailProperties(
  render: FXRenderArtifact,
  layout: FXTrailLayout,
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
  const fragmentReads = fragmentReadProperties(render);
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
      assignments.push(`p_${name} = mix(fxTrailPosA, fxTrailPosB, fxTrailT);`);
    } else if (name in layout.recorded) {
      const { a, b } = trailAttributeNames(name);
      assignments.push(`p_${name} = mix(${a}, ${b}, fxTrailT);`);
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

/**
 * Builds a trail artifact's material: a camera-facing ribbon through every particle's recorded
 * path. Each instance is the segment from history frame `f` to the next one, for one particle slot;
 * the base quad's `position.x` runs along it (0 -> 1) and `position.y` across it (-1 -> 1). Unlit
 * and without a surface frame: a ribbon has no authored normal (the editor keeps the nodes that
 * read one out of a trail graph).
 *
 * A segment whose points are not linked (see {@link trailPrologue}), or that has no length, is
 * pushed outside the clip volume, as the particle path hides a dead particle.
 */
export function buildTrailArtifactMaterial(
  render: FXRenderArtifact,
  layout: FXTrailLayout,
  slots: FXMaterialSlots,
  trailUniforms: FXTrailUniforms,
): ShaderMaterial {
  const renderMode = render.options?.renderMode ?? "blending";
  if (!("albedo" in render.outputs)) {
    throw new Error("buildTrailArtifactMaterial: render artifact has no 'albedo' output");
  }
  if (isLitArtifact(render)) {
    throw new Error("buildTrailArtifactMaterial: a trail is unlit - its graph calls lighting");
  }
  if (
    layout.kind === "gpu" &&
    (!(FX_CORE_POSITION in layout.recorded) || !(FX_CORE_LIFECYCLE in layout.recorded))
  ) {
    throw new Error("buildTrailArtifactMaterial: a gpu history must record position and lifecycle");
  }
  // A ribbon has no surface normal or tangent of its own (the editor's trail target offers neither).
  const { surfaceReads } = render.fragment;
  if (surfaceReads.normal || surfaceReads.tangent) {
    throw new Error("buildTrailArtifactMaterial: a trail has no surface normal or tangent");
  }
  const frame = surfaceFrame(surfaceReads, false);
  const width = outputOrDefault(render.outputs, "width", "0.1");
  const properties = declareTrailProperties(render, layout);
  const attributes = trailLayoutAttributes(layout);
  const ageVectors = FX_TRAIL_MAX_FRAMES / 4;
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
    properties.vertexDeclarations,
    graphVaryings(render),
    render.vertex.uniformDeclarations.join("\n"),
    render.vertex.helperFunctions.join("\n"),
    "#include <common>",
    "#include <fog_pars_vertex>",
    ...(layout.kind === "gpu" ? [TRAIL_AGE_LOOKUP] : []),
    "void main() {",
    "float fxTrailT = position.x;",
    "float fxTrailSide = position.y;",
    ...attributes.unpack,
    ...trailPrologue(layout.kind),
    properties.assignments,
    // Along the trail from its head (0) to its tail (1), and across it (0 -> 1).
    "p_uv = vec2(clamp(p_trailAge / max(u_trailSpan, 1e-6), 0.0, 1.0), fxTrailSide * 0.5 + 0.5);",
    render.vertex.body.join("\n"),
    `float fxTrailWidth = ${width};`,
    "vec3 fxTrailDirection = fxTrailPosB - fxTrailPosA;",
    // A point with no joint (a particle's first or last point) faces its own segment.
    "if (dot(fxTrailTangent, fxTrailTangent) < 1e-12) { fxTrailTangent = fxTrailDirection; }",
    "vec3 fxTrailAcross = cross(fxTrailTangent, cameraPosition - PARTICLE_POSITION);",
    "float fxTrailAcrossLength = length(fxTrailAcross);",
    "bool fxTrailVisible = fxTrailLinked && dot(fxTrailDirection, fxTrailDirection) > 1e-12 && fxTrailAcrossLength > 1e-10;",
    "fxTrailAcross = fxTrailVisible ? fxTrailAcross / fxTrailAcrossLength : vec3(0.0);",
    "vec3 fxModelPos = PARTICLE_POSITION + fxTrailAcross * (fxTrailSide * 0.5 * fxTrailWidth);",
    frame.vertex,
    "vec4 mvPosition = viewMatrix * vec4(fxModelPos, 1.0);",
    "p_cameraDistance = length(mvPosition.xyz);",
    "gl_Position = projectionMatrix * mvPosition;",
    "if (!fxTrailVisible) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); }",
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
    graphVaryings(render),
    render.fragment.uniformDeclarations.join("\n"),
    externalSamplingFunctions(slots.external),
    cameraDepthFunctions(render),
    render.fragment.helperFunctions.join("\n"),
    "#include <common>",
    "#include <alphahash_pars_fragment>",
    "#include <fog_pars_fragment>",
    "void main() {",
    frame.fragment,
    render.fragment.body.join("\n"),
    ...colorFragmentTail(render, renderMode),
    "}",
  ].join("\n");

  const uniforms: Record<string, IUniform> = { ...UniformsUtils.clone(UniformsLib.fog) };
  bindUniforms(uniforms, slots);
  uniforms["u_trailHead"] = trailUniforms.head;
  uniforms["u_trailFrames"] = trailUniforms.frames;
  uniforms["u_trailSpan"] = trailUniforms.span;
  uniforms["u_trailNow"] = trailUniforms.now;
  uniforms["u_trailTail"] = trailUniforms.tail;
  uniforms["u_trailAges"] = trailUniforms.ages;

  return colorMaterial({
    render,
    name: "FXTrailArtifactMaterial",
    uniforms,
    vertexShader,
    fragmentShader,
    renderMode,
    lit: false,
    cacheKey: `fx-trail-${layout.kind}_${fxRenderArtifactCacheKey(render, slots.external)}`,
  });
}

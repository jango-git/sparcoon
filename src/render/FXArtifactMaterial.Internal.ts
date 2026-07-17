import type { IUniform, Texture } from "three";
import { DoubleSide, NormalBlending, ShaderMaterial, UniformsLib, UniformsUtils } from "three";
import type { FXRenderArtifact, FXValueSlot } from "../artifact/FXArtifact.js";
import { FX_CORE_PARTICLE_DEFINES } from "../coreLayout.js";
import type { GLTypeInfo } from "../instancedParticle/glTypeInfo.js";
import type { FXRenderMode } from "./FXMaterialOptions.js";

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

// Each property becomes an `a_<name>` attribute mirrored into a `p_<name>` varying. Shared by both adapters.
function declareVaryings(varyings: Record<string, GLTypeInfo>): {
  attributeDeclarations: string;
  varyingDeclarations: string;
  vertexAssignments: string;
} {
  const attributeDeclarations: string[] = [];
  const varyingDeclarations: string[] = [];
  const vertexAssignments: string[] = [];
  for (const name in varyings) {
    const { glslTypeName } = varyings[name];
    attributeDeclarations.push(`attribute ${glslTypeName} a_${name};`);
    varyingDeclarations.push(`varying ${glslTypeName} p_${name};`);
    vertexAssignments.push(`p_${name} = a_${name};`);
  }
  return {
    attributeDeclarations: attributeDeclarations.join("\n"),
    varyingDeclarations: varyingDeclarations.join("\n"),
    vertexAssignments: vertexAssignments.join("\n"),
  };
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

// `#include <project_vertex>` replacement: projects `fxModelPos`, records camera distance, feeds alpha-hash.
function projectFromModelPos(): string {
  return [
    "vec4 mvPosition = modelViewMatrix * vec4(fxModelPos, 1.0);",
    "p_cameraDistance = length(mvPosition.xyz);",
    "gl_Position = projectionMatrix * mvPosition;",
    "#ifdef USE_ALPHAHASH",
    "  vPosition = fxModelPos;",
    "#endif",
  ].join("\n");
}

/** Binds the artifact's live uniform slots into the Three shader (shared object -> live scrub). */
function bindUniforms(
  shader: { uniforms: Record<string, IUniform> },
  render: FXRenderArtifact,
  timeUniform: FXFrameTimeUniform,
  deltaUniform: FXFrameTimeUniform,
  externalSlots: Readonly<Record<string, FXValueSlot<Texture>>>,
): void {
  shader.uniforms["u_time"] = timeUniform;
  shader.uniforms["u_deltaTime"] = deltaUniform;
  for (const name in render.uniforms) {
    const uniform = render.uniforms[name];
    if ("external" in uniform) {
      // External texture resolves per emitter: bind the material's durable slot, not the shared module slot.
      shader.uniforms[name] = externalSlots[name];
    } else {
      // Share the artifact's slot object so a scrub of `render.uniforms[name].value` is picked up next frame.
      shader.uniforms[name] = uniform;
    }
  }
}

/** Binds `objectVelocity`/`objectAngularVelocity` into the Three shader. */
function bindObjectMotionUniforms(
  shader: { uniforms: Record<string, IUniform> },
  velocityUniform: FXFrameVec3Uniform,
  angularVelocityUniform: FXFrameVec3Uniform,
): void {
  shader.uniforms["objectVelocity"] = velocityUniform;
  shader.uniforms["objectAngularVelocity"] = angularVelocityUniform;
}

/** Deterministic djb2 hash of the artifact's GLSL - a content-addressed program cache key. */
function hashString(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

// Stable program-cache key from the artifact's GLSL: identical artifacts share one compiled program.
export function fxRenderArtifactCacheKey(render: FXRenderArtifact): string {
  return hashString(
    [
      render.lightingIntrinsics.join(","),
      render.uniformDeclarations.join("|"),
      render.vertex.varyingDeclarations.join("|"),
      render.vertex.helperFunctions.join("|"),
      render.vertex.body.join("|"),
      render.fragment.varyingDeclarations.join("|"),
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

// Builds an unlit artifact as a self-contained ShaderMaterial: fog uniforms/defines come from Three
// (`fog: true`), the tone-mapping + output-colorspace functions from Three's fragment prefix; the rest
// is ours. The fragment tail mirrors MeshBasic (`opaque_fragment` -> tonemapping -> colorspace -> fog
// -> premultiply) by reusing those exact ShaderChunks, so pixels match the former onBeforeCompile splice.
// Deliberately dropped vs MeshBasic: clipping planes, logarithmic depth, dithering (unused by particles).
// The view-space surface normal (`vNormal` -> `geometryNormal`) is set up unconditionally (a small
// constant cost) so the `geometryNormal` builtin - fresnel, rim, normal masks - works with no lighting
// node present; the lit builder does the same.
export function buildUnlitArtifactMaterial(
  render: FXRenderArtifact,
  varyings: Record<string, GLTypeInfo>,
  timeUniform: FXFrameTimeUniform,
  deltaUniform: FXFrameTimeUniform,
  velocityUniform: FXFrameVec3Uniform,
  angularVelocityUniform: FXFrameVec3Uniform,
  externalSlots: Readonly<Record<string, FXValueSlot<Texture>>> = {},
): ShaderMaterial {
  const options: RenderMaterialOptions = render.options ?? {};
  const renderMode = options.renderMode ?? "blending";
  const alphaThreshold = outputOrDefault(render.outputs, "alphaThreshold", "0.0075");

  if (!("albedo" in render.outputs)) {
    throw new Error("buildUnlitArtifactMaterial: render artifact has no 'albedo' output");
  }
  const albedo = render.outputs["albedo"];
  const { attributeDeclarations, varyingDeclarations, vertexAssignments } =
    declareVaryings(varyings);
  const cacheKey = fxRenderArtifactCacheKey(render);

  const vertexShader = [
    FX_CORE_PARTICLE_DEFINES,
    attributeDeclarations,
    "varying vec2 p_uv;",
    "uniform float u_time;",
    "uniform float u_deltaTime;",
    "uniform vec3 objectVelocity;",
    "uniform vec3 objectAngularVelocity;",
    "varying float p_cameraDistance;",
    // World-space surface frame + position (NORMAL_SPACE_PLAN): the canonical author space for
    // normals. Written in the vertex stage, read as the geometryNormal/geometryTangent/worldPosition
    // builtins in the fragment stage.
    "varying vec3 vWorldNormal;",
    "varying vec3 vWorldTangent;",
    "varying vec3 vWorldPos;",
    varyingDeclarations,
    render.vertex.varyingDeclarations.join("\n"),
    render.uniformDeclarations.join("\n"),
    render.vertex.helperFunctions.join("\n"),
    // `common` declares `vPosition` (under USE_ALPHAHASH); `fog_pars_vertex` declares `vFogDepth`;
    // `normal_pars_vertex` declares `vNormal` (the surface normal for the `geometryNormal` builtin).
    "#include <common>",
    "#include <fog_pars_vertex>",
    "#include <normal_pars_vertex>",
    "void main() {",
    "p_uv = uv;",
    vertexAssignments,
    render.vertex.body.join("\n"),
    transformPreamble(render.outputs, true),
    // Our objectNormal (replaces beginnormal_vertex); stock defaultnormal/normal_vertex build vNormal.
    "vec3 objectNormal = fxNormalXform * normal;",
    "#include <defaultnormal_vertex>",
    "#include <normal_vertex>",
    // World-space surface frame + position (NORMAL_SPACE_PLAN): mat3(modelMatrix) is exact for a
    // plane's frame under uniform scale; the tangent is the plane's local +X (the u axis), so billboard
    // roll/orientation is baked in here ONCE for every consumer (normal maps, spherical normal, fresnel).
    "vWorldNormal  = normalize( mat3( modelMatrix ) * objectNormal );",
    "vWorldTangent = normalize( mat3( modelMatrix ) * ( fxNormalXform * vec3( 1.0, 0.0, 0.0 ) ) );",
    "vWorldPos     = ( modelMatrix * vec4( fxModelPos, 1.0 ) ).xyz;",
    projectFromModelPos(),
    "#include <fog_vertex>",
    "}",
  ].join("\n");

  // `opaque_fragment` below forces alpha to 1 when the material is opaque (the hash case,
  // `transparent: false`), exactly as MeshBasic did.
  const fragmentShader = [
    FX_CORE_PARTICLE_DEFINES,
    "varying vec2 p_uv;",
    "uniform float u_time;",
    "uniform float u_deltaTime;",
    "uniform vec3 objectVelocity;",
    "uniform vec3 objectAngularVelocity;",
    "varying float p_cameraDistance;",
    // World-space surface frame + position (NORMAL_SPACE_PLAN): the canonical author space for
    // normals. Written in the vertex stage, read as the geometryNormal/geometryTangent/worldPosition
    // builtins in the fragment stage.
    "varying vec3 vWorldNormal;",
    "varying vec3 vWorldTangent;",
    "varying vec3 vWorldPos;",
    varyingDeclarations,
    render.fragment.varyingDeclarations.join("\n"),
    render.uniformDeclarations.join("\n"),
    render.fragment.helperFunctions.join("\n"),
    "#include <common>",
    "#include <alphahash_pars_fragment>",
    "#include <fog_pars_fragment>",
    // `normal_pars_fragment` declares the interpolated `vNormal` used for `geometryNormal` below.
    "#include <normal_pars_fragment>",
    "void main() {",
    // Front-facing sign for the surface frame below (a back-facing fragment flips the normal).
    "float fxFaceDirection = gl_FrontFacing ? 1.0 : - 1.0;",
    // World-space surface frame + position - the canonical author space (NORMAL_SPACE_PLAN). The
    // lighting intrinsics convert world->view at their own boundary; geometryTangent/worldPosition feed
    // normal maps and camera-correct fresnel. Declared before the node body so any reader resolves.
    "vec3 geometryNormal  = normalize( vWorldNormal ) * fxFaceDirection;",
    "vec3 geometryTangent = normalize( vWorldTangent );",
    "vec3 worldPosition   = vWorldPos;",
    render.fragment.body.join("\n"),
    `vec4 diffuseColor = ${albedo};`,
    alphaDiscardLines(renderMode, alphaThreshold),
    "vec3 outgoingLight = diffuseColor.rgb;",
    "#include <opaque_fragment>",
    "#include <tonemapping_fragment>",
    "#include <colorspace_fragment>",
    "#include <fog_fragment>",
    blendTail(renderMode, render.outputs),
    "}",
  ].join("\n");

  // ShaderMaterial does not auto-merge fog uniforms (unlike the built-in materials), so seed the fog
  // slots here; `bindUniforms` then wires the live clock + artifact slots by reference (live scrub).
  const uniforms: Record<string, IUniform> = { ...UniformsUtils.clone(UniformsLib.fog) };
  bindUniforms({ uniforms }, render, timeUniform, deltaUniform, externalSlots);
  bindObjectMotionUniforms({ uniforms }, velocityUniform, angularVelocityUniform);

  const material = new ShaderMaterial({
    name: "FXUnlitArtifactMaterial",
    uniforms,
    vertexShader,
    fragmentShader,
    fog: true,
    ...materialFlags(renderMode),
    depthTest: true,
    blending: NormalBlending,
    side: DoubleSide,
    forceSinglePass: true,
    premultipliedAlpha: true,
  });

  material.customProgramCacheKey = (): string => `fx-unlit_${cacheKey}`;

  return material;
}

// The lighting-node intrinsics the graph calls by name (`fn.raw(... "fxLambertShade" ...)`) but never
// defines - the frozen `fx_` cross-repo ABI. Each wraps the exact stock Lambert light sequence in a
// function of (color, WORLD-space normal) -> shaded color: the graph authors normals in world space
// (NORMAL_SPACE_PLAN), and each intrinsic converts world->view on its first line before Three's
// view-space light chain runs, so view space stays a private detail behind this ABI. A node emits a
// plain expression that can sit anywhere in the graph (mid-graph mix included). Placed AFTER the pars chunks (which supply the
// `ReflectedLight`/`LambertMaterial` types, the `RE_*` macros, `vViewPosition`, the light uniforms) and
// BEFORE `main`. `#pragma unroll_loop_start` inside a function is expanded by the renderer's shader-wide
// loop-unroll pass, so the per-light loops resolve here too.
const FX_LIGHTING_NODE_INTRINSICS = [
  "vec4 fxLambertShade(vec4 diffuseColor, vec3 worldNormal) {",
  "  vec3 normal = normalize( mat3( viewMatrix ) * worldNormal );",
  "  float specularStrength = 1.0;",
  "  ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );",
  "  #include <lights_lambert_fragment>",
  "  #include <lights_fragment_begin>",
  "  #include <lights_fragment_end>",
  "  return vec4( reflectedLight.directDiffuse + reflectedLight.indirectDiffuse, diffuseColor.a );",
  "}",
  // Indirect-only diffuse (ambient + light probe / SH + hemisphere), no direct-light loop or shadows -
  // the exact indirect block the old ambient builder inlined, wrapped in a function.
  "vec4 fxAmbientShade(vec4 diffuseColor, vec3 worldNormal) {",
  "  vec3 normal = normalize( mat3( viewMatrix ) * worldNormal );",
  "  float specularStrength = 1.0;",
  "  ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );",
  "  #include <lights_lambert_fragment>",
  "  vec3 irradiance = getAmbientLightIrradiance( ambientLightColor );",
  "  #if defined( USE_LIGHT_PROBES )",
  "    irradiance += getLightProbeIrradiance( lightProbe, normal );",
  "  #endif",
  "  #if ( NUM_HEMI_LIGHTS > 0 )",
  "    #pragma unroll_loop_start",
  "    for ( int i = 0; i < NUM_HEMI_LIGHTS; i ++ ) {",
  "      irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], normal );",
  "    }",
  "    #pragma unroll_loop_end",
  "  #endif",
  "  RE_IndirectDiffuse( irradiance, vec3( 0.0 ), normal, vec3( 0.0 ), vec3( 0.0 ), material, reflectedLight );",
  "  return vec4( reflectedLight.indirectDiffuse, diffuseColor.a );",
  "}",
].join("\n");

// The lit material variant ({@link buildArtifactMaterial} picks it when the capability is non-empty):
// the graph's `albedo` already carries the shaded color (a lighting node emitted `fxLambertShade(...)` /
// `fxAmbientShade(...)`), so `main` uses the flat unlit tail (`outgoingLight = diffuseColor.rgb`) - no
// stock light chain runs in `main`. The material supplies Three's full Lambert light infrastructure
// (light + fog uniforms, pars chunks, view-space `vNormal`/`vViewPosition` + per-particle shadow
// plumbing) so the intrinsics resolve. The `geometryNormal` builtin (the surface normal every fragment
// node may read, and a lighting node's default `normal` argument) is computed at the top of `main`. Shading
// normal/emission are node inputs, not surface slots.
function buildLitArtifactMaterial(
  render: FXRenderArtifact,
  varyings: Record<string, GLTypeInfo>,
  timeUniform: FXFrameTimeUniform,
  deltaUniform: FXFrameTimeUniform,
  velocityUniform: FXFrameVec3Uniform,
  angularVelocityUniform: FXFrameVec3Uniform,
  externalSlots: Readonly<Record<string, FXValueSlot<Texture>>> = {},
): ShaderMaterial {
  const options: RenderMaterialOptions = render.options ?? {};
  const renderMode = options.renderMode ?? "blending";
  const alphaThreshold = outputOrDefault(render.outputs, "alphaThreshold", "0.0075");

  if (!("albedo" in render.outputs)) {
    throw new Error("buildLitArtifactMaterial: render artifact has no 'albedo' output");
  }
  const albedo = render.outputs["albedo"];
  const { attributeDeclarations, varyingDeclarations, vertexAssignments } =
    declareVaryings(varyings);
  const cacheKey = fxRenderArtifactCacheKey(render);

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
    // World-space surface frame + position (NORMAL_SPACE_PLAN): the canonical author space for
    // normals. Written in the vertex stage, read as the geometryNormal/geometryTangent/worldPosition
    // builtins in the fragment stage.
    "varying vec3 vWorldNormal;",
    "varying vec3 vWorldTangent;",
    "varying vec3 vWorldPos;",
    "varying vec3 vViewPosition;",
    varyingDeclarations,
    render.vertex.varyingDeclarations.join("\n"),
    render.uniformDeclarations.join("\n"),
    render.vertex.helperFunctions.join("\n"),
    "#include <common>",
    "#include <fog_pars_vertex>",
    "#include <normal_pars_vertex>",
    "#include <shadowmap_pars_vertex>",
    "void main() {",
    "p_uv = uv;",
    vertexAssignments,
    render.vertex.body.join("\n"),
    transformPreamble(render.outputs, true),
    "vec3 objectNormal = fxNormalXform * normal;",
    "#include <defaultnormal_vertex>",
    "#include <normal_vertex>",
    // World-space surface frame + position (NORMAL_SPACE_PLAN): mat3(modelMatrix) is exact for a
    // plane's frame under uniform scale; the tangent is the plane's local +X (the u axis), so billboard
    // roll/orientation is baked in here ONCE for every consumer (normal maps, spherical normal, fresnel).
    "vWorldNormal  = normalize( mat3( modelMatrix ) * objectNormal );",
    "vWorldTangent = normalize( mat3( modelMatrix ) * ( fxNormalXform * vec3( 1.0, 0.0, 0.0 ) ) );",
    "vWorldPos     = ( modelMatrix * vec4( fxModelPos, 1.0 ) ).xyz;",
    "vec3 transformed = position;",
    projectFromModelPos(),
    "vViewPosition = - mvPosition.xyz;",
    "#if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined( USE_SHADOWMAP ) || defined( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0",
    "  vec4 worldPosition = modelMatrix * vec4(particleCenter, 1.0);",
    "#endif",
    "#include <shadowmap_vertex>",
    "#include <fog_vertex>",
    "}",
  ].join("\n");

  const fragmentShader = [
    "#define LAMBERT",
    FX_CORE_PARTICLE_DEFINES,
    "varying vec2 p_uv;",
    "uniform float u_time;",
    "uniform float u_deltaTime;",
    "uniform vec3 objectVelocity;",
    "uniform vec3 objectAngularVelocity;",
    "varying float p_cameraDistance;",
    // World-space surface frame + position (NORMAL_SPACE_PLAN): the canonical author space for
    // normals. Written in the vertex stage, read as the geometryNormal/geometryTangent/worldPosition
    // builtins in the fragment stage.
    "varying vec3 vWorldNormal;",
    "varying vec3 vWorldTangent;",
    "varying vec3 vWorldPos;",
    varyingDeclarations,
    render.fragment.varyingDeclarations.join("\n"),
    render.uniformDeclarations.join("\n"),
    render.fragment.helperFunctions.join("\n"),
    "#include <common>",
    "#include <packing>",
    "#include <alphahash_pars_fragment>",
    "#include <fog_pars_fragment>",
    "#include <bsdfs>",
    "#include <lights_pars_begin>",
    "#include <normal_pars_fragment>",
    "#include <lights_lambert_pars_fragment>",
    "#include <shadowmap_pars_fragment>",
    FX_LIGHTING_NODE_INTRINSICS,
    "void main() {",
    // Front-facing sign (matching `normal_fragment_begin` under DOUBLE_SIDED): a back-facing fragment
    // flips the surface frame below.
    "float fxFaceDirection = gl_FrontFacing ? 1.0 : - 1.0;",
    // World-space surface frame + position - the canonical author space (NORMAL_SPACE_PLAN). The
    // lighting intrinsics convert world->view at their own boundary; geometryTangent/worldPosition feed
    // normal maps and camera-correct fresnel. Declared before the node body so any reader resolves.
    "vec3 geometryNormal  = normalize( vWorldNormal ) * fxFaceDirection;",
    "vec3 geometryTangent = normalize( vWorldTangent );",
    "vec3 worldPosition   = vWorldPos;",
    render.fragment.body.join("\n"),
    `vec4 diffuseColor = ${albedo};`,
    alphaDiscardLines(renderMode, alphaThreshold),
    "vec3 outgoingLight = diffuseColor.rgb;",
    "#include <opaque_fragment>",
    "#include <tonemapping_fragment>",
    "#include <colorspace_fragment>",
    "#include <fog_fragment>",
    blendTail(renderMode, render.outputs),
    "}",
  ].join("\n");

  const uniforms: Record<string, IUniform> = UniformsUtils.merge([
    UniformsLib.lights,
    UniformsLib.fog,
  ]);
  bindUniforms({ uniforms }, render, timeUniform, deltaUniform, externalSlots);
  bindObjectMotionUniforms({ uniforms }, velocityUniform, angularVelocityUniform);

  const material = new ShaderMaterial({
    name: "FXLightingNodesArtifactMaterial",
    uniforms,
    vertexShader,
    fragmentShader,
    lights: true,
    fog: true,
    ...materialFlags(renderMode),
    depthTest: true,
    blending: NormalBlending,
    side: DoubleSide,
    forceSinglePass: true,
    premultipliedAlpha: true,
  });

  material.customProgramCacheKey = (): string => `fx-lit-nodes_${cacheKey}`;

  return material;
}

// Single entry point the material driver calls: the render artifact's lighting capability
// ({@link FXRenderArtifact.lightingIntrinsics}) picks the variant. Empty => unlit (flat albedo, no
// light infrastructure); non-empty => the lit variant, which defines the intrinsics and lights up
// Three's infrastructure. There is no per-model dispatch - the shading lives in the graph.
export function buildArtifactMaterial(
  render: FXRenderArtifact,
  varyings: Record<string, GLTypeInfo>,
  timeUniform: FXFrameTimeUniform,
  deltaUniform: FXFrameTimeUniform,
  velocityUniform: FXFrameVec3Uniform,
  angularVelocityUniform: FXFrameVec3Uniform,
  externalSlots: Readonly<Record<string, FXValueSlot<Texture>>> = {},
): ShaderMaterial {
  const build =
    render.lightingIntrinsics.length > 0 ? buildLitArtifactMaterial : buildUnlitArtifactMaterial;
  return build(
    render,
    varyings,
    timeUniform,
    deltaUniform,
    velocityUniform,
    angularVelocityUniform,
    externalSlots,
  );
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

// Mesh `#include <project_vertex>` replacement: plain object-space projection. No `p_cameraDistance`
// (a mesh has no per-particle camera-distance builtin); still feeds alpha-hash `vPosition`.
function meshProjectFromModelPos(): string {
  return [
    "vec4 mvPosition = modelViewMatrix * vec4(fxModelPos, 1.0);",
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
  timeUniform: FXFrameTimeUniform,
  deltaUniform: FXFrameTimeUniform,
  velocityUniform: FXFrameVec3Uniform,
  angularVelocityUniform: FXFrameVec3Uniform,
  externalSlots: Readonly<Record<string, FXValueSlot<Texture>>> = {},
): ShaderMaterial {
  const options: RenderMaterialOptions = render.options ?? {};
  const renderMode = options.renderMode ?? "blending";
  const alphaThreshold = outputOrDefault(render.outputs, "alphaThreshold", "0.0075");

  if (!("albedo" in render.outputs)) {
    throw new Error("buildMeshUnlitArtifactMaterial: render artifact has no 'albedo' output");
  }
  const albedo = render.outputs["albedo"];
  const cacheKey = fxRenderArtifactCacheKey(render);

  const vertexShader = [
    "varying vec2 p_uv;",
    "uniform float u_time;",
    "uniform float u_deltaTime;",
    "uniform vec3 objectVelocity;",
    "uniform vec3 objectAngularVelocity;",
    "varying vec3 vWorldNormal;",
    "varying vec3 vWorldTangent;",
    "varying vec3 vWorldPos;",
    render.vertex.varyingDeclarations.join("\n"),
    render.uniformDeclarations.join("\n"),
    render.vertex.helperFunctions.join("\n"),
    "#include <common>",
    "#include <fog_pars_vertex>",
    "#include <normal_pars_vertex>",
    "void main() {",
    "p_uv = uv;",
    render.vertex.body.join("\n"),
    meshTransformPreamble(render.outputs, true),
    "vec3 objectNormal = fxNormalXform * normal;",
    "#include <defaultnormal_vertex>",
    "#include <normal_vertex>",
    "vWorldNormal  = normalize( mat3( modelMatrix ) * objectNormal );",
    "vWorldTangent = normalize( mat3( modelMatrix ) * ( fxNormalXform * vec3( 1.0, 0.0, 0.0 ) ) );",
    "vWorldPos     = ( modelMatrix * vec4( fxModelPos, 1.0 ) ).xyz;",
    meshProjectFromModelPos(),
    "#include <fog_vertex>",
    "}",
  ].join("\n");

  const fragmentShader = [
    "varying vec2 p_uv;",
    "uniform float u_time;",
    "uniform float u_deltaTime;",
    "uniform vec3 objectVelocity;",
    "uniform vec3 objectAngularVelocity;",
    "varying vec3 vWorldNormal;",
    "varying vec3 vWorldTangent;",
    "varying vec3 vWorldPos;",
    render.fragment.varyingDeclarations.join("\n"),
    render.uniformDeclarations.join("\n"),
    render.fragment.helperFunctions.join("\n"),
    "#include <common>",
    "#include <alphahash_pars_fragment>",
    "#include <fog_pars_fragment>",
    "#include <normal_pars_fragment>",
    "void main() {",
    "float fxFaceDirection = gl_FrontFacing ? 1.0 : - 1.0;",
    "vec3 geometryNormal  = normalize( vWorldNormal ) * fxFaceDirection;",
    "vec3 geometryTangent = normalize( vWorldTangent );",
    "vec3 worldPosition   = vWorldPos;",
    render.fragment.body.join("\n"),
    `vec4 diffuseColor = ${albedo};`,
    alphaDiscardLines(renderMode, alphaThreshold),
    "vec3 outgoingLight = diffuseColor.rgb;",
    "#include <opaque_fragment>",
    "#include <tonemapping_fragment>",
    "#include <colorspace_fragment>",
    "#include <fog_fragment>",
    blendTail(renderMode, render.outputs),
    "}",
  ].join("\n");

  const uniforms: Record<string, IUniform> = { ...UniformsUtils.clone(UniformsLib.fog) };
  bindUniforms({ uniforms }, render, timeUniform, deltaUniform, externalSlots);
  bindObjectMotionUniforms({ uniforms }, velocityUniform, angularVelocityUniform);

  const material = new ShaderMaterial({
    name: "FXMeshUnlitArtifactMaterial",
    uniforms,
    vertexShader,
    fragmentShader,
    fog: true,
    ...materialFlags(renderMode),
    depthTest: true,
    blending: NormalBlending,
    side: DoubleSide,
    forceSinglePass: true,
    premultipliedAlpha: true,
  });

  material.customProgramCacheKey = (): string => `fx-mesh-unlit_${cacheKey}`;

  return material;
}

// Lit mesh material: the lighting-nodes twin of buildLitArtifactMaterial (Three's Lambert light
// infrastructure + the fx_ shade intrinsics) with the particle plumbing removed. The graph's `albedo`
// already carries the shaded color, so `main` uses the flat tail.
function buildMeshLitArtifactMaterial(
  render: FXRenderArtifact,
  timeUniform: FXFrameTimeUniform,
  deltaUniform: FXFrameTimeUniform,
  velocityUniform: FXFrameVec3Uniform,
  angularVelocityUniform: FXFrameVec3Uniform,
  externalSlots: Readonly<Record<string, FXValueSlot<Texture>>> = {},
): ShaderMaterial {
  const options: RenderMaterialOptions = render.options ?? {};
  const renderMode = options.renderMode ?? "blending";
  const alphaThreshold = outputOrDefault(render.outputs, "alphaThreshold", "0.0075");

  if (!("albedo" in render.outputs)) {
    throw new Error("buildMeshLitArtifactMaterial: render artifact has no 'albedo' output");
  }
  const albedo = render.outputs["albedo"];
  const cacheKey = fxRenderArtifactCacheKey(render);

  const vertexShader = [
    "#define LAMBERT",
    "varying vec2 p_uv;",
    "uniform float u_time;",
    "uniform float u_deltaTime;",
    "uniform vec3 objectVelocity;",
    "uniform vec3 objectAngularVelocity;",
    "varying vec3 vWorldNormal;",
    "varying vec3 vWorldTangent;",
    "varying vec3 vWorldPos;",
    "varying vec3 vViewPosition;",
    render.vertex.varyingDeclarations.join("\n"),
    render.uniformDeclarations.join("\n"),
    render.vertex.helperFunctions.join("\n"),
    "#include <common>",
    "#include <fog_pars_vertex>",
    "#include <normal_pars_vertex>",
    "#include <shadowmap_pars_vertex>",
    "void main() {",
    "p_uv = uv;",
    render.vertex.body.join("\n"),
    meshTransformPreamble(render.outputs, true),
    "vec3 objectNormal = fxNormalXform * normal;",
    "#include <defaultnormal_vertex>",
    "#include <normal_vertex>",
    "vWorldNormal  = normalize( mat3( modelMatrix ) * objectNormal );",
    "vWorldTangent = normalize( mat3( modelMatrix ) * ( fxNormalXform * vec3( 1.0, 0.0, 0.0 ) ) );",
    "vWorldPos     = ( modelMatrix * vec4( fxModelPos, 1.0 ) ).xyz;",
    "vec3 transformed = position;",
    meshProjectFromModelPos(),
    "vViewPosition = - mvPosition.xyz;",
    "#if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined( USE_SHADOWMAP ) || defined( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0",
    "  vec4 worldPosition = modelMatrix * vec4(fxModelPos, 1.0);",
    "#endif",
    "#include <shadowmap_vertex>",
    "#include <fog_vertex>",
    "}",
  ].join("\n");

  const fragmentShader = [
    "#define LAMBERT",
    "varying vec2 p_uv;",
    "uniform float u_time;",
    "uniform float u_deltaTime;",
    "uniform vec3 objectVelocity;",
    "uniform vec3 objectAngularVelocity;",
    "varying vec3 vWorldNormal;",
    "varying vec3 vWorldTangent;",
    "varying vec3 vWorldPos;",
    render.fragment.varyingDeclarations.join("\n"),
    render.uniformDeclarations.join("\n"),
    render.fragment.helperFunctions.join("\n"),
    "#include <common>",
    "#include <packing>",
    "#include <alphahash_pars_fragment>",
    "#include <fog_pars_fragment>",
    "#include <bsdfs>",
    "#include <lights_pars_begin>",
    "#include <normal_pars_fragment>",
    "#include <lights_lambert_pars_fragment>",
    "#include <shadowmap_pars_fragment>",
    FX_LIGHTING_NODE_INTRINSICS,
    "void main() {",
    "float fxFaceDirection = gl_FrontFacing ? 1.0 : - 1.0;",
    "vec3 geometryNormal  = normalize( vWorldNormal ) * fxFaceDirection;",
    "vec3 geometryTangent = normalize( vWorldTangent );",
    "vec3 worldPosition   = vWorldPos;",
    render.fragment.body.join("\n"),
    `vec4 diffuseColor = ${albedo};`,
    alphaDiscardLines(renderMode, alphaThreshold),
    "vec3 outgoingLight = diffuseColor.rgb;",
    "#include <opaque_fragment>",
    "#include <tonemapping_fragment>",
    "#include <colorspace_fragment>",
    "#include <fog_fragment>",
    blendTail(renderMode, render.outputs),
    "}",
  ].join("\n");

  const uniforms: Record<string, IUniform> = UniformsUtils.merge([
    UniformsLib.lights,
    UniformsLib.fog,
  ]);
  bindUniforms({ uniforms }, render, timeUniform, deltaUniform, externalSlots);
  bindObjectMotionUniforms({ uniforms }, velocityUniform, angularVelocityUniform);

  const material = new ShaderMaterial({
    name: "FXMeshLightingNodesArtifactMaterial",
    uniforms,
    vertexShader,
    fragmentShader,
    lights: true,
    fog: true,
    ...materialFlags(renderMode),
    depthTest: true,
    blending: NormalBlending,
    side: DoubleSide,
    forceSinglePass: true,
    premultipliedAlpha: true,
  });

  material.customProgramCacheKey = (): string => `fx-mesh-lit-nodes_${cacheKey}`;

  return material;
}

// Mesh entry point (the mesh twin of buildArtifactMaterial): the lighting capability picks flat vs lit.
// No `varyings` argument - a VFX mesh has no per-particle instanced attributes.
export function buildMeshArtifactMaterial(
  render: FXRenderArtifact,
  timeUniform: FXFrameTimeUniform,
  deltaUniform: FXFrameTimeUniform,
  velocityUniform: FXFrameVec3Uniform,
  angularVelocityUniform: FXFrameVec3Uniform,
  externalSlots: Readonly<Record<string, FXValueSlot<Texture>>> = {},
): ShaderMaterial {
  const build =
    render.lightingIntrinsics.length > 0
      ? buildMeshLitArtifactMaterial
      : buildMeshUnlitArtifactMaterial;
  return build(
    render,
    timeUniform,
    deltaUniform,
    velocityUniform,
    angularVelocityUniform,
    externalSlots,
  );
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
// IR) and only swaps the color tail for the RGBA depth pack. The lit branch keeps Three's full Lambert
// light infrastructure so the fx_ shade intrinsics the graph calls in `albedo` still compile - only
// the discarded RGB depends on shading, and fxLambertShade returns the input alpha unchanged, so the
// depth cutout stays correct. Fog/logdepth/clipping-planes are dropped, same as the 4 color builders.
export function buildArtifactDepthMaterial(
  render: FXRenderArtifact,
  varyings: Record<string, GLTypeInfo>,
  timeUniform: FXFrameTimeUniform,
  deltaUniform: FXFrameTimeUniform,
  velocityUniform: FXFrameVec3Uniform,
  angularVelocityUniform: FXFrameVec3Uniform,
  externalSlots: Readonly<Record<string, FXValueSlot<Texture>>> = {},
): ShaderMaterial {
  const options: RenderMaterialOptions = render.options ?? {};
  const renderMode = options.renderMode ?? "blending";
  const alphaThreshold = outputOrDefault(render.outputs, "alphaThreshold", "0.0075");

  if (!("albedo" in render.outputs)) {
    throw new Error("buildArtifactDepthMaterial: render artifact has no 'albedo' output");
  }
  const albedo = render.outputs["albedo"];
  const lit = render.lightingIntrinsics.length > 0;
  const { attributeDeclarations, varyingDeclarations, vertexAssignments } =
    declareVaryings(varyings);
  const cacheKey = fxRenderArtifactCacheKey(render);

  const vertexShader = [
    ...(lit ? ["#define LAMBERT"] : []),
    FX_CORE_PARTICLE_DEFINES,
    attributeDeclarations,
    "varying vec2 p_uv;",
    "uniform float u_time;",
    "uniform float u_deltaTime;",
    "uniform vec3 objectVelocity;",
    "uniform vec3 objectAngularVelocity;",
    "varying float p_cameraDistance;",
    "varying vec3 vWorldNormal;",
    "varying vec3 vWorldTangent;",
    "varying vec3 vWorldPos;",
    ...(lit ? ["varying vec3 vViewPosition;"] : []),
    // High-precision NDC z/w carried to the fragment for the depth pack (mirrors stock depth.glsl.js).
    "varying vec2 vHighPrecisionZW;",
    varyingDeclarations,
    render.vertex.varyingDeclarations.join("\n"),
    render.uniformDeclarations.join("\n"),
    render.vertex.helperFunctions.join("\n"),
    "#include <common>",
    "#include <normal_pars_vertex>",
    ...(lit ? ["#include <shadowmap_pars_vertex>"] : []),
    "void main() {",
    "p_uv = uv;",
    vertexAssignments,
    render.vertex.body.join("\n"),
    transformPreamble(render.outputs, true),
    "vec3 objectNormal = fxNormalXform * normal;",
    "#include <defaultnormal_vertex>",
    "#include <normal_vertex>",
    "vWorldNormal  = normalize( mat3( modelMatrix ) * objectNormal );",
    "vWorldTangent = normalize( mat3( modelMatrix ) * ( fxNormalXform * vec3( 1.0, 0.0, 0.0 ) ) );",
    "vWorldPos     = ( modelMatrix * vec4( fxModelPos, 1.0 ) ).xyz;",
    ...(lit ? ["vec3 transformed = position;"] : []),
    projectFromModelPos(),
    ...(lit
      ? [
          "vViewPosition = - mvPosition.xyz;",
          "#if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined( USE_SHADOWMAP ) || defined( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0",
          "  vec4 worldPosition = modelMatrix * vec4(particleCenter, 1.0);",
          "#endif",
          "#include <shadowmap_vertex>",
        ]
      : []),
    "vHighPrecisionZW = gl_Position.zw;",
    "}",
  ].join("\n");

  const fragmentShader = [
    ...(lit ? ["#define LAMBERT"] : []),
    FX_CORE_PARTICLE_DEFINES,
    "varying vec2 p_uv;",
    "uniform float u_time;",
    "uniform float u_deltaTime;",
    "uniform vec3 objectVelocity;",
    "uniform vec3 objectAngularVelocity;",
    "varying float p_cameraDistance;",
    "varying vec3 vWorldNormal;",
    "varying vec3 vWorldTangent;",
    "varying vec3 vWorldPos;",
    "varying vec2 vHighPrecisionZW;",
    varyingDeclarations,
    render.fragment.varyingDeclarations.join("\n"),
    render.uniformDeclarations.join("\n"),
    render.fragment.helperFunctions.join("\n"),
    "#include <common>",
    "#include <packing>",
    "#include <alphahash_pars_fragment>",
    // Fragment include ORDER mirrors buildLit/UnlitArtifactMaterial exactly (minus fog): the only hard
    // dependency is lights_lambert_pars_fragment needing bsdfs + lights_pars_begin declared before it.
    ...(lit
      ? [
          "#include <bsdfs>",
          "#include <lights_pars_begin>",
          "#include <normal_pars_fragment>",
          "#include <lights_lambert_pars_fragment>",
          "#include <shadowmap_pars_fragment>",
          FX_LIGHTING_NODE_INTRINSICS,
        ]
      : ["#include <normal_pars_fragment>"]),
    "void main() {",
    "float fxFaceDirection = gl_FrontFacing ? 1.0 : - 1.0;",
    "vec3 geometryNormal  = normalize( vWorldNormal ) * fxFaceDirection;",
    "vec3 geometryTangent = normalize( vWorldTangent );",
    "vec3 worldPosition   = vWorldPos;",
    render.fragment.body.join("\n"),
    `vec4 diffuseColor = ${albedo};`,
    alphaDiscardLines(renderMode, alphaThreshold),
    ...DEPTH_FRAGMENT_TAIL,
    "}",
  ].join("\n");

  // A pure depth target: blending/transparency are meaningless, so force the depth flags regardless
  // of the color material's render mode (never `materialFlags`). DoubleSide so a two-sided billboard
  // or open mesh casts from both faces.
  const uniforms: Record<string, IUniform> = lit ? UniformsUtils.merge([UniformsLib.lights]) : {};
  bindUniforms({ uniforms }, render, timeUniform, deltaUniform, externalSlots);
  bindObjectMotionUniforms({ uniforms }, velocityUniform, angularVelocityUniform);

  const material = new ShaderMaterial({
    name: "FXArtifactDepthMaterial",
    uniforms,
    vertexShader,
    fragmentShader,
    ...(lit ? { lights: true } : {}),
    depthTest: true,
    depthWrite: true,
    side: DoubleSide,
  });

  material.customProgramCacheKey = (): string => `fx-depth_${cacheKey}`;

  return material;
}

// Mesh twin of buildArtifactDepthMaterial (the mesh-path depth builder): mirrors buildMeshUnlit/
// LitArtifactMaterial's scope with the particle plumbing removed, swapping the color tail for the
// depth pack. Same lit/unlit internal branch. No `varyings` - a VFX mesh has no instanced attributes.
export function buildMeshArtifactDepthMaterial(
  render: FXRenderArtifact,
  timeUniform: FXFrameTimeUniform,
  deltaUniform: FXFrameTimeUniform,
  velocityUniform: FXFrameVec3Uniform,
  angularVelocityUniform: FXFrameVec3Uniform,
  externalSlots: Readonly<Record<string, FXValueSlot<Texture>>> = {},
): ShaderMaterial {
  const options: RenderMaterialOptions = render.options ?? {};
  const renderMode = options.renderMode ?? "blending";
  const alphaThreshold = outputOrDefault(render.outputs, "alphaThreshold", "0.0075");

  if (!("albedo" in render.outputs)) {
    throw new Error("buildMeshArtifactDepthMaterial: render artifact has no 'albedo' output");
  }
  const albedo = render.outputs["albedo"];
  const lit = render.lightingIntrinsics.length > 0;
  const cacheKey = fxRenderArtifactCacheKey(render);

  const vertexShader = [
    ...(lit ? ["#define LAMBERT"] : []),
    "varying vec2 p_uv;",
    "uniform float u_time;",
    "uniform float u_deltaTime;",
    "uniform vec3 objectVelocity;",
    "uniform vec3 objectAngularVelocity;",
    "varying vec3 vWorldNormal;",
    "varying vec3 vWorldTangent;",
    "varying vec3 vWorldPos;",
    ...(lit ? ["varying vec3 vViewPosition;"] : []),
    "varying vec2 vHighPrecisionZW;",
    render.vertex.varyingDeclarations.join("\n"),
    render.uniformDeclarations.join("\n"),
    render.vertex.helperFunctions.join("\n"),
    "#include <common>",
    "#include <normal_pars_vertex>",
    ...(lit ? ["#include <shadowmap_pars_vertex>"] : []),
    "void main() {",
    "p_uv = uv;",
    render.vertex.body.join("\n"),
    meshTransformPreamble(render.outputs, true),
    "vec3 objectNormal = fxNormalXform * normal;",
    "#include <defaultnormal_vertex>",
    "#include <normal_vertex>",
    "vWorldNormal  = normalize( mat3( modelMatrix ) * objectNormal );",
    "vWorldTangent = normalize( mat3( modelMatrix ) * ( fxNormalXform * vec3( 1.0, 0.0, 0.0 ) ) );",
    "vWorldPos     = ( modelMatrix * vec4( fxModelPos, 1.0 ) ).xyz;",
    ...(lit ? ["vec3 transformed = position;"] : []),
    meshProjectFromModelPos(),
    ...(lit
      ? [
          "vViewPosition = - mvPosition.xyz;",
          "#if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined( USE_SHADOWMAP ) || defined( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0",
          "  vec4 worldPosition = modelMatrix * vec4(fxModelPos, 1.0);",
          "#endif",
          "#include <shadowmap_vertex>",
        ]
      : []),
    "vHighPrecisionZW = gl_Position.zw;",
    "}",
  ].join("\n");

  const fragmentShader = [
    ...(lit ? ["#define LAMBERT"] : []),
    "varying vec2 p_uv;",
    "uniform float u_time;",
    "uniform float u_deltaTime;",
    "uniform vec3 objectVelocity;",
    "uniform vec3 objectAngularVelocity;",
    "varying vec3 vWorldNormal;",
    "varying vec3 vWorldTangent;",
    "varying vec3 vWorldPos;",
    "varying vec2 vHighPrecisionZW;",
    render.fragment.varyingDeclarations.join("\n"),
    render.uniformDeclarations.join("\n"),
    render.fragment.helperFunctions.join("\n"),
    "#include <common>",
    "#include <packing>",
    "#include <alphahash_pars_fragment>",
    // Fragment include ORDER mirrors buildMeshLit/UnlitArtifactMaterial exactly (minus fog).
    ...(lit
      ? [
          "#include <bsdfs>",
          "#include <lights_pars_begin>",
          "#include <normal_pars_fragment>",
          "#include <lights_lambert_pars_fragment>",
          "#include <shadowmap_pars_fragment>",
          FX_LIGHTING_NODE_INTRINSICS,
        ]
      : ["#include <normal_pars_fragment>"]),
    "void main() {",
    "float fxFaceDirection = gl_FrontFacing ? 1.0 : - 1.0;",
    "vec3 geometryNormal  = normalize( vWorldNormal ) * fxFaceDirection;",
    "vec3 geometryTangent = normalize( vWorldTangent );",
    "vec3 worldPosition   = vWorldPos;",
    render.fragment.body.join("\n"),
    `vec4 diffuseColor = ${albedo};`,
    alphaDiscardLines(renderMode, alphaThreshold),
    ...DEPTH_FRAGMENT_TAIL,
    "}",
  ].join("\n");

  const uniforms: Record<string, IUniform> = lit ? UniformsUtils.merge([UniformsLib.lights]) : {};
  bindUniforms({ uniforms }, render, timeUniform, deltaUniform, externalSlots);
  bindObjectMotionUniforms({ uniforms }, velocityUniform, angularVelocityUniform);

  const material = new ShaderMaterial({
    name: "FXMeshArtifactDepthMaterial",
    uniforms,
    vertexShader,
    fragmentShader,
    ...(lit ? { lights: true } : {}),
    depthTest: true,
    depthWrite: true,
    side: DoubleSide,
  });

  material.customProgramCacheKey = (): string => `fx-mesh-depth_${cacheKey}`;

  return material;
}

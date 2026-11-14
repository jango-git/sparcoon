import type { Texture } from "three";

import type { FXDrawInputs } from "../render/FXDrawInputs.js";
import type { FXUniformValue } from "../render/FXExternalTexture.js";
import type {
  FXGraphLambertMaterialOptions,
  FXGraphUnlitMaterialOptions,
} from "../render/FXMaterialOptions.js";

/**
 * Frozen editor<->runtime boundary. The editor compiles a graph into a plain ESM module that
 * exports an {@link FXRenderArtifact} (GLSL + uniforms + textures) and an {@link FXBehaviorArtifact}
 * (authored spawn/update functions + bindings + buffer layout), plus an optional
 * {@link FXParticleKernelArtifact} (a fused GPU transform-feedback program) when the graph opts into
 * GPU simulation; the runtime only executes them. Runtime-owned and exported; no code generation, no
 * eval (the app's bundler compiles the authored JS functions, the editor precompiles the GLSL).
 * Every value scrub must no-op on an unknown name so a name drift never corrupts values.
 */

/** One state buffer - a field of the particle slot: name + per-particle width in floats. */
export interface FXBufferLayout {
  readonly name: string;
  readonly stride: number;
}

/** A user attribute declaration (width in components). */
export interface FXAttributeDecl {
  readonly name: string;
  readonly components: 1 | 2 | 3 | 4;
}

/**
 * Emitter world transform passed to spawn/update: `matrixWorld` as a column-major mat4 (16 floats),
 * read through the shared `world-matrix` node; `velocity`/`angularVelocity` are the emitter's
 * world-space linear/angular velocity (units and radians per second), read through the
 * `object-velocity`/`object-angular-velocity` nodes. The whole argument is optional - a graph
 * reading none of these never touches it - but each field, once passed, is always fully populated.
 */
export interface FXEmitterTransform {
  readonly worldMatrix: readonly number[];
  readonly velocity: readonly number[];
  readonly angularVelocity: readonly number[];
}

/**
 * What a behavior's newborns can take from the particle whose birth or death spawned them: `stride`
 * floats, handed to its spawn as `inherited` (see {@link FXBehaviorArtifact.spawn}). A birth no
 * reaction spawned - a timeline's, a host's - gets `defaults`, as does any value the source
 * particle's emitter does not hold. Which float is which is the editor's to lay out; the runtime
 * only copies.
 */
export interface FXInheritLayout {
  readonly stride: number;
  /** `stride` floats. */
  readonly defaults: readonly number[];
}

/** What a GPU kernel's draw stage reads of one simulation pass: its timestep and the emitter's
 *  pose and motion in it ({@link FXParticleKernelArtifact.compute}). */
export interface FXKernelDrawInputs extends FXEmitterTransform {
  readonly deltaTime: number;
}

/**
 * A value slot (uniform/binding). An artifact's slots are seed values: every instance built from
 * it takes its own copy, which the runtime and the draw stage then write in place.
 */
export interface FXValueSlot<T> {
  value: T;
}

/**
 * Built-in primitive instanced per particle. The vertex program is geometry-agnostic, so `"plane"`
 * + a camera-facing `particleTransform` is the classic billboard while `"box"`/`"sphere"` are true
 * 3D mesh particles. Absent => `"plane"`.
 */
export type FXGeometryPrimitive = "plane" | "box" | "sphere";

/**
 * The geometry an emitter/mesh instances: a built-in primitive, or an app-supplied `BufferGeometry`
 * bound by name (a custom mesh baked in the editor's content library) - the same external-slot
 * duality as {@link FXUniformInit}'s `sampler2D` case. Absent `FXRenderArtifact.geometry` => `"plane"`.
 */
export type FXGeometrySource =
  | { readonly type: "primitive"; readonly primitive: FXGeometryPrimitive }
  | { readonly type: "custom"; readonly external: string };

/** A uniform's serialized initial value. */
export type FXUniformInit =
  | { readonly type: string; value: number | readonly number[] } // scalar/vector/color
  | { readonly type: "sampler2D"; value: Texture } // generated (fxDataTexture)
  | { readonly type: "sampler2D"; readonly external: string; value?: Texture }; // app-supplied by slot name

/**
 * What one shader stage's code reads of each particle - recorded by the compiler as it emits the
 * code, so the runtime declares a property (an attribute, a varying) for exactly what the stage
 * names and never has to scan the GLSL for it. Empty for a VFX mesh, which has no particles.
 */
export interface FXParticleReads {
  /** The position (`PARTICLE_POSITION`, `PARTICLE_POSITION_X` / `_Y` / `_Z`). */
  readonly position: boolean;
  /** The age, lifetime or id (`PARTICLE_AGE`, `PARTICLE_LIFETIME`, `PARTICLE_ID`). */
  readonly lifecycle: boolean;
  /** The attributes read (`p_fx_<name>`), by {@link FXAttributeDecl.name}; each one is among
   *  the artifact's {@link FXRenderArtifact.attributeReads}. */
  readonly attributes: readonly string[];
}

/**
 * Which builtins of the world-space surface frame the fragment stage's code reads - recorded by the
 * compiler like {@link FXParticleReads}. The material builds the frame for exactly these: each one
 * costs a varying vector, the scarcest thing a material has after its attributes.
 */
export interface FXSurfaceReads {
  /** `geometryNormal`. */
  readonly normal: boolean;
  /** `geometryTangent`. */
  readonly tangent: boolean;
  /** `worldPosition`. */
  readonly position: boolean;
}

/** A value the graph's vertex stage computes and its fragment stage reads. */
export interface FXVaryingDecl {
  readonly name: string;
  /** Its GLSL type (`float` .. `vec4`, `matN`, `int` / `ivecN`). */
  readonly type: string;
  /** `flat` marks a value the same at all of a primitive's vertices (or an integer, which cannot
   *  interpolate): it rides a `flat` varying where the context's GLSL has one (WebGL2), and an
   *  interpolated one otherwise - which gives such a value back unchanged. A property of the
   *  value, not of the tier, so both tiers' artifacts agree on it. */
  readonly interpolation: "smooth" | "flat";
}

/** One shader stage's spliceable source (matches the compiler's per-stage IR shape). */
export interface FXShaderStageSource {
  /** `uniform <type> <name>;` of each graph uniform this stage's code reads, and only those: a
   *  stage declaring a sampler it never reads would still be charged a texture unit for it. */
  readonly uniformDeclarations: readonly string[];
  readonly helperFunctions: readonly string[];
  readonly body: readonly string[];
  /** What this stage's code - its body and helper functions - reads of each particle. */
  readonly particleReads: FXParticleReads;
}

/** The fragment stage's source: the surface frame is fragment-only, so only this stage records it. */
export interface FXFragmentStageSource extends FXShaderStageSource {
  /** What this stage's code - its body, helper functions and fragment-stage outputs - reads of the
   *  surface frame. */
  readonly surfaceReads: FXSurfaceReads;
}

/**
 * One shader program of a render, spliced into one Three material: its two stages, what it carries
 * between them, and the GLSL expression each of its output slots reads (slot -> expression). The
 * programs of one render share its uniforms and its draw stage ({@link FXRenderArtifact.compute}).
 */
export interface FXRenderProgram {
  /** What the program carries from its vertex stage to its fragment stage, declared in both. */
  readonly varyings: readonly FXVaryingDecl[];
  readonly vertex: FXShaderStageSource;
  readonly fragment: FXFragmentStageSource;
  readonly outputs: Readonly<Record<string, string>>;
}

/** Render half of an emitted effect: compiled GLSL spliced into a Three material, plus live uniforms. */
export interface FXRenderArtifact {
  /**
   * Lighting capability: the sorted, deduplicated set of `fx_`-ABI shade intrinsics the graph's
   * lighting nodes call (e.g. `["fxLambertShade"]`), derived from the graph (not authored). Empty =>
   * unlit: the runtime builds the flat material. Non-empty => the runtime lights up Three's light
   * infrastructure and defines exactly these functions, throwing on one it does not define. The
   * shaded color is produced inside the graph (the `albedo` output already carries it), so there is
   * no per-model material dispatch.
   */
  readonly lightingIntrinsics: readonly string[];
  /**
   * Depth capability: whether the graph calls the `fx_`-ABI `fxDepthFade(distance)` - the fade, 0
   * to 1, over `distance` world units in front of the opaque scene - derived from the graph like
   * {@link lightingIntrinsics}. The runtime then defines it from the depth of whichever camera
   * draws (see `fxSetCameraDepth`), and 1 where that camera has none. Only a `blending` graph may
   * read it: a depth-writing one would read its own depth.
   */
  readonly sceneDepth: boolean;
  /** Absent => `"plane"`. */
  readonly geometry?: FXGeometrySource;
  readonly options?: FXGraphUnlitMaterialOptions | FXGraphLambertMaterialOptions;
  /**
   * The program drawing the effect. Its outputs: `albedo` (required; already carries the shaded
   * color when lit), the optional fragment-stage compositing slots (`additivity` /
   * `alphaThreshold`, and `intensity`: a multiplier on the color alone, never its alpha, in linear
   * light), the optional vertex-stage `particleTransform` / `vertexTransform` (mat4), and a
   * trail's `width`.
   */
  readonly color: FXRenderProgram;
  /**
   * The program drawing the effect into a shadow map: only what decides which fragments cast -
   * the albedo's alpha and the cutoffs - and where they are. Its outputs: `alpha` (required), the
   * optional `alphaThreshold` / `shadowThreshold` cutoffs and `particleTransform` /
   * `vertexTransform`. Absent for a trail, which casts no shadow.
   */
  readonly shadow?: FXRenderProgram;
  readonly uniforms: Record<string, FXUniformInit>;
  /**
   * The attributes the render declares, with their widths (`p_fx_<name>`); the emitter merges these
   * with the sim's write set. What each stage's code actually reads is its `particleReads`.
   */
  readonly attributeReads: readonly FXAttributeDecl[];
  /**
   * The draw stage: what is one for the whole draw, computed once per tick on the CPU instead of
   * per vertex or fragment on the GPU. Reads the tick's `inputs` and the instance's own uniform
   * values (its parameters among them), and writes the draw uniforms (declared and seeded like
   * any other) into the same `uniforms`. Writes every value in place and allocates nothing: it
   * runs every tick. Authored by the editor - absent when the graph has nothing to lift.
   */
  readonly compute?: (
    inputs: FXDrawInputs,
    uniforms: Readonly<Record<string, FXValueSlot<FXUniformValue>>>,
  ) => void;
}

/**
 * Which GLSL-family compiler tier produced a compiled {@link FXRenderArtifact}: `"baseline"` is
 * the WebGL1/GLSL-ES-1.00-style compiler; `"standard"` is the WebGL2/GLSL-ES-3.00-only compiler
 * (may use int/ivec and other standard-only capabilities a `"baseline"` graph cannot). Both
 * compile to the same GLSL-text artifact shape and splice through the same material builders
 * unchanged - Three already upgrades any material to `#version 300 es` (with full
 * `attribute`/`varying`/`gl_FragColor` backward-compat macros) on an actual WebGL2 context,
 * regardless of tier, so the runtime needs no declaration-style distinction between the two.
 *
 * Deliberately scoped to the GLSL family in its name: a structurally different family (the future
 * advanced tier - a WGSL/WebGPU compiler, whose artifact has no vertex/fragment GLSL text at all)
 * would need its own sibling type and its own field on the emitter/mesh spec, never a third member
 * of this union or a third key in {@link FXRenderArtifactsByGLSLTier}.
 */
export type FXGLSLRenderTier = "baseline" | "standard";

/** One emitter/mesh's render artifact, precompiled once per GLSL tier the editor supports. */
export type FXRenderArtifactsByGLSLTier = Readonly<Record<FXGLSLRenderTier, FXRenderArtifact>>;

/**
 * Behavior half of an emitted effect: authored spawn/update functions mutating the particle slots,
 * plus the slot's layout and live bindings. Math helpers are inlined, so the artifact carries no
 * runtime dependency.
 */
export interface FXBehaviorArtifact {
  /**
   * The particle slot: its fields back to back in this order (`slotLayout`), core `position` and
   * `lifecycle` included - the layout `spawn`/`update` index by literal offsets, and every field the
   * behavior simulates. The runtime never reorders it, so the editor declares it in `packingOrder`,
   * the same order as the emitter's GPU kernel's `buffers`.
   */
  readonly buffers: readonly FXBufferLayout[];
  /** number, or Float32Array (a curve LUT). */
  readonly bindings: Record<string, FXValueSlot<number | Float32Array>>;
  /** What its newborns take from a dying particle; absent when nothing (`stride` 0). The emitter's
   *  GPU kernel, when it has one, reads the same layout. */
  readonly inherit?: FXInheritLayout;

  /** Seeds newborns `[start, start+count)` of `slots` (every slot back to back, see {@link buffers}).
   *  Optional (an update-only, non-particle host). A newborn's `age` is already seeded: born that
   *  long before the end of its tick, it spawns from where the emitter stood then - `worldMatrix`
   *  with its translation moved back along `velocity` by that age. `inherited` is the one
   *  {@link inherit} layout's values every newborn of the call shares. */
  spawn?(
    slots: Float32Array,
    start: number,
    count: number,
    bindings: Record<string, FXValueSlot<number | Float32Array>>,
    emitter: FXEmitterTransform,
    inherited: Float32Array,
  ): void;
  /**
   * Advances every slot `[0, count)` - dead ones too (`age >= lifetime`, including never-born
   * slots with lifetime 0), exactly as the GPU kernel's pass covers every slot. What it computes for
   * a dead slot (even a NaN from `age / lifetime`) is never shown - the render and trail hide dead
   * slots - and is discarded when a birth claims the slot, which zero-fills it before seeding.
   * Skipped altogether on a tick when no particle is alive.
   *
   * Writes `age` only to kill: `age = max(age, lifetime)`. `lifetime` stays birth-only.
   */
  update(
    slots: Float32Array,
    count: number,
    deltaTime: number,
    bindings: Record<string, FXValueSlot<number | Float32Array>>,
    emitter?: FXEmitterTransform,
  ): void;
}

/**
 * Standard-tier (WebGL2, transform-feedback) behavior half of an emitted effect - a sibling of
 * {@link FXBehaviorArtifact}, not a variant of it: a compiled GLSL program has no JS function
 * shape to reuse. One fused GLSL ES 3.00 vertex-shader program handles both spawn and update in a
 * single draw, branching per-invocation on the runtime-supplied spawn range (see
 * `behaviorTransformFeedbackLayout.ts`'s uniform-name contract) - never two separate programs,
 * since transform feedback cannot read and write the same buffer in one pass, and splitting the
 * update range around a wrapping spawn cursor compounds badly with GPU-side buffer offsets.
 *
 * Optional per emitter/mesh spec: present only when the graph's spawn node had "Try GPU
 * simulation" on and the graph actually compiled to GLSL; every emitter always has a matching
 * {@link FXBehaviorArtifact} too (the mandatory JS fallback, including for the WebGL2->WebGL1
 * emergency downgrade), so the runtime is never left with only this artifact and no JS twin.
 */
export interface FXParticleKernelArtifact {
  readonly vertexSource: string;
  readonly fragmentSource: string;
  /** State buffers this program's `in`/`out` pairs cover, in declaration order - a buffer's index
   *  here IS its `layout(location = N)` attribute index in {@link vertexSource}; the runtime binds
   *  by that index, never by looking an attribute up by name. */
  readonly buffers: readonly FXBufferLayout[];
  /** Varying names for `gl.transformFeedbackVaryings`, one per {@link buffers} entry, same order. */
  readonly transformFeedbackVaryings: readonly string[];
  /**
   * The program's own uniforms with their values: its live-tunable parameters, and the draw
   * uniforms {@link compute} fills (declared and seeded, at zero, like any other). The fixed
   * contract uniforms in `behaviorTransformFeedbackLayout.ts` are the runtime's own to set every
   * pass, not part of this map. Each uploads by the type the program declares it as.
   * Float32Array is reserved for a future sampler2D-backed (LUT) uniform; no standard-tier node
   * produces one yet.
   */
  readonly bindings: Record<string, FXValueSlot<FXKernelUniformValue>>;
  /**
   * The draw stage, as {@link FXRenderArtifact.compute} is for a render: computes, once per pass
   * on the CPU, the values one for the whole pass from `inputs` and the emitter's own bindings,
   * into its draw uniforms in the same `uniforms` - instead of once per particle on the GPU.
   * Writes every value in place and allocates nothing: it runs every pass.
   */
  readonly compute?: (
    inputs: FXKernelDrawInputs,
    uniforms: Readonly<Record<string, FXValueSlot<FXKernelUniformValue>>>,
  ) => void;
}

/** A GPU kernel uniform's value: a float, a vector or matrix (column-major), or a LUT. */
export type FXKernelUniformValue = number | number[] | Float32Array;

import type { Texture } from "three";
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

/** One state buffer: name + per-particle stride in floats. */
export interface FXBufferLayout {
  readonly name: string;
  readonly stride: number;
}

/** A user attribute declaration (width in components). */
export interface FXAttributeDecl {
  readonly name: string;
  readonly components: 1 | 2 | 3 | 4;
}

/** Named set of state buffers handed to a kernel (core + attribute buffers). */
export type FXKernelBuffers = Readonly<Record<string, Float32Array>>;

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

/** A live value slot (uniform/binding): the runtime mutates `value` in place. */
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

/** One shader stage's spliceable source (matches the compiler's per-stage IR shape). */
export interface FXShaderStageSource {
  readonly varyingDeclarations: readonly string[];
  readonly helperFunctions: readonly string[];
  readonly body: readonly string[];
}

/** Render half of an emitted effect: compiled GLSL spliced into a Three material, plus live uniforms. */
export interface FXRenderArtifact {
  /**
   * Lighting capability: the sorted, deduplicated set of `fx_`-ABI shade intrinsics the graph's
   * lighting nodes call (e.g. `["fxLambertShade"]`), derived from the graph (not authored). Empty =>
   * unlit: the runtime builds the flat material. Non-empty => the runtime lights up Three's light
   * infrastructure and defines exactly these functions. The shaded color is produced inside the graph
   * (the `albedo` output already carries it), so there is no per-model material dispatch.
   */
  readonly lightingIntrinsics: readonly string[];
  /** Absent => `"plane"`. */
  readonly geometry?: FXGeometrySource;
  readonly options?: FXGraphUnlitMaterialOptions | FXGraphLambertMaterialOptions;
  readonly uniformDeclarations: readonly string[];
  readonly vertex: FXShaderStageSource;
  readonly fragment: FXShaderStageSource;
  /**
   * slot -> GLSL expression: `albedo` (required; already carries the shaded color when lit), the
   * optional fragment-stage compositing slots (`additivity` / `alphaThreshold`), and the optional
   * vertex-stage `particleTransform` / `vertexTransform` (mat4). Shading normal and emission are node
   * inputs now, not surface slots.
   */
  readonly outputs: Readonly<Record<string, string>>;
  readonly uniforms: Record<string, FXUniformInit>;
  /** Attributes the shader reads (`p_fx_<name>`); the emitter merges these with the sim's write set. */
  readonly attributeReads: readonly FXAttributeDecl[];
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
 * Behavior half of an emitted effect: authored spawn/update functions mutating the packed state
 * buffers, plus buffer layout and live bindings. Math helpers are inlined, so the artifact carries
 * no runtime dependency. Attribute offsets are literals derived from {@link buffers}; only the core
 * position/lifecycle offsets are the fixed ABI (`coreLayout.ts`).
 */
export interface FXBehaviorArtifact {
  readonly buffers: readonly FXBufferLayout[];
  readonly attributeWrites: readonly FXAttributeDecl[];
  /** number, or Float32Array (a curve LUT). */
  readonly bindings: Record<string, FXValueSlot<number | Float32Array>>;

  /** Buffers `spawn` writes; the host marks only these `needsUpdate`. */
  readonly spawnWrittenBuffers?: readonly string[];
  /** Buffers `update` writes; the host marks only these `needsUpdate`. */
  readonly updateWrittenBuffers: readonly string[];

  /** Seeds newborns `[start, start+count)`. Optional (an update-only, non-particle host). */
  spawn?(
    buffers: FXKernelBuffers,
    start: number,
    count: number,
    bindings: Record<string, FXValueSlot<number | Float32Array>>,
    emitter?: FXEmitterTransform,
  ): void;
  /** Advances all live particles `[0, count)`. */
  update(
    buffers: FXKernelBuffers,
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
  /** Live-tunable uniform values (graph-authored params only - the fixed contract uniforms in
   *  `behaviorTransformFeedbackLayout.ts` are always declared and are the runtime's own
   *  responsibility to set every tick, not part of this map). Float32Array is reserved for a
   *  future sampler2D-backed (LUT) uniform; no standard-tier node produces one yet. */
  readonly bindings: Record<string, FXValueSlot<number | Float32Array>>;
}

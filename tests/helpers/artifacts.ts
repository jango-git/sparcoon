import type {
  FXAttributeDecl,
  FXBehaviorArtifact,
  FXBufferLayout,
  FXKernelBuffers,
  FXRenderArtifact,
  FXRenderArtifactsByGLSLTier,
} from "../../src/artifact/FXArtifact";
import {
  FX_CORE_LIFECYCLE,
  FX_CORE_LIFECYCLE_STRIDE,
  FX_CORE_POSITION,
  FX_LIFETIME,
} from "../../src/coreLayout";
import type { GLTypeInfo } from "../../src/instancedParticle/glTypeInfo";

/** Fixture `GLTypeInfo` values for the varying types tests wire up (position/lifecycle/attributes). */
export const FLOAT_VARYING: GLTypeInfo = {
  glslTypeName: "float",
  bufferSize: 1,
  instantiable: true,
};
export const VEC2_VARYING: GLTypeInfo = { glslTypeName: "vec2", bufferSize: 2, instantiable: true };
export const VEC3_VARYING: GLTypeInfo = { glslTypeName: "vec3", bufferSize: 3, instantiable: true };

/**
 * Hand-written artifact builders for the runtime executor tests. They stand in for the
 * (editor-owned) module emitter: a test constructs the two artifacts directly and drives
 * them through `FXEmitter.fromArtifacts`, so the runtime loop is exercised without any
 * graph/compiler.
 */

/** A minimal unlit render artifact (flat white albedo). Override any field. */
export function unlitArtifact(
  over: {
    attributeReads?: readonly FXAttributeDecl[];
    outputs?: Record<string, string>;
    uniformDeclarations?: readonly string[];
    uniforms?: FXRenderArtifact["uniforms"];
    vertexBody?: readonly string[];
    fragmentBody?: readonly string[];
    geometry?: FXRenderArtifact["geometry"];
  } = {},
): FXRenderArtifact {
  return {
    lightingIntrinsics: [],
    geometry: over.geometry,
    uniformDeclarations: over.uniformDeclarations ?? [],
    vertex: { varyingDeclarations: [], helperFunctions: [], body: over.vertexBody ?? [] },
    fragment: { varyingDeclarations: [], helperFunctions: [], body: over.fragmentBody ?? [] },
    outputs: over.outputs ?? { albedo: "vec4(1.0)" },
    uniforms: over.uniforms ?? {},
    attributeReads: over.attributeReads ?? [],
  };
}

/**
 * Wraps one artifact for both render targets - an `FXEffectSpec`'s `render` field. Most tests don't
 * exercise the baseline/standard split itself, so the same artifact stands in for both by default.
 */
export function renderForBothTargets(
  render: FXRenderArtifact,
  override: Partial<FXRenderArtifactsByGLSLTier> = {},
): FXRenderArtifactsByGLSLTier {
  return { baseline: render, standard: render, ...override };
}

/** One attribute the behavior artifact seeds at spawn (fixed or per-particle value). */
export interface SeedAttr {
  name: string;
  components: 1 | 2 | 3 | 4;
  value?: readonly number[];
  valueFn?: (index: number) => readonly number[];
}

/**
 * A behavior artifact whose `spawn` seeds a fixed `lifetime` into the core `lifecycle`
 * buffer and writes each declared attribute's value. `update` defaults to a no-op.
 * `noSpawn: true` yields an update-only (non-particle) host - no `spawn` function, so
 * `canSpawn` is false.
 */
export function behaviorArtifact(
  spec: {
    lifetime?: number;
    attributes?: readonly SeedAttr[];
    update?: FXBehaviorArtifact["update"];
    updateWrittenBuffers?: readonly string[];
    noSpawn?: boolean;
  } = {},
): FXBehaviorArtifact {
  const attributes = spec.attributes ?? [];
  const lifetime = spec.lifetime ?? 5;

  const buffers: FXBufferLayout[] = [
    { name: FX_CORE_POSITION, stride: 3 },
    { name: FX_CORE_LIFECYCLE, stride: FX_CORE_LIFECYCLE_STRIDE },
    ...attributes.map((a) => ({ name: a.name, stride: a.components })),
  ];
  const attributeWrites: FXAttributeDecl[] = attributes.map((a) => ({
    name: a.name,
    components: a.components,
  }));

  const spawnPart = spec.noSpawn
    ? {}
    : {
        spawnWrittenBuffers: [FX_CORE_LIFECYCLE, ...attributes.map((a) => a.name)],
        spawn(buffers2: FXKernelBuffers, start: number, count: number): void {
          const lifecycle = buffers2[FX_CORE_LIFECYCLE];
          for (let i = start; i < start + count; i++) {
            lifecycle[i * FX_CORE_LIFECYCLE_STRIDE + FX_LIFETIME] = lifetime;
          }
          for (const attr of attributes) {
            const buf = buffers2[attr.name];
            for (let i = start; i < start + count; i++) {
              const value = attr.valueFn ? attr.valueFn(i) : (attr.value ?? []);
              for (let c = 0; c < attr.components; c++) {
                buf[i * attr.components + c] = value[c] ?? 0;
              }
            }
          }
        },
      };

  return {
    buffers,
    attributeWrites,
    bindings: {},
    updateWrittenBuffers: spec.updateWrittenBuffers ?? [],
    update: spec.update ?? ((): void => undefined),
    ...spawnPart,
  };
}

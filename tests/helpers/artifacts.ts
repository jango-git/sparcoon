import type {
  FXAttributeDecl,
  FXBehaviorArtifact,
  FXBufferLayout,
  FXEmitterTransform,
  FXParticleReads,
  FXRenderArtifact,
  FXRenderArtifactsByGLSLTier,
  FXSurfaceReads,
} from "../../src/artifact/FXArtifact";
import {
  FX_AGE,
  FX_CORE_LIFECYCLE,
  FX_CORE_LIFECYCLE_STRIDE,
  FX_CORE_POSITION,
  FX_LIFETIME,
  FX_POSITION_X,
} from "../../src/coreLayout";
import type { GLTypeInfo } from "../../src/instancedParticle/glTypeInfo";
import type { FXParticleLayout } from "../../src/render/FXArtifactMaterial.Internal";
import type { FieldBuffers, FieldUpdate } from "./slots";
import { fieldBehavior } from "./slots";

/** The pose of an emitter at the world origin, at rest. */
export const IDENTITY_EMITTER_TRANSFORM: FXEmitterTransform = {
  worldMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  velocity: [0, 0, 0],
  angularVelocity: [0, 0, 0],
};

/** Fixture `GLTypeInfo` values for the varying types tests wire up (position/lifecycle/attributes). */
export const FLOAT_VARYING: GLTypeInfo = {
  glslTypeName: "float",
  bufferSize: 1,
  instantiable: true,
};
export const VEC2_VARYING: GLTypeInfo = { glslTypeName: "vec2", bufferSize: 2, instantiable: true };
export const VEC3_VARYING: GLTypeInfo = { glslTypeName: "vec3", bufferSize: 3, instantiable: true };

/**
 * A particle layout binding exactly `fields`, one whole view each, named after it (`a_<key>`), and
 * nothing missing - the plainest layout a material builder takes, for tests that call one directly
 * and read each field's own attribute (a mesh packs what its render reads: `particleLayout`).
 */
export function layoutOf(fields: Record<string, GLTypeInfo>): FXParticleLayout {
  return {
    packed: Object.keys(fields).map((name) => {
      const components = fields[name].bufferSize;
      return { name, offset: 0, components, members: [{ name, components, componentOffset: 0 }] };
    }),
    missing: {},
  };
}

/**
 * Hand-written artifact builders for the runtime executor tests. They stand in for the
 * (editor-owned) module emitter: a test constructs the two artifacts directly and drives
 * them through `FXEmitter.fromArtifacts`, so the runtime loop is exercised without any
 * graph/compiler.
 */

/** The output slots the vertex stage computes; every other slot is the fragment stage's. */
const VERTEX_OUTPUT_SLOTS: ReadonlySet<string> = new Set([
  "particleTransform",
  "vertexTransform",
  "width",
]);

/** What a stage reading nothing of the particle records. */
export const NO_PARTICLE_READS: FXParticleReads = {
  position: false,
  lifecycle: false,
  attributes: [],
};

/**
 * What hand-written `code` reads of each particle - the editor's compiler records this as it
 * emits, so a fixture standing in for it derives the same from its own GLSL text.
 */
export function particleReadsIn(
  code: string,
  attributeReads: readonly FXAttributeDecl[] = [],
): FXParticleReads {
  const names = (pattern: string): boolean => new RegExp(`\\b(?:${pattern})\\b`).test(code);
  return {
    position: names("p_position|PARTICLE_POSITION(?:_[XYZ])?"),
    lifecycle: names("p_lifecycle|PARTICLE_AGE|PARTICLE_LIFETIME|PARTICLE_ID"),
    attributes: attributeReads.map((decl) => decl.name).filter((name) => names(`p_fx_${name}`)),
  };
}

/** What a fragment stage reading nothing of the surface frame records. */
export const NO_SURFACE_READS: FXSurfaceReads = { normal: false, tangent: false, position: false };

/** What hand-written fragment `code` reads of the surface frame - the fixture twin of the editor's
 *  recorded reads, like {@link particleReadsIn}. */
export function surfaceReadsIn(code: string): FXSurfaceReads {
  const names = (name: string): boolean => new RegExp(`\\b${name}\\b`).test(code);
  return {
    normal: names("geometryNormal"),
    tangent: names("geometryTangent"),
    position: names("worldPosition"),
  };
}

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
  const outputs = over.outputs ?? { albedo: "vec4(1.0)" };
  const attributeReads = over.attributeReads ?? [];
  const vertexBody = over.vertexBody ?? [];
  const fragmentBody = over.fragmentBody ?? [];
  const outputsOf = (vertex: boolean): string[] =>
    Object.keys(outputs)
      .filter((slot) => VERTEX_OUTPUT_SLOTS.has(slot) === vertex)
      .map((slot) => outputs[slot]);
  const stage = (body: readonly string[], vertex: boolean): FXRenderArtifact["vertex"] => ({
    helperFunctions: [],
    body,
    particleReads: particleReadsIn([...body, ...outputsOf(vertex)].join("\n"), attributeReads),
  });
  return {
    lightingIntrinsics: [],
    sceneDepth: false,
    geometry: over.geometry,
    uniformDeclarations: over.uniformDeclarations ?? [],
    varyings: [],
    vertex: stage(vertexBody, true),
    fragment: {
      ...stage(fragmentBody, false),
      surfaceReads: surfaceReadsIn([...fragmentBody, ...outputsOf(false)].join("\n")),
    },
    outputs,
    uniforms: over.uniforms ?? {},
    attributeReads,
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
    update?: FieldUpdate;
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

  return fieldBehavior({
    buffers,
    ...(spec.update === undefined ? {} : { update: spec.update }),
    ...(spec.noSpawn === true
      ? {}
      : {
          spawn(fields: FieldBuffers, start: number, count: number): void {
            const lifecycle = fields[FX_CORE_LIFECYCLE];
            for (let i = start; i < start + count; i++) {
              lifecycle[i * FX_CORE_LIFECYCLE_STRIDE + FX_LIFETIME] = lifetime;
            }
            for (const attr of attributes) {
              const buf = fields[attr.name];
              for (let i = start; i < start + count; i++) {
                const value = attr.valueFn ? attr.valueFn(i) : (attr.value ?? []);
                for (let c = 0; c < attr.components; c++) {
                  buf[i * attr.components + c] = value[c] ?? 0;
                }
              }
            }
          },
        }),
  });
}

/**
 * A behavior placing each newborn at the translation of the pose it spawns from (as a graph reading
 * `world-matrix` would), recording that pose into `poses`, and moving every live particle +`speed`
 * along x per second.
 */
/**
 * {@link placingBehavior} whose update also kills a live particle once it reaches `killX` - the
 * way an editor-emitted kernel kills: `age = max(age, lifetime)`, after its writes.
 */
export function killingBehavior(lifetime: number, killX: number, speed = 2): FXBehaviorArtifact {
  return placingFields(lifetime, [], speed, (fields, count) => {
    const position = fields[FX_CORE_POSITION];
    const lifecycle = fields[FX_CORE_LIFECYCLE];
    for (let i = 0; i < count; i++) {
      const row = i * FX_CORE_LIFECYCLE_STRIDE;
      if (position[i * 3 + FX_POSITION_X] >= killX - 1e-6) {
        lifecycle[row + FX_AGE] = Math.max(lifecycle[row + FX_AGE], lifecycle[row + FX_LIFETIME]);
      }
    }
  });
}

export function placingBehavior(
  lifetime: number,
  poses: FXEmitterTransform[] = [],
  speed = 2,
): FXBehaviorArtifact {
  return placingFields(lifetime, poses, speed);
}

// placingBehavior, with `after` run after its update.
function placingFields(
  lifetime: number,
  poses: FXEmitterTransform[],
  speed: number,
  after?: (fields: FieldBuffers, count: number) => void,
): FXBehaviorArtifact {
  return fieldBehavior({
    buffers: [
      { name: FX_CORE_POSITION, stride: 3 },
      { name: FX_CORE_LIFECYCLE, stride: FX_CORE_LIFECYCLE_STRIDE },
    ],
    spawn(fields, start, count, _bindings, emitter): void {
      const position = fields[FX_CORE_POSITION];
      const lifecycle = fields[FX_CORE_LIFECYCLE];
      if (emitter !== undefined) {
        poses.push({
          worldMatrix: [...emitter.worldMatrix],
          velocity: [...emitter.velocity],
          angularVelocity: [...emitter.angularVelocity],
        });
      }
      for (let i = start; i < start + count; i++) {
        lifecycle[i * FX_CORE_LIFECYCLE_STRIDE + FX_LIFETIME] = lifetime;
        for (let c = 0; c < 3; c++) {
          position[i * 3 + c] = emitter?.worldMatrix[12 + c] ?? 0;
        }
      }
    },
    update(fields, count, dt): void {
      const position = fields[FX_CORE_POSITION];
      const lifecycle = fields[FX_CORE_LIFECYCLE];
      for (let i = 0; i < count; i++) {
        const row = i * FX_CORE_LIFECYCLE_STRIDE;
        if (lifecycle[row + FX_AGE] < lifecycle[row + FX_LIFETIME]) {
          position[i * 3 + FX_POSITION_X] += speed * dt;
        }
      }
      after?.(fields, count);
    },
  });
}

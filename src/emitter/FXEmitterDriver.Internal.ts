import type { BufferGeometry, Mesh, Vector3 } from "three";
import type { FXEmitterTransform } from "../artifact/FXArtifact.js";
import {
  FX_CORE_LIFECYCLE,
  FX_CORE_LIFECYCLE_STRIDE,
  FX_CORE_POSITION,
  FX_CORE_POSITION_STRIDE,
  meshPropertyKeyFor,
} from "../coreLayout.js";
import type { GLTypeInfo } from "../instancedParticle/glTypeInfo.js";
import type { FXArtifactMaterial } from "../render/FXArtifactMaterial.js";

/**
 * @internal The backend-independent half of an {@link FXEmitter}: everything that differs between
 * the JS (CPU) and GPU (WebGL2 transform-feedback) particle-simulation backends, behind one shared
 * shape. `FXEmitter` holds exactly one implementation, chosen once by `fromArtifacts`.
 * Scheduling (`burst`/`play`/`stop`/`prewarm`'s rate/delay bookkeeping), sort-fraction timing, and
 * motion tracking stay on `FXEmitter` itself - they are cheap scalar arithmetic that does not care
 * which backend actually writes particle state.
 */
export interface FXEmitterDriver {
  /** The real Three.js draw object; `FXEmitter` adds it to the scene and sets shadow flags on it. */
  readonly mesh: Mesh;
  /** This driver's own attribute set (core buffers + every `fx_<name>` attribute), derived from its
   *  own artifact - never from the other backend's. Reused for the depth (shadow-caster) material. */
  readonly varyings: Record<string, GLTypeInfo>;
  readonly particleCount: number;
  readonly particleCapacity: number;
  /** Whether this driver's artifact can seed births at all (false = update-only). */
  readonly canSpawn: boolean;

  /** Claims `count` newborn slots (immediate `burst`, a delayed burst's expiry, or `play`'s rate
   *  accumulator) and seeds them from `transform`. */
  spawn(count: number, transform: FXEmitterTransform): void;
  /** Runs before this tick's scheduled bursts/plays: JS ages + culls; GPU has nothing to do here
   *  (its spawn range accumulates across `spawn()` calls regardless of tick boundaries - see
   *  `FXGPUEmitterDriver.endTick`'s own doc comment for why it must not reset here instead). */
  beginTick(deltaTime: number): void;
  /** Runs after this tick's scheduled bursts/plays: JS integrates the update kernel; GPU runs its
   *  one transform-feedback pass over every `spawn()` call accumulated since the PREVIOUS `endTick`
   *  (not just this tick's own scheduled ones - an immediate `burst()` between ticks counts too). */
  endTick(deltaTime: number, transform: FXEmitterTransform): void;
  /** Back-to-front depth sort for `sortCamera`; a GPU-driven emitter cannot do this at all (no
   *  CPU-visible positions) and warns once instead. */
  sortByDistance(cameraWorldPosition: Vector3): void;
  applyBindingValues(values: Readonly<Record<string, number | Float32Array>>): void;
  /** Kills all live particles; already-alive GPU particles age out naturally instead (no CPU-visible
   *  state to zero immediately - see `FXTransformFeedbackParticle.drop`'s own doc comment). */
  reset(): void;
  /**
   * Swaps this driver's material and base geometry in place for a render-only structural edit
   * (new shader, geometry primitive/mesh, shadow flags) - particle buffers, instance count, and
   * simulation state are left completely untouched, so playback never resets. Throws if the new
   * render artifact's attribute reads no longer agree with this driver's already-allocated
   * `varyings` (a genuine layout change - see {@link sameVaryings}): only a fresh driver
   * (`fromArtifacts`) can safely apply that, so the caller must fall back to a full rebuild.
   */
  applyRenderArtifact(material: FXArtifactMaterial, baseGeometry: BufferGeometry): void;
  destroy(): void;
}

const CORE_POSITION_TYPE: GLTypeInfo = {
  glslTypeName: "vec3",
  bufferSize: FX_CORE_POSITION_STRIDE,
  instantiable: true,
};

const CORE_LIFECYCLE_TYPE: GLTypeInfo = {
  glslTypeName: "vec3",
  bufferSize: FX_CORE_LIFECYCLE_STRIDE,
  instantiable: true,
};

// GLSL type of a float attribute, indexed by component count.
const GLSL_TYPE_BY_COMPONENTS: readonly string[] = ["", "float", "vec2", "vec3", "vec4"];

/** A named width declaration - shape shared by `FXAttributeDecl` (`components`) and a mapped
 *  `FXBufferLayout` (`stride`), the two concrete lists {@link mergeAttributeWidths} merges. */
interface FXNamedWidth {
  readonly name: string;
  readonly components: number;
}

/**
 * Merges width-declaring attribute lists (a driver's own state buffers, the render artifact's
 * `attributeReads`) into one name -> component-count map, throwing on a genuine cross-source
 * disagreement rather than sizing a buffer wrong. Shared by both drivers' constructors so the
 * validation itself never drifts between them, even though each driver's own input list does not.
 */
export function mergeAttributeWidths(
  ...sources: readonly (readonly FXNamedWidth[])[]
): ReadonlyMap<string, number> {
  const components = new Map<string, number>();
  for (const source of sources) {
    for (const decl of source) {
      const existing = components.get(decl.name);
      if (existing !== undefined && existing !== decl.components) {
        throw new Error(
          `FXEmitter: attribute "${decl.name}" is declared with conflicting widths ` +
            `(${existing.toString()} vs ${decl.components.toString()}) across its sources`,
        );
      }
      components.set(decl.name, decl.components);
    }
  }
  return components;
}

/** Builds a driver's full varyings map (the two core buffers plus one `fx_<name>` per attribute)
 *  from a merged width map - the input to both `FXArtifactMaterial.buildThreeMaterial` and either
 *  mesh class's constructor. */
export function varyingsFromComponents(
  components: ReadonlyMap<string, number>,
): Record<string, GLTypeInfo> {
  const varyings: Record<string, GLTypeInfo> = {
    [FX_CORE_POSITION]: CORE_POSITION_TYPE,
    [FX_CORE_LIFECYCLE]: CORE_LIFECYCLE_TYPE,
  };
  for (const [name, count] of components) {
    varyings[meshPropertyKeyFor(name)] = {
      glslTypeName: GLSL_TYPE_BY_COMPONENTS[count],
      bufferSize: count,
      instantiable: true,
    };
  }
  return varyings;
}

/**
 * Whether two varyings maps declare the exact same names at the exact same width - the guard
 * `applyRenderArtifact` needs before reusing already-allocated buffers in place: a new render
 * artifact whose attribute reads disagree with what is already allocated (a new name, or an
 * existing name at a different width) cannot be applied without a full rebuild.
 */
export function sameVaryings(
  current: Record<string, GLTypeInfo>,
  next: Record<string, GLTypeInfo>,
): boolean {
  const currentNames = Object.keys(current);
  if (currentNames.length !== Object.keys(next).length) {
    return false;
  }
  return currentNames.every((name) => {
    if (!Object.prototype.hasOwnProperty.call(next, name)) {
      return false;
    }
    const nextEntry = next[name];
    return (
      nextEntry.glslTypeName === current[name].glslTypeName &&
      nextEntry.bufferSize === current[name].bufferSize
    );
  });
}

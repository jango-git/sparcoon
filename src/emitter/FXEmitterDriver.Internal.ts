import type { BufferGeometry, Mesh, Vector3 } from "three";
import type { FXAttributeDecl, FXEmitterTransform } from "../artifact/FXArtifact.js";
import {
  FX_CORE_LIFECYCLE,
  FX_CORE_LIFECYCLE_STRIDE,
  FX_CORE_POSITION,
  FX_CORE_POSITION_STRIDE,
  meshPropertyKeyFor,
} from "../coreLayout.js";
import type { GLTypeInfo } from "../instancedParticle/glTypeInfo.js";
import type { FXSlotLayout } from "../instancedParticle/FXTransformFeedbackParticle.js";
import type { FXArtifactMaterial } from "../render/FXArtifactMaterial.js";
import type { FXParticleLayout } from "../render/FXArtifactMaterial.Internal.js";
import type { FXPackedAttribute } from "../render/FXAttributePacking.js";
import { floatGLSLType, unpackedAttributes } from "../render/FXAttributePacking.js";
import type { FXTrailHistory } from "../trail/FXTrailHistory.Internal.js";

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
  /** What the current render material reads off this driver's mesh: the fields it holds (core
   *  buffers + every `fx_<name>` attribute its own artifact writes - never the other backend's),
   *  their packed views, and the render's unwritten reads (zero). Replaced by
   *  {@link applyRenderArtifact}; reused for the depth (shadow-caster) material. */
  readonly layout: FXParticleLayout;
  readonly particleCount: number;
  readonly particleCapacity: number;
  /** Births lost to a full ring so far; `undefined` where that cannot be known (GPU - no
   *  CPU-visible occupancy). */
  readonly particleOverflowCount: number | undefined;
  /** Whether this driver's artifact can seed births at all (false = update-only). */
  readonly canSpawn: boolean;

  /** Whether this driver can report its particles' deaths ({@link watchDeaths}) - only a CPU
   *  simulation sees them; the GPU one would need a readback. */
  readonly reportsDeaths: boolean;

  /** Claims `count` newborn slots and seeds them from `transform` and the current binding values.
   *  `FXEmitter` is the only caller, once per queued birth, from its own tick (see its `tick`):
   *  between {@link beginTick} and {@link endTick} for the births at the tick's pose - JS seeds
   *  them right away, GPU gathers them into the tick's one pass - and after {@link endTick} (or on
   *  a paused tick, with neither) for every other pose, which JS seeds right away and GPU seeds
   *  with a pass of its own. Either way a newborn is seeded, not yet updated. */
  spawn(count: number, transform: FXEmitterTransform): void;
  /**
   * Starts (`sink`) or stops (`undefined`) reporting each particle that dies - of age, or killed
   * by its update: during {@link beginTick}, once per particle alive before the tick and dead after
   * it, with its position
   * and its velocity over the tick. A slot a birth overwrites, and particles {@link reset} clears,
   * are not deaths. Throws when {@link reportsDeaths} is false and `sink` is given.
   */
  watchDeaths(sink: FXParticleDeathSink | undefined): void;
  /** Runs before this tick's scheduled bursts/plays: JS updates every existing slot, then ages
   *  it; GPU starts gathering this tick's spawns into its pass. */
  beginTick(deltaTime: number, transform: FXEmitterTransform): void;
  /** Runs after this tick's scheduled bursts/plays: GPU runs its one transform-feedback pass -
   *  update for every slot, spawn for the range this tick gathered; JS has nothing left to do.
   *  Either way a particle born in this tick is seeded, not yet updated. */
  endTick(deltaTime: number, transform: FXEmitterTransform): void;
  /** Back-to-front depth sort for `sortCamera`; a GPU-driven emitter cannot do this at all (no
   *  CPU-visible positions) and warns once instead. */
  sortByDistance(cameraWorldPosition: Vector3): void;
  applyBindingValues(values: Readonly<Record<string, number | Float32Array>>): void;
  /** Kills all live particles and rewinds the ring cursor. */
  reset(): void;
  /**
   * Swaps this driver's material and base geometry in place for a render-only structural edit
   * (new shader, geometry primitive/mesh, shadow flags) - particle buffers, instance count, and
   * simulation state are left completely untouched, so playback never resets. What the mesh holds
   * depends only on the simulation, never on the render - a new read of a field nothing writes is
   * just another zero constant (see {@link particleLayout}) - so this throws only when the new
   * render reads a held field at another width, which no driver could draw either.
   */
  applyRenderArtifact(material: FXArtifactMaterial, baseGeometry: BufferGeometry): void;
  /**
   * A history of `frames` snapshots of this driver's particle slots, for a trail reading `reads`
   * (property keys with their types, see `trailReadFields`): it records the ones this driver's
   * simulation writes, laid out and packed by `trailHistoryLayout` (its `layout`, which also lists
   * the reads it does not record - zero), and throws when the trail reads one at another width.
   */
  createTrailHistory(reads: Readonly<Record<string, GLTypeInfo>>, frames: number): FXTrailHistory;
  destroy(): void;
}

/** Receives one death from {@link FXEmitterDriver.watchDeaths}: position, then velocity. */
export type FXParticleDeathSink = (
  positionX: number,
  positionY: number,
  positionZ: number,
  velocityX: number,
  velocityY: number,
  velocityZ: number,
) => void;

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

function floatType(components: number): GLTypeInfo {
  return {
    glslTypeName: floatGLSLType(components),
    bufferSize: components,
    instantiable: true,
  };
}

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
    varyings[meshPropertyKeyFor(name)] = floatType(count);
  }
  return varyings;
}

/** The fields a particle mesh holds and the views it binds them through - what a driver's
 *  {@link FXParticleLayout} is built on, fixed for the driver's life. */
export interface FXHeldParticleFields {
  readonly fields: Readonly<Record<string, GLTypeInfo>>;
  readonly packed: readonly FXPackedAttribute[];
}

/**
 * What the JS mesh holds for a behavior writing `attributeWrites`: the core buffers and every
 * written attribute, each its own `Float32Array` (the editor-emitted kernel indexes them by literal
 * offsets of its own buffers), so one view per field, named after it (`a_<key>`, as
 * `FXInstancedParticle` binds it).
 */
export function jsHeldFields(attributeWrites: readonly FXNamedWidth[]): FXHeldParticleFields {
  const fields = varyingsFromComponents(mergeAttributeWidths(attributeWrites));
  return {
    fields,
    packed: unpackedAttributes(
      Object.keys(fields).map((name) => ({ name, components: fields[name].bufferSize })),
      (field) => field.name,
    ),
  };
}

/** What the GPU mesh holds for a kernel's `slot`: every field of it, through the slot's own
 *  packed views (see {@link FXSlotLayout.packed}). */
export function gpuHeldFields(slot: FXSlotLayout): FXHeldParticleFields {
  const fields: Record<string, GLTypeInfo> = {};
  for (const field of slot.fields) {
    fields[field.name] = floatType(field.components);
  }
  return { fields, packed: slot.packed };
}

/**
 * The layout a render reading `attributeReads` draws a mesh holding `held` with - built the same
 * way by both drivers and the render budget. A read field the mesh does not hold is written by
 * nothing, so always zero (attributes have no defaults): it goes into `missing`, a constant in the
 * shader, with no buffer and no attribute - the trail's mechanism for a field its emitter does not
 * hold (`trailHistoryLayout`), here for the particle path. The core buffers are always read (the
 * shader's macros and dead-particle clip use them), so a mesh lacking one reads it as zero too.
 *
 * @throws When the render reads a field at another width than the mesh holds it, or reads one name
 *   at two widths - no layout could draw that.
 */
export function particleLayout(
  held: FXHeldParticleFields,
  attributeReads: readonly FXAttributeDecl[],
): FXParticleLayout {
  const missing: Record<string, GLTypeInfo> = {};
  const core = varyingsFromComponents(new Map());
  for (const name in core) {
    if (!(name in held.fields)) {
      missing[name] = core[name];
    }
  }
  for (const [name, components] of mergeAttributeWidths(attributeReads)) {
    const key = meshPropertyKeyFor(name);
    const holding = held.fields[key] as GLTypeInfo | undefined;
    if (holding === undefined) {
      missing[key] = floatType(components);
    } else if (holding.bufferSize !== components) {
      throw new Error(
        `FXEmitter: attribute "${name}" is declared with conflicting widths ` +
          `(${holding.bufferSize.toString()} vs ${components.toString()}) across its sources`,
      );
    }
  }
  return { fields: held.fields, packed: held.packed, missing };
}

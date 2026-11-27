import type { Material, Mesh, Vector3 } from "three";
import { BufferGeometry, MeshBasicMaterial } from "three";

import type {
  FXAttributeDecl,
  FXEmitterTransform,
  FXRenderArtifact,
} from "../artifact/FXArtifact.js";
import {
  FX_CORE_LIFECYCLE,
  FX_CORE_LIFECYCLE_STRIDE,
  FX_CORE_POSITION,
  FX_CORE_POSITION_STRIDE,
  meshPropertyKeyFor,
} from "../coreLayout.js";
import type { FXSlotLayout } from "../instancedParticle/FXParticleSlot.js";
import type { GLTypeInfo } from "../instancedParticle/glTypeInfo.js";
import type { FXParticleLayout } from "../render/FXArtifactMaterial.Internal.js";
import { renderReadProperties } from "../render/FXArtifactMaterial.Internal.js";
import type { FXArtifactMaterial } from "../render/FXArtifactMaterial.js";
import type { FXPackedAttribute } from "../render/FXAttributePacking.js";
import { floatGLSLType, packConsecutive } from "../render/FXAttributePacking.js";
import type { FXParticleTextures } from "../render/FXParticleTextures.Internal.js";
import type { FXRibbonPoints } from "../ribbon/FXRibbonPoints.Internal.js";
import type { FXTrailHistory } from "../trail/FXTrailHistory.Internal.js";
import type { FXBirthAges } from "./FXBirthAges.Internal.js";
import type { FXParticleEventKind } from "./FXEmitter.Internal.js";
import type { FXLinkedProgram } from "./FXLinkedProgram.Internal.js";

/**
 * @internal The interface of the JS and GPU simulation backends. `FXEmitter` holds one, chosen once
 * by `fromArtifacts`. Scheduling, sort timing and motion tracking stay in `FXEmitter`.
 */
export interface FXEmitterDriver {
  /** The real Three.js draw object; `FXEmitter` adds it to the scene and sets shadow flags on it. */
  readonly mesh: Mesh;
  /** What the current render material reads off this driver's mesh: the views it binds over its
   *  own slot (never the other backend's), packed from what that render reads, and the render's
   *  unwritten reads (zero). Replaced by {@link applyRenderArtifact}; reused for the depth
   *  (shadow-caster) material. */
  readonly layout: FXParticleLayout;
  /** The particle slot this driver's simulation lays out (fixed for the driver's life). */
  readonly slot: FXSlotLayout;
  readonly particleCount: number;
  readonly particleCapacity: number;
  /** Births lost to a full ring so far; `undefined` where that cannot be known (GPU - no
   *  CPU-visible occupancy). */
  readonly particleOverflowCount: number | undefined;
  /** Whether this driver's artifact can seed births at all (false = update-only). */
  readonly canSpawn: boolean;

  /** Whether this driver can report its particles' births and deaths ({@link watch}) - only a CPU
   *  simulation sees them; the GPU one would need a readback. */
  readonly reportsEvents: boolean;
  /** The raw WebGL programs it runs itself, building or built: none for a CPU simulation. */
  readonly programs: readonly FXLinkedProgram[];

  /**
   * Claims `count` newborn slots and seeds them from `transform`, `inherited` and the current
   * binding values. Between {@link beginTick} and {@link endTick} the births at the tick's pose are
   * seeded at once (JS) or gathered into the tick's pass (GPU). Other births are seeded at once
   * (JS) or by a pass of their own (GPU). A newborn is seeded, not updated.
   *
   * `ages`: the births happened this long before the tick's end (see {@link FXBirthAges}) and are
   * seeded with that age. Without it they are born at the tick's end. Inside a tick, aged births
   * are the last at its pose, the tail of the GPU pass. All births at one pose share one
   * `inherited` array.
   */
  spawn(
    count: number,
    transform: FXEmitterTransform,
    inherited: Float32Array,
    ages?: FXBirthAges,
  ): void;
  /**
   * Starts (`sink`) or stops (`undefined`) reporting one kind of particle event, each with its slot
   * (read during the call: a later birth may claim it) and a velocity. Throws when
   * {@link reportsEvents} is false and `sink` is given.
   *
   * - `"death"`: during {@link beginTick}, once per particle alive before the tick and dead after
   *   it - of age, or killed by its update - with its velocity over the tick. A slot a birth
   *   overwrites, and particles {@link reset} clears, are not deaths.
   * - `"birth"`: during {@link spawn}, once per slot it seeded alive, with the velocity of the pose
   *   it was seeded from.
   */
  watch(kind: FXParticleEventKind, sink: FXParticleEventSink | undefined): void;
  /** Moves what the simulation reads that changes with time on its own, not with the particles -
   *  an object surface's pose - on by `deltaTime`. Every tick, a paused or settled one too, before
   *  any birth. */
  advance(deltaTime: number): void;
  /** Runs before this tick's scheduled bursts/plays: JS updates every existing slot, then ages
   *  it; GPU starts gathering this tick's spawns into its pass. */
  beginTick(deltaTime: number, transform: FXEmitterTransform): void;
  /** Runs after this tick's scheduled bursts/plays: GPU runs its one transform-feedback pass -
   *  update for every slot, spawn for the range this tick gathered; JS has nothing left to do.
   *  Either way a particle born in this tick is seeded, not yet updated. */
  endTick(deltaTime: number, transform: FXEmitterTransform): void;
  /**
   * Readies a sorted emitter's particles for drawing, once after each tick: back to front from
   * `cameraWorldPosition` when given (on the frames its sort fraction picks); the GPU also copies
   * what its passes wrote since into the textures its material reads. Only an emitter built with
   * `sort` calls it - a GPU driver built without it has no textures.
   */
  prepareDraw(cameraWorldPosition: Vector3 | undefined): void;
  applyBindingValues(values: Readonly<Record<string, number | Float32Array>>): void;
  /** Kills all live particles and rewinds the ring cursor. */
  reset(): void;
  /**
   * Swaps this driver's material and base geometry in place for a render-only structural edit
   * (new shader, geometry primitive/mesh, shadow flags), or stops (`undefined`) or starts drawing
   * the particles - particle buffers, instance count, and simulation state are left completely
   * untouched, so playback never resets; only the views bound over the slot follow the new
   * render's reads (see {@link particleLayout}). What the slot holds depends only on the
   * simulation, never on the render - a new read of a field nothing writes is just another zero
   * constant - so this throws only when the new render reads a held field at another width, which
   * no driver could draw either.
   */
  applyRenderArtifact(draw: FXParticleDraw | undefined): void;
  /**
   * A history of `frames` snapshots of this driver's particle slots, for a trail reading `reads`
   * (property keys with their types, see `stripReadFields`): it records the ones this driver's
   * simulation writes, laid out and packed by `stripLayout` (its `layout`, which also lists
   * the reads it does not record - zero), and throws when the trail reads one at another width.
   */
  createTrailHistory(reads: Readonly<Record<string, GLTypeInfo>>, frames: number): FXTrailHistory;
  /**
   * The points of a ribbon reading `reads` (as for {@link createTrailHistory}), through this
   * driver's particle slots in birth order (see {@link FXRibbonPointOptions}). Throws as
   * {@link createTrailHistory} does.
   */
  createRibbonPoints(
    reads: Readonly<Record<string, GLTypeInfo>>,
    options: FXRibbonPointOptions,
  ): FXRibbonPoints;
  destroy(): void;
}

/** What a ribbon's points take besides its reads. */
export interface FXRibbonPointOptions {
  /** Particles per repeat of `p_uv.x`, 0 for each point's age over its lifetime. */
  readonly tile: number;
  /** Particles per section, 0 for one ribbon through every particle (see `FXRibbonOptions`). */
  readonly section: number;
  /** Whether the points end at a birth probe (see `FXBirthProbe`): the ribbon's head. */
  readonly head: boolean;
}

/** What an emitter draws its particles with; `undefined` where it does not draw them. */
export interface FXParticleDraw {
  readonly material: FXArtifactMaterial;
  readonly baseGeometry: BufferGeometry;
}

/** What a driver's mesh is built or swapped with for an {@link FXParticleDraw}. */
export interface FXParticleMeshParts {
  readonly layout: FXParticleLayout;
  readonly material: Material;
  readonly baseGeometry: BufferGeometry;
  /** Whether the mesh draws: false without a draw. */
  readonly visible: boolean;
}

/** The layout of a mesh that draws nothing: no view bound, nothing read. */
const NO_PARTICLE_LAYOUT: FXParticleLayout = {
  packed: [],
  source: { kind: "attributes" },
  missing: {},
};

/**
 * The parts a mesh of `slot` draws `draw` with (see {@link particleLayout}). Without a draw the
 * mesh still holds the particles, for the simulation and anything recording them, but is hidden:
 * three neither draws nor compiles a hidden object, so its stand-in material is never built.
 * @throws As {@link particleLayout}.
 */
export function particleMeshParts(
  slot: FXSlotLayout,
  draw: FXParticleDraw | undefined,
  textures?: FXParticleTextures,
): FXParticleMeshParts {
  if (draw === undefined) {
    return {
      layout: NO_PARTICLE_LAYOUT,
      material: new MeshBasicMaterial(),
      baseGeometry: new BufferGeometry(),
      visible: false,
    };
  }
  const layout = particleLayout(slot, draw.material.artifact, textures);
  return {
    layout,
    material: draw.material.buildThreeMaterial(layout),
    baseGeometry: draw.baseGeometry,
    visible: true,
  };
}

/** Receives one event from {@link FXEmitterDriver.watch}: the slots its particle lies in from
 *  `offset` on ({@link FXEmitterDriver.slot}), then its velocity. */
export type FXParticleEventSink = (
  slots: Float32Array,
  offset: number,
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

/**
 * A render's `attributeReads` as one name -> component-count map, throwing when it reads one name
 * at two widths rather than declaring an attribute wrong (message shared with a read at another
 * width than held, see {@link particleLayout}).
 */
function attributeWidths(decls: readonly FXAttributeDecl[]): ReadonlyMap<string, number> {
  const components = new Map<string, number>();
  for (const decl of decls) {
    const existing = components.get(decl.name);
    if (existing !== undefined && existing !== decl.components) {
      throw new Error(
        `FXEmitter: attribute "${decl.name}" is declared with conflicting widths ` +
          `(${existing.toString()} vs ${decl.components.toString()}) across its sources`,
      );
    }
    components.set(decl.name, decl.components);
  }
  return components;
}

/** The core fields plus one `fx_<name>` per attribute of a width map, by property key and type. */
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

/** Every field of a particle `slot`, by property key and type. */
export function slotFields(slot: FXSlotLayout): Record<string, GLTypeInfo> {
  const fields: Record<string, GLTypeInfo> = {};
  for (const field of slot.fields) {
    fields[field.name] = floatType(field.components);
  }
  return fields;
}

/** A particle mesh's `index`-th view, bound as `a_<name>`. */
function particleViewName(index: number): string {
  return `pack${String(index)}`;
}

/**
 * The layout `render` draws a mesh of `slot` with - either backend's, built the same way by both
 * drivers and the render budget: the views the mesh binds, and the reads it cannot bind.
 *
 * The views pack only what the render reads (its stages' `particleReads`, and the core fields,
 * always read: the shader's macros and dead-particle clip use them): a field it does not read
 * never opens or ends a view, only bridges two read ones lying around it - so read fields an unread
 * one separates still share a view when they fit in four floats (see `packConsecutive`).
 *
 * A read field the slot does not hold is written by nothing, so always zero (attributes have no
 * defaults): it goes into `missing`, a constant in the shader, with no buffer and no attribute -
 * the trail's mechanism for a field its emitter does not hold (`stripLayout`), here for the
 * particle path. So is a core field the slot lacks.
 *
 * With `textures` (a sorted GPU emitter) the material reads the views from them instead of from
 * attributes.
 *
 * @throws When the render reads a field at another width than the slot holds it, or reads one name
 *   at two widths - no layout could draw that.
 */
export function particleLayout(
  slot: FXSlotLayout,
  render: FXRenderArtifact,
  textures?: FXParticleTextures,
): FXParticleLayout {
  const held = slotFields(slot);
  const missing: Record<string, GLTypeInfo> = {};
  const core = varyingsFromComponents(new Map());
  for (const name in core) {
    if (!(name in held)) {
      missing[name] = core[name];
    }
  }
  for (const [name, components] of attributeWidths(render.attributeReads)) {
    const key = meshPropertyKeyFor(name);
    const holding = held[key] as GLTypeInfo | undefined;
    if (holding === undefined) {
      missing[key] = floatType(components);
    } else if (holding.bufferSize !== components) {
      throw new Error(
        `FXEmitter: attribute "${name}" is declared with conflicting widths ` +
          `(${holding.bufferSize.toString()} vs ${components.toString()}) across its sources`,
      );
    }
  }
  const reads = renderReadProperties(render);
  const packed = packConsecutive(slot.fields, particleViewName, {
    reads: (name) => name in core || reads.has(name),
  });
  const source =
    textures === undefined
      ? ({ kind: "attributes" } as const)
      : ({ kind: "textures", stride: slot.stride, textures } as const);
  return { packed, source, missing };
}

/** The views a mesh binds as attributes for `layout`: none when its material reads textures. */
export function attributeViews(layout: FXParticleLayout): readonly FXPackedAttribute[] {
  return layout.source.kind === "attributes" ? layout.packed : [];
}

import type { FXBufferLayout } from "../artifact/FXArtifact.js";
import {
  FX_CORE_LIFECYCLE,
  FX_CORE_LIFECYCLE_STRIDE,
  FX_CORE_POSITION,
  FX_CORE_POSITION_STRIDE,
  meshPropertyKeyFor,
} from "../coreLayout.js";

/**
 * The interleaved per-particle slot both simulation backends keep their particles in - the JS
 * kernel indexes it by literal offsets, the GPU kernel writes it by transform feedback - and the
 * one rule laying it out. Three-free: the editor bakes a JS kernel's offsets from {@link slotLayout}
 * (through `sparcoon/editor`), so they and the views the runtime binds agree by construction.
 */

/** One field's place in a particle's slot, in floats. */
export interface FXSlotField {
  /** The field's name: a mesh property key (`position`, `lifecycle`, `fx_<name>`) in a
   *  {@link particleSlotLayout}, the kernel's own buffer name in a bare {@link slotLayout}. */
  readonly name: string;
  readonly components: number;
  readonly offset: number;
}

/**
 * A particle's slot: its fields back to back, in the order declared, `stride` floats in all -
 * memory only. The runtime never reorders it - a JS kernel's offsets and a GPU kernel's attribute
 * locations both follow that order - so the editor declares the fields in `packingOrder` (see
 * `FXAttributePacking.ts`), which keeps fields that pack into one view side by side. Which views a
 * mesh binds depends on what its render reads (`particleLayout`), not on the slot.
 */
export interface FXSlotLayout {
  readonly stride: number;
  readonly fields: readonly FXSlotField[];
}

/** Lays `fields` out back to back, in order. */
export function slotLayout(
  fields: readonly { readonly name: string; readonly components: number }[],
): FXSlotLayout {
  let stride = 0;
  const placed = fields.map((field) => {
    const slotField = { name: field.name, components: field.components, offset: stride };
    stride += field.components;
    return slotField;
  });
  return { stride, fields: placed };
}

/**
 * @internal The slot of a behavior declaring these `buffers` (a JS behavior artifact's or a GPU
 * kernel's): in order, under the mesh's property keys - a raw kernel name (`velocity`) becomes
 * `fx_velocity` (`meshPropertyKeyFor`), the core buffers keep theirs.
 */
export function particleSlotLayout(buffers: readonly FXBufferLayout[]): FXSlotLayout {
  return slotLayout(
    buffers.map((buffer) => ({
      name: meshPropertyKeyFor(buffer.name),
      components: buffer.stride,
    })),
  );
}

/** Where the two core fields lie in a slot, in floats from its start. */
export interface FXCoreOffsets {
  readonly position: number;
  readonly lifecycle: number;
}

/**
 * @internal The core fields' offsets in `slot`: every particle has both, at their fixed widths -
 * the age/lifetime test and the position every host-side pass (aging, sorting, trails, deaths)
 * reads.
 * @throws When the slot lacks one, or holds one at another width.
 */
export function coreOffsets(slot: FXSlotLayout): FXCoreOffsets {
  const offsetOf = (name: string, components: number): number => {
    const field = slot.fields.find((candidate) => candidate.name === name);
    if (field?.components !== components) {
      throw new Error(
        `FXEmitter: the particle slot must hold "${name}" with ${String(components)} components`,
      );
    }
    return field.offset;
  };
  return {
    position: offsetOf(FX_CORE_POSITION, FX_CORE_POSITION_STRIDE),
    lifecycle: offsetOf(FX_CORE_LIFECYCLE, FX_CORE_LIFECYCLE_STRIDE),
  };
}

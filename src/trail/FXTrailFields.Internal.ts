import type { FXRenderArtifact } from "../artifact/FXArtifact.js";
import { FX_CORE_LIFECYCLE, FX_CORE_POSITION } from "../coreLayout.js";
import { slotFields, varyingsFromComponents } from "../emitter/FXEmitterDriver.Internal.js";
import type { FXSlotLayout } from "../instancedParticle/FXParticleSlot.js";
import { coreOffsets } from "../instancedParticle/FXParticleSlot.js";
import type { GLTypeInfo } from "../instancedParticle/glTypeInfo.js";
import type { FXTrailLayout } from "../render/FXArtifactMaterial.Internal.js";
import { renderReadProperties } from "../render/FXArtifactMaterial.Internal.js";
import type { FXPackingField, FXPlacedField } from "../render/FXAttributePacking.js";
import { packConsecutive, packingOrder } from "../render/FXAttributePacking.js";

/**
 * @internal The particle fields a trail's render reads off the recorded path, by property key: the
 * attributes and the lifecycle its code reads (see `FXParticleReads`) - never one it only declares.
 * Never the position either - every trail records that, since the ribbon is built around it.
 */
export function trailReadFields(render: FXRenderArtifact): Record<string, GLTypeInfo> {
  const fields = varyingsFromComponents(
    new Map(render.attributeReads.map((decl) => [decl.name, decl.components] as const)),
  );
  const reads = renderReadProperties(render);
  for (const name in fields) {
    if (name === FX_CORE_POSITION || !reads.has(name)) {
      delete fields[name];
    }
  }
  return fields;
}

/**
 * @internal Splits a trail's `reads` into the fields an emitter holding `held` can record and the
 * ones it cannot (read as zero). Throws when the trail reads a held field at another width - a
 * history copying it at the trail's width would misalign every slot after the first.
 */
export function splitTrailFields(
  reads: Readonly<Record<string, GLTypeInfo>>,
  held: Readonly<Record<string, GLTypeInfo>>,
): { recorded: Record<string, GLTypeInfo>; missing: Record<string, GLTypeInfo> } {
  const recorded: Record<string, GLTypeInfo> = {};
  const missing: Record<string, GLTypeInfo> = {};
  for (const name in reads) {
    const holding = held[name] as GLTypeInfo | undefined;
    if (holding === undefined) {
      missing[name] = reads[name];
      continue;
    }
    if (holding.bufferSize !== reads[name].bufferSize) {
      throw new Error(
        `FXEmitter: the trail reads "${name}" with ${String(reads[name].bufferSize)} ` +
          `components; the emitter holds ${String(holding.bufferSize)}`,
      );
    }
    recorded[name] = holding;
  }
  return { recorded, missing };
}

/** The `"cpu"` history point's own floats, ahead of its recorded fields: `[x, y, z, id + 1 | 0
 *  dead]`, `[tangent x, y, z, recorded time]` - the `FX_TRAIL_CPU_POINT` / `_TANGENT` vec4s. */
export const FX_TRAIL_CPU_POINT_FLOATS = 8;

/** A recorded field's packed view name, before {@link trailAttributeNames} gives it its ends. */
function packName(index: number): string {
  return `pack${String(index)}`;
}

function fieldList(fields: Readonly<Record<string, GLTypeInfo>>): FXPackingField[] {
  return Object.keys(fields).map((name) => ({ name, components: fields[name].bufferSize }));
}

/**
 * @internal What a history of `kind` records for a trail reading `reads`, off an emitter whose
 * particles live in `slot`, and how it packs that into attributes - the one place both drivers and
 * `fxTrailRenderBudget` derive it from, so the mounted attributes and the budget can never drift
 * apart. Throws as {@link splitTrailFields} does.
 *
 * - `"cpu"`: the history lays its own point out, so it picks the order - {@link packingOrder} of
 *   the recorded fields, after the packed point and joint - and records every read field held.
 * - `"gpu"`: the history copies whole slots, so the slot's order is fixed (the editor declares it
 *   in the same `packingOrder`); this only groups over it. Always records the position and
 *   lifecycle too, which the shader links points with, and also views them at the point before a
 *   segment's start.
 */
export function trailHistoryLayout(
  kind: "cpu" | "gpu",
  reads: Readonly<Record<string, GLTypeInfo>>,
  slot: FXSlotLayout,
): FXTrailLayout {
  const { recorded, missing } = splitTrailFields(reads, slotFields(slot));
  if (kind === "cpu") {
    let stride = FX_TRAIL_CPU_POINT_FLOATS;
    const placed: FXPlacedField[] = [];
    const ordered: Record<string, GLTypeInfo> = {};
    for (const field of packingOrder(fieldList(recorded))) {
      placed.push({ ...field, offset: stride });
      ordered[field.name] = recorded[field.name];
      stride += field.components;
    }
    return {
      kind,
      recorded: ordered,
      missing,
      packed: packConsecutive(placed, packName),
      previous: [],
      stride,
    };
  }
  // The shader links points by both, so the slot must hold them; typed off the fixed core layout.
  coreOffsets(slot);
  const core = varyingsFromComponents(new Map());
  recorded[FX_CORE_POSITION] = core[FX_CORE_POSITION];
  recorded[FX_CORE_LIFECYCLE] = core[FX_CORE_LIFECYCLE];
  const isCore = (name: string): boolean => name === FX_CORE_POSITION || name === FX_CORE_LIFECYCLE;
  const previousName = (index: number): string => `prev${String(index)}`;
  return {
    kind,
    recorded,
    missing,
    packed: packConsecutive(slot.fields, packName, { reads: (name) => name in recorded }),
    previous: packConsecutive(slot.fields, previousName, { reads: isCore }),
    stride: slot.stride,
  };
}

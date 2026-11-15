import type { InstancedBufferGeometry, InstancedInterleavedBuffer } from "three";
import { InterleavedBufferAttribute } from "three";

import type { FXRenderArtifact } from "../artifact/FXArtifact.js";
import { FX_CORE_LIFECYCLE, FX_CORE_POSITION } from "../coreLayout.js";
import { slotFields, varyingsFromComponents } from "../emitter/FXEmitterDriver.Internal.js";
import { mountPacked } from "../instancedParticle/FXMeshGeometry.Internal.js";
import type { FXSlotLayout } from "../instancedParticle/FXParticleSlot.js";
import { coreOffsets } from "../instancedParticle/FXParticleSlot.js";
import { FXInterleavedGLAttribute } from "../instancedParticle/FXTransformFeedbackParticle.js";
import type { GLTypeInfo } from "../instancedParticle/glTypeInfo.js";
import { renderReadProperties } from "../render/FXArtifactMaterial.Internal.js";
import type {
  FXPackedAttribute,
  FXPackingField,
  FXPlacedField,
} from "../render/FXAttributePacking.js";
import { packConsecutive, packingOrder } from "../render/FXAttributePacking.js";
import {
  FX_STRIP_CPU_POINT,
  FX_STRIP_CPU_TANGENT,
  type FXStripLayout,
  stripAttributeNames,
  stripPreviousAttributeName,
} from "../render/FXStripMaterial.Internal.js";

/**
 * @internal What a strip's points hold and how they become attributes - shared by the trail (a
 * history of frames of points) and the ribbon (one frame), so their packing, their mounts and
 * their budget come from one place.
 */

/**
 * The particle fields a strip's render reads off its points, by property key: the attributes and
 * the lifecycle its code reads (see `FXParticleReads`) - never one it only declares. Never the
 * position either - every strip takes that, since the band is built around it.
 */
export function stripReadFields(render: FXRenderArtifact): Record<string, GLTypeInfo> {
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
 * Splits a strip's `reads` into the fields an emitter holding `held` can record and the ones it
 * cannot (read as zero). Throws when the strip reads a held field at another width - points
 * copying it at the strip's width would misalign every slot after the first.
 */
export function splitStripFields(
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
        `FXEmitter: the strip reads "${name}" with ${String(reads[name].bufferSize)} ` +
          `components; the emitter holds ${String(holding.bufferSize)}`,
      );
    }
    recorded[name] = holding;
  }
  return { recorded, missing };
}

/** A `"cpu"` point's own floats, ahead of its fields: `[x, y, z, id + 1 | 0 dead]`, `[tangent x,
 *  y, z, w]` - the `FX_STRIP_CPU_POINT` / `_TANGENT` vec4s; `w` is a trail point's recorded time
 *  and a ribbon point's `p_uv.x`. */
export const FX_STRIP_CPU_POINT_FLOATS = 8;

/** A recorded field's packed view name, before {@link stripAttributeNames} gives it its ends. */
function packName(index: number): string {
  return `pack${String(index)}`;
}

function fieldList(fields: Readonly<Record<string, GLTypeInfo>>): FXPackingField[] {
  return Object.keys(fields).map((name) => ({ name, components: fields[name].bufferSize }));
}

/**
 * What a strip's points of `kind` record for a render reading `reads`, off an emitter whose
 * particles live in `slot`, and how they pack that into attributes - the one place both drivers
 * and `fxStripRenderBudget` derive it from, so the mounted attributes and the budget can never
 * drift apart. Throws as {@link splitStripFields} does.
 *
 * - `"cpu"`: the points are laid out here, so this picks the order - {@link packingOrder} of the
 *   recorded fields, after the packed point and joint - and records every read field held.
 * - `"gpu"`: the points are whole slots copied, so the slot's order is fixed (the editor declares
 *   it in the same `packingOrder`); this only groups over it. Always records the position and
 *   lifecycle too, which the shader links points with, and also views them at the point before a
 *   segment's start.
 */
export function stripLayout(
  kind: "cpu" | "gpu",
  reads: Readonly<Record<string, GLTypeInfo>>,
  slot: FXSlotLayout,
): FXStripLayout {
  const { recorded, missing } = splitStripFields(reads, slotFields(slot));
  if (kind === "cpu") {
    let stride = FX_STRIP_CPU_POINT_FLOATS;
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

/**
 * Writes a `"cpu"` point's own vec4s at float `at` of `points`: its position (from float
 * `position` of `source`) and `tag` - the particle's id + 1, 0 when dead, so a zero point is dead -
 * then its joint tangent, its position minus the point at float `linked` (`-1` when the two are
 * not linked: a zero tangent), with `w` - what the strip runs along it (a trail's record time, a
 * ribbon's `p_uv.x`).
 */
export function writeStripPoint(
  points: Float32Array,
  at: number,
  source: Float32Array,
  position: number,
  tag: number,
  linked: number,
  w: number,
): void {
  const x = source[position];
  const y = source[position + 1];
  const z = source[position + 2];
  points[at + 4] = linked < 0 ? 0 : x - points[linked];
  points[at + 5] = linked < 0 ? 0 : y - points[linked + 1];
  points[at + 6] = linked < 0 ? 0 : z - points[linked + 2];
  points[at + 7] = w;
  points[at] = x;
  points[at + 1] = y;
  points[at + 2] = z;
  points[at + 3] = tag;
}

/** The tag {@link writeStripPoint} wrote into the `"cpu"` point at float `at` of `points`. */
export function stripPointTag(points: Float32Array, at: number): number {
  return points[at + 3];
}

/** A point's own vec4s in a `"cpu"` layout, ahead of its fields - views carrying no particle
 *  field, mounted alongside the layout's packed ones. */
const CPU_POINT_VIEWS: readonly FXPackedAttribute[] = [
  { name: FX_STRIP_CPU_POINT, offset: 0, components: 4, members: [] },
  { name: FX_STRIP_CPU_TANGENT, offset: 4, components: 4, members: [] },
];

/** One field a `"cpu"` point copies: its place in the point and in the particle slot, in floats. */
export interface FXPlacedStripField {
  readonly components: number;
  readonly offset: number;
  readonly from: number;
}

/**
 * Where each field of a `"cpu"` `layout` lies in a point and in `slot`.
 * @throws When `slot` lacks a field the layout packs (`context` names the caller).
 */
export function placeStripFields(
  layout: FXStripLayout,
  slot: FXSlotLayout,
  context: string,
): readonly FXPlacedStripField[] {
  return layout.packed.flatMap((view) =>
    view.members.map((member) => {
      const from = slot.fields.find((field) => field.name === member.name);
      if (from === undefined) {
        throw new Error(`${context}: the slot lacks the read "${member.name}"`);
      }
      return {
        components: member.components,
        offset: view.offset + member.componentOffset,
        from: from.offset,
      };
    }),
  );
}

/**
 * Copies `fields` of `count` slots of `source` (`sourceStride` floats each) from slot
 * `sourceFirst` on into the points of `target` (`targetStride` floats each) from float
 * `targetBase` on.
 */
export function copyStripFields(
  fields: readonly FXPlacedStripField[],
  source: Float32Array,
  sourceStride: number,
  sourceFirst: number,
  target: Float32Array,
  targetStride: number,
  targetBase: number,
  count: number,
): void {
  for (const field of fields) {
    for (let slot = 0; slot < count; slot++) {
      const to = targetBase + slot * targetStride + field.offset;
      const origin = (sourceFirst + slot) * sourceStride + field.from;
      for (let c = 0; c < field.components; c++) {
        target[to + c] = source[origin + c];
      }
    }
  }
}

/**
 * Sets the attributes a `"cpu"` `layout` reads onto `geometry`: every view of a point in `buffer`
 * twice - at a segment's start, and `endOffset` floats further on at its end.
 */
export function mountCPUStripPoints(
  geometry: InstancedBufferGeometry,
  layout: FXStripLayout,
  buffer: InstancedInterleavedBuffer,
  endOffset: number,
): void {
  const views = [...CPU_POINT_VIEWS, ...layout.packed];
  for (const [end, offset] of [
    ["a", 0],
    ["b", endOffset],
  ] as const) {
    mountPacked(
      geometry,
      views,
      (view) => stripAttributeNames(view.name)[end],
      (view) => new InterleavedBufferAttribute(buffer, view.components, offset + view.offset),
    );
  }
}

/**
 * Sets the attributes a `"gpu"` `layout` reads onto `geometry`, from the `points` whole particle
 * slots in `buffer`: its views at a segment's start and end, and the views of the point before the
 * start, each at its own offset in floats.
 */
export function mountGPUStripPoints(
  gl: WebGL2RenderingContext,
  geometry: InstancedBufferGeometry,
  layout: FXStripLayout,
  buffer: WebGLBuffer,
  points: number,
  offsets: { readonly previous: number; readonly start: number; readonly end: number },
): void {
  const mount = (
    views: readonly FXPackedAttribute[],
    name: (view: FXPackedAttribute) => string,
    offset: number,
  ): void => {
    mountPacked(
      geometry,
      views,
      name,
      (view) =>
        new FXInterleavedGLAttribute(
          gl,
          buffer,
          view.components,
          offset + view.offset,
          layout.stride,
          points,
        ),
    );
  };
  mount(layout.packed, (view) => stripAttributeNames(view.name).a, offsets.start);
  mount(layout.packed, (view) => stripAttributeNames(view.name).b, offsets.end);
  mount(layout.previous, (view) => stripPreviousAttributeName(view.name), offsets.previous);
}

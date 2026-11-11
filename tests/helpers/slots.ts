import type {
  FXBehaviorArtifact,
  FXBufferLayout,
  FXEmitterTransform,
  FXValueSlot,
} from "../../src/artifact/FXArtifact";
import type { FXInstancedParticle } from "../../src/instancedParticle/FXInstancedParticle";
import type { FXSlotLayout } from "../../src/instancedParticle/FXParticleSlot";
import { slotLayout } from "../../src/instancedParticle/FXParticleSlot";
import type { FXPackedAttribute } from "../../src/render/FXAttributePacking";
import { packConsecutive } from "../../src/render/FXAttributePacking";

/** Every field of a run of slots as its own tightly packed array, by name - the shape a test
 *  kernel indexes (`fields.position[i * 3 + c]`). */
export type FieldBuffers = Record<string, Float32Array>;

type Bindings = Record<string, FXValueSlot<number | Float32Array>>;

/** Copies each field of `slots` (laid out by `slot`) into an array of its own. */
export function splitFields(slot: FXSlotLayout, slots: Float32Array): FieldBuffers {
  const count = slots.length / slot.stride;
  const fields: FieldBuffers = {};
  for (const field of slot.fields) {
    const array = new Float32Array(count * field.components);
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < field.components; c++) {
        array[i * field.components + c] = slots[i * slot.stride + field.offset + c];
      }
    }
    fields[field.name] = array;
  }
  return fields;
}

/** Writes per-field arrays back into `slots` - the inverse of {@link splitFields}. */
export function mergeFields(slot: FXSlotLayout, fields: FieldBuffers, slots: Float32Array): void {
  const count = slots.length / slot.stride;
  for (const field of slot.fields) {
    const array = fields[field.name];
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < field.components; c++) {
        slots[i * slot.stride + field.offset + c] = array[i * field.components + c];
      }
    }
  }
}

/** A test kernel written over per-field arrays, by raw buffer name. */
export type FieldSpawn = (
  fields: FieldBuffers,
  start: number,
  count: number,
  bindings: Bindings,
  emitter?: FXEmitterTransform,
) => void;
export type FieldUpdate = (
  fields: FieldBuffers,
  count: number,
  deltaTime: number,
  bindings: Bindings,
  emitter?: FXEmitterTransform,
) => void;

/**
 * A behavior artifact over `buffers` whose kernels are written per field: each call splits the
 * slots into per-field arrays, runs the kernel on them and writes them back - so a test reads like
 * plain math while the runtime sees the real slot contract.
 */
export function fieldBehavior(spec: {
  buffers: readonly FXBufferLayout[];
  bindings?: Bindings;
  spawn?: FieldSpawn;
  update?: FieldUpdate;
}): FXBehaviorArtifact {
  const slot = slotLayout(spec.buffers.map((b) => ({ name: b.name, components: b.stride })));
  const run = (slots: Float32Array, body: (fields: FieldBuffers) => void): void => {
    const fields = splitFields(slot, slots);
    body(fields);
    mergeFields(slot, fields, slots);
  };
  const update = spec.update;
  const spawn = spec.spawn;
  return {
    buffers: spec.buffers,
    bindings: spec.bindings ?? {},
    update(slots, count, deltaTime, bindings, emitter): void {
      if (update !== undefined) {
        run(slots, (fields) => {
          update(fields, count, deltaTime, bindings, emitter);
        });
      }
    },
    ...(spawn === undefined
      ? {}
      : {
          spawn(
            slots: Float32Array,
            start: number,
            count: number,
            bindings: Bindings,
            emitter?: FXEmitterTransform,
          ): void {
            run(slots, (fields) => {
              spawn(fields, start, count, bindings, emitter);
            });
          },
        }),
  };
}

/** A copy of one field of every slot of `mesh`, by property key (`position`, `fx_seed`). */
export function fieldOf(mesh: FXInstancedParticle, key: string): Float32Array {
  const fields = splitFields(mesh.slot, mesh.slots);
  const field = fields[key] as Float32Array | undefined;
  if (field === undefined) {
    throw new Error(`fieldOf: the slot holds no "${key}"`);
  }
  return field;
}

/** The width of one field of `mesh`'s slot, by property key; undefined when it holds none. */
export function fieldComponents(mesh: FXInstancedParticle, key: string): number | undefined {
  return mesh.slot.fields.find((field) => field.name === key)?.components;
}

/** Sets component `component` of field `key` of slot `index` of `mesh`. */
export function setField(
  mesh: FXInstancedParticle,
  key: string,
  index: number,
  component: number,
  value: number,
): void {
  const field = mesh.slot.fields.find((candidate) => candidate.name === key);
  if (field === undefined) {
    throw new Error(`setField: the slot holds no "${key}"`);
  }
  mesh.slots[index * mesh.slot.stride + field.offset + component] = value;
}

/** A behavior's slot as `behaviorArtifact` declares it: the core fields, then `attributes`. */
export function behaviorSlot(
  attributes: readonly { readonly name: string; readonly components: number }[] = [],
): FXBufferLayout[] {
  return [
    { name: "position", stride: 3 },
    { name: "lifecycle", stride: 3 },
    ...attributes.map((attribute) => ({ name: attribute.name, stride: attribute.components })),
  ];
}

/** Views packing every field of `slot` - what a mesh binds for a render reading all of them. */
export function allViews(slot: FXSlotLayout): FXPackedAttribute[] {
  return packConsecutive(slot.fields, (index) => `pack${String(index)}`);
}

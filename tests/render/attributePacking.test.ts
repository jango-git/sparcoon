import { describe, expect, it } from "vitest";
import type {
  FXPackedAttribute,
  FXPackingField,
  FXPlacedField,
} from "../../src/render/FXAttributePacking";
import { packConsecutive, packingOrder } from "../../src/render/FXAttributePacking";
import * as editor from "../../src/editor/index";
import { slotLayout } from "../../src/instancedParticle/FXParticleSlot";

const pack = (index: number): string => `pack${String(index)}`;

/** Lays `fields` out back to back in the given order. */
function backToBack(fields: readonly FXPackingField[], start = 0): FXPlacedField[] {
  let offset = start;
  return fields.map((field) => {
    const placed = { ...field, offset };
    offset += field.components;
    return placed;
  });
}

/** Each view's member names, in order. */
function groups(packed: readonly FXPackedAttribute[]): string[][] {
  return packed.map((view) => view.members.map((member) => member.name));
}

/** A small deterministic PRNG, so the randomized cases are reproducible. */
function random(seed: number): () => number {
  let state = seed;
  return (): number => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], next: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Every field read lands in exactly one view member, at its own offset in memory; no view is wider
 * than a vec4 or reaches outside the fields it spans.
 */
function expectFaithful(
  fields: readonly FXPlacedField[],
  packed: readonly FXPackedAttribute[],
  reads: (name: string) => boolean = () => true,
): void {
  const seen = new Map<string, number>();
  for (const view of packed) {
    expect(view.components).toBeGreaterThanOrEqual(1);
    expect(view.components).toBeLessThanOrEqual(4);
    for (const member of view.members) {
      expect(seen.has(member.name)).toBe(false);
      seen.set(member.name, view.offset + member.componentOffset);
      expect(member.componentOffset + member.components).toBeLessThanOrEqual(view.components);
    }
    // Every float the view spans belongs to some field.
    for (let float = view.offset; float < view.offset + view.components; float++) {
      expect(
        fields.some((field) => float >= field.offset && float < field.offset + field.components),
      ).toBe(true);
    }
  }
  for (const field of fields) {
    if (reads(field.name)) {
      expect(seen.get(field.name)).toBe(field.offset);
    } else {
      expect(seen.has(field.name)).toBe(false);
    }
  }
}

const PARTICLE_FIELDS: readonly FXPackingField[] = [
  { name: "position", components: 3 },
  { name: "lifecycle", components: 3 },
  { name: "fx_color", components: 3 },
  { name: "fx_alpha", components: 1 },
  { name: "fx_size", components: 1 },
  { name: "fx_offset", components: 2 },
  { name: "fx_uv", components: 2 },
  { name: "fx_quat", components: 4 },
];

describe("packingOrder", () => {
  it("fills vec4 bins first-fit decreasing, ties broken by name", () => {
    expect(packingOrder(PARTICLE_FIELDS).map((field) => field.name)).toEqual([
      "fx_quat",
      "fx_color",
      "fx_alpha",
      "lifecycle",
      "fx_size",
      "position",
      "fx_offset",
      "fx_uv",
    ]);
  });

  it("depends only on the set of fields, never on the order they are listed in", () => {
    const expected = packingOrder(PARTICLE_FIELDS);
    const next = random(7);
    for (let i = 0; i < 20; i++) {
      expect(packingOrder(shuffled(PARTICLE_FIELDS, next))).toEqual(expected);
    }
  });

  it("lays out into exactly one view per bin", () => {
    const fields = backToBack(packingOrder(PARTICLE_FIELDS));
    expect(groups(packConsecutive(fields, pack))).toEqual([
      ["fx_quat"],
      ["fx_color", "fx_alpha"],
      ["lifecycle", "fx_size"],
      ["position"],
      ["fx_offset", "fx_uv"],
    ]);
  });

  it("packs vec2 + float + float and four floats into one bin each", () => {
    const order = packingOrder([
      { name: "f", components: 1 },
      { name: "e", components: 1 },
      { name: "v", components: 2 },
      { name: "a", components: 1 },
      { name: "b", components: 1 },
      { name: "c", components: 1 },
      { name: "d", components: 1 },
    ]);
    expect(groups(packConsecutive(backToBack(order), pack))).toEqual([
      ["v", "a", "b"],
      ["c", "d", "e", "f"],
    ]);
  });

  it("rejects a width outside 1..4 and a repeated name", () => {
    expect(() => packingOrder([{ name: "m", components: 9 }])).toThrow(RangeError);
    expect(() =>
      packingOrder([
        { name: "x", components: 1 },
        { name: "x", components: 2 },
      ]),
    ).toThrow(/twice/);
  });
});

describe("packConsecutive", () => {
  it("groups adjacent fields into views of at most four floats, with their swizzle offsets", () => {
    const packed = packConsecutive(
      backToBack([
        { name: "color", components: 3 },
        { name: "alpha", components: 1 },
        { name: "size", components: 1 },
      ]),
      pack,
    );
    expect(packed).toEqual([
      {
        name: "pack0",
        offset: 0,
        components: 4,
        members: [
          { name: "color", components: 3, componentOffset: 0 },
          { name: "alpha", components: 1, componentOffset: 3 },
        ],
      },
      {
        name: "pack1",
        offset: 4,
        components: 1,
        members: [{ name: "size", components: 1, componentOffset: 0 }],
      },
    ]);
  });

  it("never joins fields with a gap between them", () => {
    const packed = packConsecutive(
      [
        { name: "a", components: 1, offset: 0 },
        { name: "b", components: 1, offset: 2 },
      ],
      pack,
    );
    expect(groups(packed)).toEqual([["a"], ["b"]]);
  });

  it("walks the fields by offset, however they are listed", () => {
    const fields = backToBack([
      { name: "a", components: 1 },
      { name: "b", components: 3 },
    ]);
    expect(packConsecutive([...fields].reverse(), pack)).toEqual(packConsecutive(fields, pack));
  });

  it("is faithful for any layout order - only the number of views depends on it", () => {
    const next = random(42);
    const best = packConsecutive(backToBack(packingOrder(PARTICLE_FIELDS)), pack).length;
    for (let i = 0; i < 50; i++) {
      const fields = backToBack(shuffled(PARTICLE_FIELDS, next), 8);
      const packed = packConsecutive(fields, pack);
      expectFaithful(fields, packed);
      expect(packed.length).toBeGreaterThanOrEqual(best);
      expect(packed.length).toBeLessThanOrEqual(fields.length);
    }
  });

  it("spans an unread field only to reach a read one, and never starts or ends on one", () => {
    const fields = backToBack([
      { name: "skip", components: 2 },
      { name: "a", components: 1 },
      { name: "unread", components: 2 },
      { name: "b", components: 1 },
      { name: "tail", components: 1 },
    ]);
    const reads = (name: string): boolean => name === "a" || name === "b";
    const packed = packConsecutive(fields, pack, { reads });
    expect(packed).toEqual([
      {
        name: "pack0",
        offset: 2,
        components: 4,
        members: [
          { name: "a", components: 1, componentOffset: 0 },
          { name: "b", components: 1, componentOffset: 3 },
        ],
      },
    ]);
    // Trimmed back to the last read field when the bridge leads nowhere.
    expect(
      packConsecutive(
        backToBack([
          { name: "a", components: 1 },
          { name: "unread", components: 3 },
          { name: "b", components: 1 },
        ]),
        pack,
        { reads },
      ),
    ).toEqual([
      {
        name: "pack0",
        offset: 0,
        components: 1,
        members: [{ name: "a", components: 1, componentOffset: 0 }],
      },
      {
        name: "pack1",
        offset: 4,
        components: 1,
        members: [{ name: "b", components: 1, componentOffset: 0 }],
      },
    ]);
  });

  it("is faithful with any subset read", () => {
    const next = random(3);
    for (let i = 0; i < 50; i++) {
      const fields = backToBack(shuffled(PARTICLE_FIELDS, next));
      const read = new Set(fields.filter(() => next() < 0.5).map((field) => field.name));
      const reads = (name: string): boolean => read.has(name);
      const packed = packConsecutive(fields, pack, { reads });
      expectFaithful(fields, packed, reads);
      expect(packed.length).toBeLessThanOrEqual(read.size);
    }
  });

  it("names the views by the caller's function", () => {
    const packed = packConsecutive(backToBack([{ name: "a", components: 4 }]), (index) => {
      return `a_tB_pack${String(index)}`;
    });
    expect(packed[0].name).toBe("a_tB_pack0");
  });

  it("rejects overlapping fields", () => {
    expect(() =>
      packConsecutive(
        [
          { name: "a", components: 2, offset: 0 },
          { name: "b", components: 1, offset: 1 },
        ],
        pack,
      ),
    ).toThrow(/overlap/);
  });
});

describe("sparcoon/editor", () => {
  it("exports the one packing implementation", () => {
    expect(editor.packingOrder).toBe(packingOrder);
    expect(editor.packConsecutive).toBe(packConsecutive);
    expect(editor.slotLayout).toBe(slotLayout);
  });
});

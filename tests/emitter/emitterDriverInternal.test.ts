import { describe, expect, it } from "vitest";
import type { FXAttributeDecl, FXRenderArtifact } from "../../src/artifact/FXArtifact";
import { particleLayout } from "../../src/emitter/FXEmitterDriver.Internal";
import type { FXParticleLayout } from "../../src/render/FXArtifactMaterial.Internal";
import { particleSlotLayout, slotLayout } from "../../src/instancedParticle/FXParticleSlot";
import { unlitArtifact, VEC3_VARYING } from "../helpers/artifacts";

// The JS behavior's slot: the two core buffers and a float `seed`, by raw kernel name.
const SEED_BUFFERS = [
  { name: "position", stride: 3 },
  { name: "lifecycle", stride: 3 },
  { name: "seed", stride: 1 },
];

/** An unlit render declaring `decls` and reading every one in its vertex stage. */
function reading(decls: readonly FXAttributeDecl[]): FXRenderArtifact {
  return unlitArtifact({
    attributeReads: decls,
    vertexBody: decls.map((decl) => `float read_${decl.name} = float(p_fx_${decl.name});`),
  });
}

/** Each view's members, by name. */
function members(layout: FXParticleLayout): string[][] {
  return layout.packed.map((view) => view.members.map((member) => member.name));
}

describe("particleLayout", () => {
  it("packs what the render reads of the slot, under the mesh's property keys", () => {
    const slot = particleSlotLayout(SEED_BUFFERS);
    // position alone, then lifecycle + seed sharing a vec4.
    expect(members(particleLayout(slot, reading([{ name: "seed", components: 1 }])))).toEqual([
      ["position"],
      ["lifecycle", "fx_seed"],
    ]);
    // The core fields are always read; an unread seed is no member, and ends no view.
    const coreOnly = particleLayout(slot, unlitArtifact());
    expect(members(coreOnly)).toEqual([["position"], ["lifecycle"]]);
    expect(coreOnly.packed[1].components).toBe(3);
    expect(coreOnly.missing).toEqual({});
  });

  it("lets an unread field bridge two read ones into one view", () => {
    // Sort's Smoke slot, in packing order; its render reads tint, the core and the last four
    // floats. Packed whole, that is five views - velocity+grow and size+span+spin among them.
    const slot = particleSlotLayout([
      { name: "tint", stride: 4 },
      { name: "lifecycle", stride: 3 },
      { name: "drag", stride: 1 },
      { name: "position", stride: 3 },
      { name: "gravity", stride: 1 },
      { name: "velocity", stride: 3 },
      { name: "grow", stride: 1 },
      { name: "size", stride: 1 },
      { name: "span", stride: 1 },
      { name: "spin", stride: 1 },
    ]);
    const render = reading(
      ["tint", "grow", "size", "span", "spin"].map((name) => ({
        name,
        components: name === "tint" ? 4 : 1,
      })) as FXAttributeDecl[],
    );
    expect(members(particleLayout(slot, render))).toEqual([
      ["fx_tint"],
      ["lifecycle"],
      ["position"],
      ["fx_grow", "fx_size", "fx_span", "fx_spin"],
    ]);
  });

  it("makes a read nothing writes a missing (zero) field - no buffer, no view", () => {
    const layout = particleLayout(
      particleSlotLayout(SEED_BUFFERS),
      reading([
        { name: "seed", components: 1 },
        { name: "glow", components: 3 },
      ]),
    );
    expect(layout.missing).toEqual({ fx_glow: VEC3_VARYING });
    expect(members(layout).flat()).not.toContain("fx_glow");
  });

  it("reads a core buffer the slot lacks as zero too", () => {
    const slot = slotLayout([{ name: "position", components: 3 }]);
    const layout = particleLayout(slot, unlitArtifact());
    expect(Object.keys(layout.missing)).toEqual(["lifecycle"]);
    expect(layout.missing["lifecycle"]).toEqual(VEC3_VARYING);
    expect(members(layout)).toEqual([["position"]]);
  });

  it("throws when the render reads a held field at another width", () => {
    expect(() =>
      particleLayout(particleSlotLayout(SEED_BUFFERS), reading([{ name: "seed", components: 3 }])),
    ).toThrow(/conflicting widths/);
  });
});

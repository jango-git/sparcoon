import { describe, expect, it } from "vitest";
import {
  gpuHeldFields,
  jsHeldFields,
  particleLayout,
} from "../../src/emitter/FXEmitterDriver.Internal";
import { slotLayout } from "../../src/instancedParticle/FXTransformFeedbackParticle";
import { FLOAT_VARYING, VEC3_VARYING } from "../helpers/artifacts";

describe("particleLayout", () => {
  it("holds what the behavior writes, one view per field on the JS mesh", () => {
    const layout = particleLayout(jsHeldFields([{ name: "seed", components: 1 }]), []);
    expect(Object.keys(layout.fields)).toEqual(["position", "lifecycle", "fx_seed"]);
    expect(layout.packed.map((view) => view.name)).toEqual(["position", "lifecycle", "fx_seed"]);
    expect(layout.missing).toEqual({});
  });

  it("makes a read nothing writes a missing (zero) field - no buffer, no view", () => {
    const layout = particleLayout(jsHeldFields([{ name: "seed", components: 1 }]), [
      { name: "seed", components: 1 },
      { name: "glow", components: 3 },
    ]);
    expect(layout.missing).toEqual({ fx_glow: VEC3_VARYING });
    expect("fx_glow" in layout.fields).toBe(false);
    expect(layout.packed.some((view) => view.members.some((m) => m.name === "fx_glow"))).toBe(
      false,
    );
  });

  it("does the same over a GPU kernel's slot, through the slot's packed views", () => {
    const slot = slotLayout([
      { name: "position", components: 3 },
      { name: "lifecycle", components: 3 },
      { name: "fx_alpha", components: 1 },
    ]);
    const layout = particleLayout(gpuHeldFields(slot), [
      { name: "alpha", components: 1 },
      { name: "tint", components: 1 },
    ]);
    expect(layout.packed).toBe(slot.packed);
    expect(layout.fields["fx_alpha"]).toEqual(FLOAT_VARYING);
    expect(layout.missing).toEqual({ fx_tint: FLOAT_VARYING });
  });

  it("reads a core buffer the kernel lacks as zero too", () => {
    const slot = slotLayout([{ name: "position", components: 3 }]);
    const layout = particleLayout(gpuHeldFields(slot), []);
    expect(Object.keys(layout.missing)).toEqual(["lifecycle"]);
  });

  it("throws when the render reads a held field at another width", () => {
    expect(() =>
      particleLayout(jsHeldFields([{ name: "seed", components: 1 }]), [
        { name: "seed", components: 3 },
      ]),
    ).toThrow(/conflicting widths/);
  });
});

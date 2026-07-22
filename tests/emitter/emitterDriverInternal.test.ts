import { describe, expect, it } from "vitest";
import { sameVaryings } from "../../src/emitter/FXEmitterDriver.Internal";
import { FLOAT_VARYING, VEC3_VARYING } from "../helpers/artifacts";

describe("sameVaryings", () => {
  it("is true for two maps with the same names at the same width", () => {
    expect(
      sameVaryings(
        { fx_seed: FLOAT_VARYING, fx_offset: VEC3_VARYING },
        { fx_seed: FLOAT_VARYING, fx_offset: VEC3_VARYING },
      ),
    ).toBe(true);
  });

  it("is false when a name is missing from the other side", () => {
    expect(
      sameVaryings({ fx_seed: FLOAT_VARYING }, { fx_seed: FLOAT_VARYING, fx_offset: VEC3_VARYING }),
    ).toBe(false);
    expect(
      sameVaryings({ fx_seed: FLOAT_VARYING, fx_offset: VEC3_VARYING }, { fx_seed: FLOAT_VARYING }),
    ).toBe(false);
  });

  it("is false when a shared name's width disagrees", () => {
    expect(sameVaryings({ fx_seed: FLOAT_VARYING }, { fx_seed: VEC3_VARYING })).toBe(false);
  });

  it("is true for two empty maps", () => {
    expect(sameVaryings({}, {})).toBe(true);
  });
});

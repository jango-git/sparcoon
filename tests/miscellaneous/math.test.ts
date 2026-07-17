import { describe, expect, it } from "vitest";
import { linearToSRGB, srgbToLinear } from "../../src/miscellaneous/math";

// The sRGB <-> linear transfer must match three's GLSL curve exactly, since colors baked in one
// space are read back in the other.

describe("srgbToLinear / linearToSRGB", () => {
  it("fixes the endpoints 0 and 1", () => {
    expect(srgbToLinear(0)).toBeCloseTo(0, 12);
    expect(srgbToLinear(1)).toBeCloseTo(1, 6);
    expect(linearToSRGB(0)).toBeCloseTo(0, 12);
    expect(linearToSRGB(1)).toBeCloseTo(1, 6);
  });

  it("uses the linear segment below the piecewise threshold", () => {
    // srgbToLinear below 0.04045 is a plain scale by 0.0773993808.
    expect(srgbToLinear(0.04)).toBeCloseTo(0.04 * 0.0773993808, 12);
    // linearToSRGB below 0.0031308 is a plain scale by 12.92.
    expect(linearToSRGB(0.003)).toBeCloseTo(0.003 * 12.92, 12);
  });

  it("round-trips across the range within tolerance", () => {
    for (let i = 0; i <= 20; i++) {
      const c = i / 20;
      expect(linearToSRGB(srgbToLinear(c))).toBeCloseTo(c, 3);
    }
  });

  it("is monotonically increasing", () => {
    let previous = -1;
    for (let i = 0; i <= 40; i++) {
      const value = srgbToLinear(i / 40);
      expect(value).toBeGreaterThan(previous);
      previous = value;
    }
  });
});

import { describe, expect, it } from "vitest";
import { fxFract, fxMix, fxMod, fxSampleLut, fxSmoothstep } from "../../src/miscellaneous/fxMath";

// These are the CPU twins of the compiler's GLSL builtins and a frozen ABI: the editor's
// compiler prints calls to them by name. The golden values below pin the current arithmetic so
// an accidental change to any formula (which would silently desync the runtime from compiled
// kernels) fails a test instead of shipping.

describe("fxFract", () => {
  it("returns the fractional part for a positive input", () => {
    expect(fxFract(2.25)).toBeCloseTo(0.25, 12);
  });

  it("follows GLSL fract for a negative input (x - floor(x))", () => {
    expect(fxFract(-0.25)).toBeCloseTo(0.75, 12);
  });

  it("is zero at an integer", () => {
    expect(fxFract(5)).toBe(0);
  });
});

describe("fxMod", () => {
  it("matches GLSL mod for a positive dividend", () => {
    expect(fxMod(5, 3)).toBeCloseTo(2, 12);
    expect(fxMod(5.5, 2)).toBeCloseTo(1.5, 12);
  });

  it("returns a non-negative result for a negative dividend", () => {
    // -1 - 3 * floor(-1 / 3) = -1 - 3 * (-1) = 2
    expect(fxMod(-1, 3)).toBeCloseTo(2, 12);
  });
});

describe("fxMix", () => {
  it("returns the endpoints at t = 0 and t = 1", () => {
    expect(fxMix(2, 8, 0)).toBe(2);
    expect(fxMix(2, 8, 1)).toBe(8);
  });

  it("interpolates at the midpoint", () => {
    expect(fxMix(0, 10, 0.5)).toBeCloseTo(5, 12);
  });

  it("extrapolates outside [0, 1]", () => {
    expect(fxMix(0, 10, 2)).toBeCloseTo(20, 12);
    expect(fxMix(0, 10, -1)).toBeCloseTo(-10, 12);
  });
});

describe("fxSmoothstep", () => {
  it("clamps below edge0 and above edge1", () => {
    expect(fxSmoothstep(0, 1, -5)).toBe(0);
    expect(fxSmoothstep(0, 1, 5)).toBe(1);
  });

  it("is 0.5 at the midpoint and follows the Hermite curve", () => {
    expect(fxSmoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 12);
    // t = 0.25 -> t*t*(3 - 2t) = 0.0625 * 2.5 = 0.15625
    expect(fxSmoothstep(0, 1, 0.25)).toBeCloseTo(0.15625, 12);
  });

  it("increases monotonically across the transition", () => {
    let previous = -1;
    for (let i = 0; i <= 20; i++) {
      const value = fxSmoothstep(0, 1, i / 20);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });
});

describe("fxSampleLut", () => {
  it("returns the endpoints at t = 0 and t = 1", () => {
    expect(fxSampleLut([0, 10], 0)).toBe(0);
    expect(fxSampleLut([0, 10], 1)).toBe(10);
  });

  it("interpolates linearly between entries", () => {
    expect(fxSampleLut([0, 10], 0.5)).toBeCloseTo(5, 12);
    expect(fxSampleLut([0, 10, 20], 0.25)).toBeCloseTo(5, 12);
    expect(fxSampleLut([0, 10, 20], 0.75)).toBeCloseTo(15, 12);
  });

  it("lands exactly on an interior entry", () => {
    expect(fxSampleLut([0, 10, 20], 0.5)).toBe(10);
  });

  it("clamps t outside [0, 1]", () => {
    expect(fxSampleLut([0, 10], -1)).toBe(0);
    expect(fxSampleLut([0, 10], 2)).toBe(10);
  });

  it("returns the sole entry for a single-element LUT", () => {
    expect(fxSampleLut([7], 0)).toBe(7);
    expect(fxSampleLut([7], 0.5)).toBe(7);
    expect(fxSampleLut([7], 1)).toBe(7);
  });

  it("accepts a Float32Array LUT (the shape a curve binding carries)", () => {
    expect(fxSampleLut(new Float32Array([0, 4]), 0.5)).toBeCloseTo(2, 6);
  });
});

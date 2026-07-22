import { describe, expect, it } from "vitest";
import {
  fxFbm,
  fxFbm3,
  fxFract,
  fxMix,
  fxMod,
  fxNoise1,
  fxNoise2,
  fxNoise3,
  fxSampleLut,
  fxSmoothstep,
} from "../../src/miscellaneous/fxMath";

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

describe("fxNoise1", () => {
  it("is deterministic", () => {
    expect(fxNoise1(1.3)).toBe(fxNoise1(1.3));
  });

  it("pins its current output (frozen contract)", () => {
    expect(fxNoise1(3)).toBeCloseTo(0.03882420063, 8);
    expect(fxNoise1(0)).toBeCloseTo(-0.93075406551, 8);
  });

  it("stays within [-1, 1] across a wide sweep", () => {
    for (let i = 0; i < 5000; i++) {
      const v = fxNoise1(i * 0.137 - 300);
      expect(v).toBeGreaterThanOrEqual(-1.0001);
      expect(v).toBeLessThanOrEqual(1.0001);
    }
  });

  it("varies across space but is continuous (small step -> small change)", () => {
    const a = fxNoise1(3.2);
    const far = fxNoise1(9.8);
    const near = fxNoise1(3.2 + 1e-3);
    expect(Math.abs(a - far)).toBeGreaterThan(1e-3);
    expect(Math.abs(a - near)).toBeLessThan(1e-2);
  });
});

describe("fxNoise2 / fxNoise3", () => {
  it("are deterministic", () => {
    expect(fxNoise2(3.1, 4.2)).toBe(fxNoise2(3.1, 4.2));
    expect(fxNoise3(3.1, 4.2, -1.7)).toBe(fxNoise3(3.1, 4.2, -1.7));
  });

  it("pin their current output (frozen contract)", () => {
    expect(fxNoise2(1.5, -2.3)).toBeCloseTo(0.68699060917, 8);
    // At an integer coordinate the smoothing weight is 0, so noise(0,0) collapses to the same
    // corner hash fxNoise1(0) reads at i=0 - a cheap cross-dimension consistency check.
    expect(fxNoise2(0, 0)).toBeCloseTo(fxNoise1(0), 8);
    expect(fxNoise3(1.5, -2.3, 0.8)).toBeCloseTo(-0.49545084859, 8);
  });

  it("stay in [-1, 1] and actually vary across space", () => {
    let lo2 = Infinity;
    let hi2 = -Infinity;
    let lo3 = Infinity;
    let hi3 = -Infinity;
    for (let i = 0; i < 8000; i++) {
      const v2 = fxNoise2(i * 0.113 - 400, i * 0.071 + 3);
      const v3 = fxNoise3(i * 0.113 - 400, i * 0.071 + 3, i * 0.037 - 50);
      lo2 = Math.min(lo2, v2);
      hi2 = Math.max(hi2, v2);
      lo3 = Math.min(lo3, v3);
      hi3 = Math.max(hi3, v3);
    }
    expect(lo2).toBeGreaterThanOrEqual(-1.0001);
    expect(hi2).toBeLessThanOrEqual(1.0001);
    expect(lo2).toBeLessThan(-0.3);
    expect(hi2).toBeGreaterThan(0.3);
    expect(lo3).toBeGreaterThanOrEqual(-1.0001);
    expect(hi3).toBeLessThanOrEqual(1.0001);
    expect(lo3).toBeLessThan(-0.3);
    expect(hi3).toBeGreaterThan(0.3);
  });
});

describe("fxFbm", () => {
  it("is zero with no octaves and with a negative octave count (clamped to 0)", () => {
    expect(fxFbm(1.3, 0)).toBe(0);
    expect(fxFbm(1.3, -5)).toBe(0);
  });

  it("equals a single noise octave at octaves = 1", () => {
    expect(fxFbm(2.7, 1)).toBe(fxNoise1(2.7));
  });

  it("floors a fractional octave count", () => {
    expect(fxFbm(2.7, 2.9)).toBe(fxFbm(2.7, 2));
  });

  it("clamps to the 8-octave maximum", () => {
    expect(fxFbm(2.7, 100)).toBe(fxFbm(2.7, 8));
  });
});

describe("fxFbm3", () => {
  it("is zero with no octaves and with a negative octave count (clamped to 0)", () => {
    expect(fxFbm3(1.3, -0.4, 2.2, 0)).toBe(0);
    expect(fxFbm3(1.3, -0.4, 2.2, -5)).toBe(0);
  });

  it("equals a single noise3 octave at octaves = 1", () => {
    expect(fxFbm3(2.7, -1.1, 0.4, 1)).toBe(fxNoise3(2.7, -1.1, 0.4));
  });

  it("floors a fractional octave count", () => {
    expect(fxFbm3(2.7, -1.1, 0.4, 2.9)).toBe(fxFbm3(2.7, -1.1, 0.4, 2));
  });

  it("clamps to the 8-octave maximum", () => {
    expect(fxFbm3(2.7, -1.1, 0.4, 100)).toBe(fxFbm3(2.7, -1.1, 0.4, 8));
  });

  it("varies with every axis, not just the first", () => {
    const base = fxFbm3(1.0, 1.0, 1.0, 4);
    expect(fxFbm3(1.7, 1.0, 1.0, 4)).not.toBeCloseTo(base, 6);
    expect(fxFbm3(1.0, 1.7, 1.0, 4)).not.toBeCloseTo(base, 6);
    expect(fxFbm3(1.0, 1.0, 1.7, 4)).not.toBeCloseTo(base, 6);
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

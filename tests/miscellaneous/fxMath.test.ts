import { describe, expect, it } from "vitest";
import {
  fxFbm,
  fxFract,
  fxHash,
  fxMix,
  fxMod,
  fxSampleLut,
  fxSmoothstep,
  fxSnoise2,
  fxSnoise3,
  fxValueNoise,
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

describe("fxHash", () => {
  it("stays within [0, 1)", () => {
    for (let i = -50; i < 50; i++) {
      const h = fxHash(i * 0.37);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1);
    }
  });

  it("is deterministic and pins its current output (frozen contract)", () => {
    expect(fxHash(1)).toBe(fxHash(1));
    expect(fxHash(1)).toBeCloseTo(0.325623616, 8);
  });
});

describe("fxValueNoise", () => {
  it("equals fxHash(i) * 2 - 1 exactly at an integer (the smoothing weight is 0 there)", () => {
    for (const i of [0, 3, 7, -4]) {
      expect(fxValueNoise(i)).toBe(fxHash(i) * 2 - 1);
    }
  });

  it("pins its current output at a non-integer (frozen contract)", () => {
    expect(fxValueNoise(3)).toBeCloseTo(0.4523313459, 8);
  });

  it("stays within [-1, 1]", () => {
    for (let i = 0; i < 5000; i++) {
      const v = fxValueNoise(i * 0.137 - 300);
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe("fxFbm", () => {
  it("is zero with no octaves and with a negative octave count (clamped to 0)", () => {
    expect(fxFbm(1.3, 0)).toBe(0);
    expect(fxFbm(1.3, -5)).toBe(0);
  });

  it("equals a single value-noise octave at octaves = 1", () => {
    expect(fxFbm(2.7, 1)).toBe(fxValueNoise(2.7));
  });

  it("floors a fractional octave count", () => {
    expect(fxFbm(2.7, 2.9)).toBe(fxFbm(2.7, 2));
  });

  it("clamps to the 8-octave maximum", () => {
    expect(fxFbm(2.7, 100)).toBe(fxFbm(2.7, 8));
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

describe("fxSnoise2", () => {
  it("is exactly 0 at the origin and pins a sample point (frozen contract)", () => {
    expect(fxSnoise2(0, 0)).toBe(0);
    expect(fxSnoise2(1.5, -2.3)).toBeCloseTo(-0.0343609108, 8);
  });

  it("is deterministic", () => {
    expect(fxSnoise2(3.1, 4.2)).toBe(fxSnoise2(3.1, 4.2));
  });

  it("stays in roughly [-1, 1] and actually varies across the plane", () => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < 8000; i++) {
      const v = fxSnoise2(i * 0.113 - 400, i * 0.071 + 3);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    expect(lo).toBeGreaterThanOrEqual(-1.05);
    expect(hi).toBeLessThanOrEqual(1.05);
    expect(lo).toBeLessThan(-0.3);
    expect(hi).toBeGreaterThan(0.3);
  });
});

describe("fxSnoise3", () => {
  it("pins a sample point (frozen contract)", () => {
    expect(fxSnoise3(1.5, -2.3, 0.8)).toBeCloseTo(0.0735885175, 8);
  });

  it("is deterministic", () => {
    expect(fxSnoise3(3.1, 4.2, -1.7)).toBe(fxSnoise3(3.1, 4.2, -1.7));
  });

  it("stays in roughly [-1, 1] and actually varies across the volume", () => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < 8000; i++) {
      const v = fxSnoise3(i * 0.113 - 400, i * 0.071 + 3, i * 0.037 - 50);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    expect(lo).toBeGreaterThanOrEqual(-1.05);
    expect(hi).toBeLessThanOrEqual(1.05);
    expect(lo).toBeLessThan(-0.3);
    expect(hi).toBeGreaterThan(0.3);
  });
});

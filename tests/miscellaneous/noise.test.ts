import { describe, expect, it } from "vitest";

import { fxCurl2, fxCurl3 } from "../../src/miscellaneous/noise/fxCurlNoise";
import {
  fxFbm,
  fxFbm3,
  fxFractal1,
  fxFractal2,
  fxFractal3,
} from "../../src/miscellaneous/noise/fxFractalNoise";
import {
  fxSeedHash1,
  fxSeedHash2,
  fxSeedHash3,
  fxSeedHash4,
} from "../../src/miscellaneous/noise/fxSeedHash";
import { fxNoise1, fxNoise2, fxNoise3 } from "../../src/miscellaneous/noise/fxValueNoise";
import { fxVoronoi2, fxVoronoi3 } from "../../src/miscellaneous/noise/fxVoronoiNoise";

// Golden values pin the arithmetic: compiled kernels call these by name, so a silent formula
// change would desync the runtime from the editor preview.

describe("fxNoise1", () => {
  it("is deterministic", () => {
    expect(fxNoise1(1.3)).toBe(fxNoise1(1.3));
  });

  it("pins its current output (frozen contract)", () => {
    expect(fxNoise1(3)).toBeCloseTo(-0.00735592842, 8);
    expect(fxNoise1(0)).toBeCloseTo(-0.93960011005, 8);
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
    expect(fxNoise2(1.5, -2.3)).toBeCloseTo(-0.04310804892, 8);
    // At an integer coordinate the smoothing weight is 0, so noise(0,0) collapses to the same
    // corner hash fxNoise1(0) reads at i=0 - a cheap cross-dimension consistency check.
    expect(fxNoise2(0, 0)).toBeCloseTo(fxNoise1(0), 8);
    expect(fxNoise3(1.5, -2.3, 0.8)).toBeCloseTo(0.27179907718, 8);
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

describe("fxFractal1/2/3", () => {
  it("is a single noise octave at octaves = 1, 0 at none", () => {
    expect(fxFractal1(2.7, 1, 2, 0.5)).toBe(fxNoise1(2.7));
    expect(fxFractal2(2.7, -1.1, 1, 2, 0.5)).toBe(fxNoise2(2.7, -1.1));
    expect(fxFractal3(2.7, -1.1, 0.4, 1, 2, 0.5)).toBe(fxNoise3(2.7, -1.1, 0.4));
    expect(fxFractal3(2.7, -1.1, 0.4, 0, 2, 0.5)).toBe(0);
  });

  it("stays normalized to [-1, 1]", () => {
    for (let i = 0; i < 2000; i++) {
      const v = fxFractal3(i * 0.113 - 40, i * 0.071, i * -0.037, 6, 2, 0.8);
      expect(Math.abs(v)).toBeLessThanOrEqual(1.0001);
    }
  });
});

describe("fxCurl2 / fxCurl3", () => {
  it("is deterministic per component, independent of call order (memo)", () => {
    const x = fxCurl3(1.3, -0.7, 2.2, 3, 2, 0.5, 0);
    fxCurl3(9.1, 4.4, -3.3, 3, 2, 0.5, 1);
    expect(fxCurl3(1.3, -0.7, 2.2, 3, 2, 0.5, 0)).toBe(x);
    expect(fxCurl2(1.3, -0.7, 2, 2, 0.5, 1)).toBe(fxCurl2(1.3, -0.7, 2, 2, 0.5, 1));
  });

  it("is the rotated gradient of noise in 2D", () => {
    const h = 1e-5;
    const dx = (fxNoise2(1.37 + h, -0.61) - fxNoise2(1.37 - h, -0.61)) / (2 * h);
    const dy = (fxNoise2(1.37, -0.61 + h) - fxNoise2(1.37, -0.61 - h)) / (2 * h);
    expect(fxCurl2(1.37, -0.61, 1, 2, 0.5, 0)).toBeCloseTo(dy, 4);
    expect(fxCurl2(1.37, -0.61, 1, 2, 0.5, 1)).toBeCloseTo(-dx, 4);
  });
});

describe("fxVoronoi2 / fxVoronoi3", () => {
  it("orders F1 <= F2 and keeps the cell value in [0, 1)", () => {
    for (let i = 0; i < 500; i++) {
      for (const [quality, metric] of [
        [0, 0],
        [1, 1],
        [1, 2],
      ]) {
        const x = i * 0.731 - 90;
        const y = i * 0.417;
        const f1 = fxVoronoi3(x, y, -x, 0.8, quality, metric, 0);
        const f2 = fxVoronoi3(x, y, -x, 0.8, quality, metric, 1);
        const cell = fxVoronoi2(x, y, 0.8, quality, metric, 2);
        expect(f2).toBeGreaterThanOrEqual(f1);
        expect(cell).toBeGreaterThanOrEqual(0);
        expect(cell).toBeLessThan(1);
      }
    }
  });

  it("is the regular grid of cell centers at zero jitter", () => {
    expect(fxVoronoi2(3.5, -1.5, 0, 1, 0, 0)).toBe(0);
    expect(fxVoronoi2(3.5, -1.5, 0, 1, 0, 1)).toBe(1);
  });
});

describe("fxSeedHash1..4", () => {
  it("pin their current output (frozen contract)", () => {
    expect(fxSeedHash1(0, 0, 0, 0)).toBe(0.19039934873580933);
    expect(fxSeedHash1(7, 0, 0, 3)).toBe(0.9653053283691406);
    expect(fxSeedHash2(1.5, -2.25, 0, 0, 0)).toBe(0.26789677143096924);
    expect(fxSeedHash2(1.5, -2.25, 0, 0, 1)).toBe(0.016468703746795654);
    expect(fxSeedHash4(3, 1, -1, 2, 0)).toBe(0.778420090675354);
    expect(fxSeedHash4(3, 1, -1, 2, 3)).toBe(0.5215178728103638);
  });

  it("share their leading components across widths", () => {
    const first = fxSeedHash1(4.25, -1, 9, 5);
    expect(fxSeedHash2(4.25, -1, 9, 5, 0)).toBe(first);
    expect(fxSeedHash4(4.25, -1, 9, 5, 0)).toBe(first);
    expect(fxSeedHash4(4.25, -1, 9, 5, 2)).toBe(fxSeedHash3(4.25, -1, 9, 5, 2));
  });

  it("stay in [0, 1) and give another draw for another seed or salt", () => {
    for (let i = 0; i < 2000; i++) {
      for (let c = 0; c < 4; c++) {
        const v = fxSeedHash4(i, i * 0.5, -i, i % 3, c);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
      }
    }
    expect(fxSeedHash1(1, 0, 0, 0)).not.toBe(fxSeedHash1(2, 0, 0, 0));
    expect(fxSeedHash1(1, 0, 0, 0)).not.toBe(fxSeedHash1(1, 0, 0, 1));
  });

  it("recompute when interleaved with other arguments (memo is per call)", () => {
    const a = fxSeedHash3(1, 2, 3, 0, 1);
    fxSeedHash3(4, 5, 6, 0, 1);
    expect(fxSeedHash3(1, 2, 3, 0, 1)).toBe(a);
  });
});

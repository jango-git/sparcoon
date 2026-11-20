import { describe, expect, it } from "vitest";

import { fxRandom } from "../../src/helpers/fxRandom";

describe("fxRandom", () => {
  it("pins its current output (frozen contract)", () => {
    expect(fxRandom(0, 0, 0)).toBe(0.030199944972991943);
    expect(fxRandom(1, 0, 0)).toBe(0.5448718070983887);
    expect(fxRandom(0, 1, 0)).toBe(0.3441338539123535);
    expect(fxRandom(0, 0, 1)).toBe(0.40804845094680786);
    expect(fxRandom(12345, 7, 3)).toBe(0.8656291961669922);
  });

  it("stays in [0, 1) with a mean near 0.5", () => {
    let sum = 0;
    const draws = 30_000;
    for (let i = 0; i < draws; i++) {
      const value = fxRandom(i, i >>> 4, i % 7);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      sum += value;
    }
    expect(sum / draws).toBeCloseTo(0.5, 2);
  });

  it("gives another draw for the next particle, seed or draw", () => {
    for (let i = 0; i < 1000; i++) {
      const value = fxRandom(i, i * 3, i % 11);
      expect(fxRandom(i + 1, i * 3, i % 11)).not.toBe(value);
      expect(fxRandom(i, i * 3 + 1, i % 11)).not.toBe(value);
      expect(fxRandom(i, i * 3, (i % 11) + 1)).not.toBe(value);
    }
  });
});

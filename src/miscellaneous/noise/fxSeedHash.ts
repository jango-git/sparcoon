import { argumentsChanged, createKey } from "./fxNoiseMemo.js";
import { pcg, seedKey, unit } from "./fxNoiseHash.js";

/**
 * Seed hash: 1-4 independent [0, 1) values of a point `(x, y, z)` and a `salt` - a stable random
 * per particle id or attribute. Hashes the floats' bits, so any two distinct seeds decorrelate.
 * Each further component is one more PCG round. `component` selects the output.
 */

export function fxSeedHash1(x: number, y: number, z: number, salt: number): number {
  return unit(seedKey(x, y, z, salt));
}

function fill(result: Float64Array, x: number, y: number, z: number, salt: number): void {
  let h = seedKey(x, y, z, salt);
  result[0] = unit(h);
  for (let i = 1; i < result.length; i++) {
    h = pcg(h);
    result[i] = unit(h);
  }
}

const key2 = createKey();
const result2 = new Float64Array(2);

export function fxSeedHash2(
  x: number,
  y: number,
  z: number,
  salt: number,
  component: number,
): number {
  if (argumentsChanged(key2, x, y, z, salt, 0, 0)) {
    fill(result2, x, y, z, salt);
  }
  return result2[component];
}

const key3 = createKey();
const result3 = new Float64Array(3);

export function fxSeedHash3(
  x: number,
  y: number,
  z: number,
  salt: number,
  component: number,
): number {
  if (argumentsChanged(key3, x, y, z, salt, 0, 0)) {
    fill(result3, x, y, z, salt);
  }
  return result3[component];
}

const key4 = createKey();
const result4 = new Float64Array(4);

export function fxSeedHash4(
  x: number,
  y: number,
  z: number,
  salt: number,
  component: number,
): number {
  if (argumentsChanged(key4, x, y, z, salt, 0, 0)) {
    fill(result4, x, y, z, salt);
  }
  return result4[component];
}

import { fxNoise1, fxNoise2, fxNoise3 } from "./fxValueNoise.js";

/** Must match the editor compiler's loop bound: a value parameter can rebind to any number. */
export const FBM_MAX_OCTAVES = 8;
/** Domain shift between octaves. */
export const OCTAVE_SHIFT = 7.31;

export function octaveCount(octaves: number): number {
  return Math.min(Math.max(Math.floor(octaves), 0), FBM_MAX_OCTAVES);
}

/**
 * Normalized fBm: sum of noise(p_k) * gain^k over octaves, divided by the total amplitude, with
 * p_k = p_(k-1) * lacunarity + shift. Range [-1, 1]; 0 for zero octaves.
 */
export function fxFractal1(x: number, octaves: number, lacunarity: number, gain: number): number {
  const n = octaveCount(octaves);
  let sum = 0;
  let amplitude = 1;
  let total = 0;
  for (let k = 0; k < n; k++) {
    sum += fxNoise1(x) * amplitude;
    total += amplitude;
    amplitude *= gain;
    x = x * lacunarity + OCTAVE_SHIFT;
  }
  return total > 0 ? sum / total : 0;
}

export function fxFractal2(
  x: number,
  y: number,
  octaves: number,
  lacunarity: number,
  gain: number,
): number {
  const n = octaveCount(octaves);
  let sum = 0;
  let amplitude = 1;
  let total = 0;
  for (let k = 0; k < n; k++) {
    sum += fxNoise2(x, y) * amplitude;
    total += amplitude;
    amplitude *= gain;
    x = x * lacunarity + OCTAVE_SHIFT;
    y = y * lacunarity + OCTAVE_SHIFT;
  }
  return total > 0 ? sum / total : 0;
}

export function fxFractal3(
  x: number,
  y: number,
  z: number,
  octaves: number,
  lacunarity: number,
  gain: number,
): number {
  const n = octaveCount(octaves);
  let sum = 0;
  let amplitude = 1;
  let total = 0;
  for (let k = 0; k < n; k++) {
    sum += fxNoise3(x, y, z) * amplitude;
    total += amplitude;
    amplitude *= gain;
    x = x * lacunarity + OCTAVE_SHIFT;
    y = y * lacunarity + OCTAVE_SHIFT;
    z = z * lacunarity + OCTAVE_SHIFT;
  }
  return total > 0 ? sum / total : 0;
}

/** Total amplitude of `n` octaves at gain 0.5: 2 * (1 - 0.5^n). */
function halfGainTotal(octaves: number): number {
  return 2 * (1 - Math.pow(0.5, octaveCount(octaves)));
}

/** Unnormalized fBm (gain 0.5, lacunarity 2). Kept for kernels compiled before `fxFractal1`. */
export function fxFbm(x: number, octaves: number): number {
  return fxFractal1(x, octaves, 2, 0.5) * halfGainTotal(octaves);
}

/** 3D {@link fxFbm}. Kept for kernels compiled before `fxFractal3`. */
export function fxFbm3(x: number, y: number, z: number, octaves: number): number {
  return fxFractal3(x, y, z, octaves, 2, 0.5) * halfGainTotal(octaves);
}

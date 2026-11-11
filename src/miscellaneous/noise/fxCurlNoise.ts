import { octaveCount, OCTAVE_SHIFT } from "./fxFractalNoise.js";
import { argumentsChanged, createKey } from "./fxNoiseMemo.js";
import { fxNoised2, fxNoised3, noisedOut } from "./fxValueNoise.js";

/**
 * Curl noise, summed over octaves like {@link fxFractal2}:
 * - 2D: (dpsi/dy, -dpsi/dx) of the potential psi = noise(p);
 * - 3D: curl of (psi1, psi2, psi3), sampled at p, p + PSI_2, p + PSI_3.
 * `component` selects the output axis.
 */

const PSI_2 = [31.416, 12.703, 5.906] as const;
const PSI_3 = [-43.28, 27.13, -19.87] as const;

const key2 = createKey();
const result2 = new Float64Array(2);

export function fxCurl2(
  x: number,
  y: number,
  octaves: number,
  lacunarity: number,
  gain: number,
  component: number,
): number {
  if (argumentsChanged(key2, x, y, octaves, lacunarity, gain, 0)) {
    const n = octaveCount(octaves);
    let sx = 0;
    let sy = 0;
    let amplitude = 1;
    let total = 0;
    for (let k = 0; k < n; k++) {
      fxNoised2(x, y);
      sx += noisedOut[2] * amplitude;
      sy -= noisedOut[1] * amplitude;
      total += amplitude;
      amplitude *= gain;
      x = x * lacunarity + OCTAVE_SHIFT;
      y = y * lacunarity + OCTAVE_SHIFT;
    }
    result2[0] = total > 0 ? sx / total : 0;
    result2[1] = total > 0 ? sy / total : 0;
  }
  return result2[component];
}

const key3 = createKey();
const result3 = new Float64Array(3);

export function fxCurl3(
  x: number,
  y: number,
  z: number,
  octaves: number,
  lacunarity: number,
  gain: number,
  component: number,
): number {
  if (argumentsChanged(key3, x, y, z, octaves, lacunarity, gain)) {
    const n = octaveCount(octaves);
    let sx = 0;
    let sy = 0;
    let sz = 0;
    let amplitude = 1;
    let total = 0;
    for (let k = 0; k < n; k++) {
      fxNoised3(x, y, z);
      const a2 = noisedOut[2];
      const a3 = noisedOut[3];
      fxNoised3(x + PSI_2[0], y + PSI_2[1], z + PSI_2[2]);
      const b1 = noisedOut[1];
      const b3 = noisedOut[3];
      fxNoised3(x + PSI_3[0], y + PSI_3[1], z + PSI_3[2]);
      const c1 = noisedOut[1];
      const c2 = noisedOut[2];
      sx += (c2 - b3) * amplitude;
      sy += (a3 - c1) * amplitude;
      sz += (b1 - a2) * amplitude;
      total += amplitude;
      amplitude *= gain;
      x = x * lacunarity + OCTAVE_SHIFT;
      y = y * lacunarity + OCTAVE_SHIFT;
      z = z * lacunarity + OCTAVE_SHIFT;
    }
    result3[0] = total > 0 ? sx / total : 0;
    result3[1] = total > 0 ? sy / total : 0;
    result3[2] = total > 0 ? sz / total : 0;
  }
  return result3[component];
}

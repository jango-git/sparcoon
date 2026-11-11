import { LATTICE_P0, LATTICE_P1, LATTICE_P2, pcg, unit } from "./fxNoiseHash.js";
import { argumentsChanged, createKey } from "./fxNoiseMemo.js";

/**
 * Voronoi noise: one feature point per cell at `cell + 0.5 + jitter * (h - 0.5)`. Component
 * 0 = F1 (nearest distance), 1 = F2 (second nearest), 2 = [0, 1) value of F1's cell. `quality`
 * 0 searches the 2^N cells around `p`, 1 the 3^N; `metric` 0 euclidean, 1 manhattan, 2 chebyshev.
 */

/** One 32-bit cell hash split into jitter: 2D 16 + 16 bits, 3D 10 + 11 + 11. */
const UNIT_16 = 1 / 65536;
const UNIT_11 = 1 / 2048;
const UNIT_10 = 1 / 1024;
/** Odd multiplier remixing the winning cell's hash into its id. */
const ID_MIX = 2654435769;

/**
 * Writes `(F1, F2, cellId)` to `out`; 2D passes `z = 0` and never reads it. Mirrors the
 * compiler's standard GLSL op for op: `r = o + c + jitter * h` with `c = 0.5 - 0.5 * jitter - f`.
 */
function search(
  out: Float64Array,
  dimensions: 2 | 3,
  x: number,
  y: number,
  z: number,
  jitter: number,
  quality: number,
  metric: number,
): void {
  const span = quality === 0 ? 2 : 3;
  const spanZ = dimensions === 3 ? span : 1;
  const bx = quality === 0 ? Math.floor(x - 0.5) : Math.floor(x) - 1;
  const by = quality === 0 ? Math.floor(y - 0.5) : Math.floor(y) - 1;
  const bz = dimensions === 2 ? 0 : quality === 0 ? Math.floor(z - 0.5) : Math.floor(z) - 1;
  const cx = 0.5 - 0.5 * jitter - (x - bx);
  const cy = 0.5 - 0.5 * jitter - (y - by);
  const cz = 0.5 - 0.5 * jitter - (z - bz);
  const lx = Math.imul(bx | 0, LATTICE_P0);
  const ly = Math.imul(by | 0, LATTICE_P1);
  const lz = dimensions === 3 ? Math.imul(bz | 0, LATTICE_P2) : 0;
  let f1 = 1e4;
  let f2 = 1e4;
  let best = 0;
  for (let oz = 0; oz < spanZ; oz++) {
    const tz = dimensions === 3 ? (lz + Math.imul(oz, LATTICE_P2)) | 0 : 0;
    for (let oy = 0; oy < span; oy++) {
      const ty = (ly + Math.imul(oy, LATTICE_P1)) | 0;
      for (let ox = 0; ox < span; ox++) {
        const t = pcg(((lx + Math.imul(ox, LATTICE_P0)) | 0) ^ ty ^ tz);
        let hx: number;
        let hy: number;
        let rz = 0;
        if (dimensions === 2) {
          hx = (t >>> 16) * UNIT_16;
          hy = (t & 65535) * UNIT_16;
        } else {
          hx = (t >>> 22) * UNIT_10;
          hy = ((t >>> 11) & 2047) * UNIT_11;
          rz = oz + cz + jitter * ((t & 2047) * UNIT_11);
        }
        const rx = ox + cx + jitter * hx;
        const ry = oy + cy + jitter * hy;
        // Monotone distance: squared for euclidean, rooted once below.
        const distance =
          metric === 0
            ? rx * rx + ry * ry + rz * rz
            : metric === 1
              ? Math.abs(rx) + Math.abs(ry) + Math.abs(rz)
              : Math.max(Math.abs(rx), Math.abs(ry), Math.abs(rz));
        if (distance < f1) {
          best = t;
        }
        f2 = Math.min(f2, Math.max(f1, distance));
        f1 = Math.min(f1, distance);
      }
    }
  }
  if (metric === 0) {
    f1 = Math.sqrt(f1);
    f2 = Math.sqrt(f2);
  }
  out[0] = f1;
  out[1] = f2;
  out[2] = unit(Math.imul(best, ID_MIX));
}

const key2 = createKey();
const result2 = new Float64Array(3);

export function fxVoronoi2(
  x: number,
  y: number,
  jitter: number,
  quality: number,
  metric: number,
  component: number,
): number {
  if (argumentsChanged(key2, x, y, jitter, quality, metric, 0)) {
    search(result2, 2, x, y, 0, jitter, quality, metric);
  }
  return result2[component];
}

const key3 = createKey();
const result3 = new Float64Array(3);

export function fxVoronoi3(
  x: number,
  y: number,
  z: number,
  jitter: number,
  quality: number,
  metric: number,
  component: number,
): number {
  if (argumentsChanged(key3, x, y, z, jitter, quality, metric)) {
    search(result3, 3, x, y, z, jitter, quality, metric);
  }
  return result3[component];
}

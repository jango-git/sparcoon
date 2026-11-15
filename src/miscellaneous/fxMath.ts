/**
 * CPU-side twins of the compiler's math builtins (`fxMix`, `fxSmoothstep`, ...; noise lives in
 * `noise/`). A behavior kernel's authored `spawn`/`update` body calls these by name - the editor's
 * compiler prints those exact calls - so every exported name here is a frozen contract with
 * already-compiled kernels, like the `a_`/`p_` buffer prefixes. Never rename one without updating
 * the compiler side in lockstep.
 */

import { FX_VOLUME_HEADER_FLOATS } from "../volumeTableLayout.js";

export function fxFract(x: number): number {
  return x - Math.floor(x);
}

export function fxMod(a: number, b: number): number {
  return a - b * Math.floor(a / b);
}

export function fxMix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function fxSmoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0.0), 1.0);
  return t * t * (3.0 - 2.0 * t);
}

/** Linearly samples a curve LUT at `t` in [0, 1] (clamped), interpolating between entries. */
export function fxSampleLut(lut: ArrayLike<number>, t: number): number {
  const length = lut.length;
  const last = length - 1;
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = clamped * last;
  const i = Math.floor(x);
  const fraction = x - i;
  const lowerValue = lut[i];
  const upperValue = lut[i + 1 < length ? i + 1 : last];
  return lowerValue + (upperValue - lowerValue) * fraction;
}

/**
 * Samples a volume table (`volumeTableLayout.ts`) at texture coordinates `(u, v, w)` - the
 * trilinear blend of the 8 texels around them, texel centres at `(i + 0.5) / size`, clamped to the
 * edge texels - what the GPU's linear sampler returns for the R8 3D texture.
 */
export function fxVolumeFetch(table: ArrayLike<number>, u: number, v: number, w: number): number {
  const nx = table[0];
  const ny = table[1];
  const nz = table[2];
  const x = Math.min(Math.max(u * nx - 0.5, 0), nx - 1);
  const y = Math.min(Math.max(v * ny - 0.5, 0), ny - 1);
  const z = Math.min(Math.max(w * nz - 0.5, 0), nz - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const fx = x - x0;
  const fy = y - y0;
  const fz = z - z0;
  const dx = x0 + 1 < nx ? 1 : 0;
  const dy = y0 + 1 < ny ? nx : 0;
  const dz = z0 + 1 < nz ? nx * ny : 0;
  const i = FX_VOLUME_HEADER_FLOATS + x0 + nx * (y0 + ny * z0);
  const a = table[i] + (table[i + dx] - table[i]) * fx;
  const b = table[i + dy] + (table[i + dy + dx] - table[i + dy]) * fx;
  const c = table[i + dz] + (table[i + dz + dx] - table[i + dz]) * fx;
  const d = table[i + dz + dy] + (table[i + dz + dy + dx] - table[i + dz + dy]) * fx;
  const near = a + (b - a) * fy;
  return near + (c + (d - c) * fy - near) * fz;
}

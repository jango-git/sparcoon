import { LATTICE_P0, LATTICE_P1, LATTICE_P2, pcg, unit } from "./fxNoiseHash.js";

/**
 * Value noise in [-1, 1]: hashed cell corners blended with smoothstep weights. Op order matches
 * the editor's JS helpers, so the preview and an exported effect agree. Unrolled per dimension:
 * this is the CPU simulation's hot path.
 */

/** Scratch outputs of {@link fxNoised2} / {@link fxNoised3}: value, then d/dx, d/dy, d/dz. */
export const noisedOut = new Float64Array(4);

export function fxNoise1(x: number): number {
  const fl = Math.floor(x);
  const t = x - fl;
  const u = t * t * (3 - 2 * t);
  const l0 = fl | 0;
  const c0 = unit(pcg(l0));
  const c1 = unit(pcg((l0 + 1) | 0));
  return (c0 + (c1 - c0) * u) * 2 - 1;
}

export function fxNoise2(x: number, y: number): number {
  const fx = Math.floor(x);
  const tx = x - fx;
  const ux = tx * tx * (3 - 2 * tx);
  const x0 = Math.imul(fx | 0, LATTICE_P0);
  const x1 = (x0 + LATTICE_P0) | 0;
  const fy = Math.floor(y);
  const ty = y - fy;
  const uy = ty * ty * (3 - 2 * ty);
  const y0 = Math.imul(fy | 0, LATTICE_P1);
  const y1 = (y0 + LATTICE_P1) | 0;
  const c0 = unit(pcg(x0 ^ y0));
  const c1 = unit(pcg(x1 ^ y0));
  const c2 = unit(pcg(x0 ^ y1));
  const c3 = unit(pcg(x1 ^ y1));
  const a = c0 + (c1 - c0) * ux;
  const b = c2 + (c3 - c2) * ux;
  return (a + (b - a) * uy) * 2 - 1;
}

export function fxNoise3(x: number, y: number, z: number): number {
  const fx = Math.floor(x);
  const tx = x - fx;
  const ux = tx * tx * (3 - 2 * tx);
  const x0 = Math.imul(fx | 0, LATTICE_P0);
  const x1 = (x0 + LATTICE_P0) | 0;
  const fy = Math.floor(y);
  const ty = y - fy;
  const uy = ty * ty * (3 - 2 * ty);
  const y0 = Math.imul(fy | 0, LATTICE_P1);
  const y1 = (y0 + LATTICE_P1) | 0;
  const fz = Math.floor(z);
  const tz = z - fz;
  const uz = tz * tz * (3 - 2 * tz);
  const z0 = Math.imul(fz | 0, LATTICE_P2);
  const z1 = (z0 + LATTICE_P2) | 0;
  const c0 = unit(pcg(x0 ^ y0 ^ z0));
  const c1 = unit(pcg(x1 ^ y0 ^ z0));
  const c2 = unit(pcg(x0 ^ y1 ^ z0));
  const c3 = unit(pcg(x1 ^ y1 ^ z0));
  const c4 = unit(pcg(x0 ^ y0 ^ z1));
  const c5 = unit(pcg(x1 ^ y0 ^ z1));
  const c6 = unit(pcg(x0 ^ y1 ^ z1));
  const c7 = unit(pcg(x1 ^ y1 ^ z1));
  const a = c0 + (c1 - c0) * ux;
  const b = c2 + (c3 - c2) * ux;
  const c = c4 + (c5 - c4) * ux;
  const d = c6 + (c7 - c6) * ux;
  const ab = a + (b - a) * uy;
  const cd = c + (d - c) * uy;
  return (ab + (cd - ab) * uz) * 2 - 1;
}

/** Value and analytic gradient (polynomial form of the bilinear blend), into {@link noisedOut}. */
export function fxNoised2(x: number, y: number): void {
  const fx = Math.floor(x);
  const tx = x - fx;
  const ux = tx * tx * (3 - 2 * tx);
  const x0 = Math.imul(fx | 0, LATTICE_P0);
  const x1 = (x0 + LATTICE_P0) | 0;
  const fy = Math.floor(y);
  const ty = y - fy;
  const uy = ty * ty * (3 - 2 * ty);
  const y0 = Math.imul(fy | 0, LATTICE_P1);
  const y1 = (y0 + LATTICE_P1) | 0;
  const c0 = unit(pcg(x0 ^ y0));
  const c1 = unit(pcg(x1 ^ y0));
  const c2 = unit(pcg(x0 ^ y1));
  const c3 = unit(pcg(x1 ^ y1));
  const dx = 6 * tx * (1 - tx);
  const dy = 6 * ty * (1 - ty);
  const k1 = c1 - c0;
  const k2 = c2 - c0;
  const k3 = c0 - c1 - c2 + c3;
  noisedOut[0] = (c0 + k1 * ux + k2 * uy + k3 * ux * uy) * 2 - 1;
  noisedOut[1] = dx * (k1 + k3 * uy) * 2;
  noisedOut[2] = dy * (k2 + k3 * ux) * 2;
}

/** 3D twin of {@link fxNoised2} (trilinear blend). */
export function fxNoised3(x: number, y: number, z: number): void {
  const fx = Math.floor(x);
  const tx = x - fx;
  const ux = tx * tx * (3 - 2 * tx);
  const x0 = Math.imul(fx | 0, LATTICE_P0);
  const x1 = (x0 + LATTICE_P0) | 0;
  const fy = Math.floor(y);
  const ty = y - fy;
  const uy = ty * ty * (3 - 2 * ty);
  const y0 = Math.imul(fy | 0, LATTICE_P1);
  const y1 = (y0 + LATTICE_P1) | 0;
  const fz = Math.floor(z);
  const tz = z - fz;
  const uz = tz * tz * (3 - 2 * tz);
  const z0 = Math.imul(fz | 0, LATTICE_P2);
  const z1 = (z0 + LATTICE_P2) | 0;
  const c0 = unit(pcg(x0 ^ y0 ^ z0));
  const c1 = unit(pcg(x1 ^ y0 ^ z0));
  const c2 = unit(pcg(x0 ^ y1 ^ z0));
  const c3 = unit(pcg(x1 ^ y1 ^ z0));
  const c4 = unit(pcg(x0 ^ y0 ^ z1));
  const c5 = unit(pcg(x1 ^ y0 ^ z1));
  const c6 = unit(pcg(x0 ^ y1 ^ z1));
  const c7 = unit(pcg(x1 ^ y1 ^ z1));
  const dx = 6 * tx * (1 - tx);
  const dy = 6 * ty * (1 - ty);
  const dz = 6 * tz * (1 - tz);
  const k1 = c1 - c0;
  const k2 = c2 - c0;
  const k3 = c4 - c0;
  const k4 = c0 - c1 - c2 + c3;
  const k5 = c0 - c2 - c4 + c6;
  const k6 = c0 - c1 - c4 + c5;
  const k7 = -c0 + c1 + c2 - c3 + c4 - c5 - c6 + c7;
  noisedOut[0] =
    (c0 +
      k1 * ux +
      k2 * uy +
      k3 * uz +
      k4 * ux * uy +
      k5 * uy * uz +
      k6 * uz * ux +
      k7 * ux * uy * uz) *
      2 -
    1;
  noisedOut[1] = dx * (k1 + k4 * uy + k6 * uz + k7 * uy * uz) * 2;
  noisedOut[2] = dy * (k2 + k5 * uz + k4 * ux + k7 * uz * ux) * 2;
  noisedOut[3] = dz * (k3 + k6 * ux + k5 * uy + k7 * ux * uy) * 2;
}

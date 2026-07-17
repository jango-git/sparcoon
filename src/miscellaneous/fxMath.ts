/**
 * CPU-side twins of the compiler's math/noise builtins (`fxMix`, `fxSnoise3`, ...). A behavior
 * kernel's authored `spawn`/`update` body calls these by name - the editor's compiler prints those
 * exact calls - so every exported name here is a frozen contract with already-compiled kernels,
 * like the `a_`/`p_` buffer prefixes. Never rename one without updating the compiler side in
 * lockstep.
 */

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

export function fxHash(n: number): number {
  const s = Math.sin(n * 127.1) * 43758.5453123;
  return s - Math.floor(s);
}

/** Cheap deterministic 1D value-noise (smoothed hash interpolation), range [-1, 1]. */
export function fxValueNoise(x: number): number {
  const i = Math.floor(x);
  const fractional = x - i;
  const u = fractional * fractional * (3 - 2 * fractional);
  return (fxHash(i) * (1 - u) + fxHash(i + 1) * u) * 2 - 1;
}

// Mirrors FBM_MAX_OCTAVES in the editor engine: clamps a runaway octave count (a
// value parameter rebinds with no recompile/sanity gate) so it cannot blow up the update kernel.
const FBM_MAX_OCTAVES = 8;

/** Fractal Brownian motion over {@link fxValueNoise} (gain 0.5, lacunarity 2). */
export function fxFbm(x: number, octaves: number): number {
  const octaveCount = Math.min(Math.max(Math.floor(octaves), 0), FBM_MAX_OCTAVES);
  let sum = 0;
  let amplitude = 1;
  let frequency = 1;
  for (let i = 0; i < octaveCount; i += 1) {
    sum += fxValueNoise(x * frequency) * amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return sum;
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

// Ashima/Gustavson simplex-noise sub-helpers (mod289/permute/fract), private to fxSnoise2/3.
function fxsnMod289(x: number): number {
  return x - Math.floor(x * (1.0 / 289.0)) * 289.0;
}

function fxsnPermute(x: number): number {
  return fxsnMod289((x * 34.0 + 1.0) * x);
}

function fxsnFract(x: number): number {
  return x - Math.floor(x);
}

/**
 * Ashima/Gustavson "webgl-noise" simplex noise, 2D - the CPU twin of the compiler's GLSL `snoise`
 * helper. Component arguments (rather than a vector) so it mirrors how the scalarized JS backend calls
 * it; the arithmetic tracks the GLSL version op-for-op. Output is roughly `[-1, 1]`.
 */
export function fxSnoise2(vx: number, vy: number): number {
  const cx = 0.211324865405187;
  const cy = 0.366025403784439;
  const cz = -0.577350269189626;
  const cw = 0.024390243902439;
  const s = (vx + vy) * cy;
  let ix = Math.floor(vx + s);
  let iy = Math.floor(vy + s);
  const t = (ix + iy) * cx;
  const x0x = vx - ix + t;
  const x0y = vy - iy + t;
  let i1x: number;
  let i1y: number;
  if (x0x > x0y) {
    i1x = 1.0;
    i1y = 0.0;
  } else {
    i1x = 0.0;
    i1y = 1.0;
  }
  const x1x = x0x - i1x + cx;
  const x1y = x0y - i1y + cx;
  const x2x = x0x + cz;
  const x2y = x0y + cz;
  ix = fxsnMod289(ix);
  iy = fxsnMod289(iy);
  const p0 = fxsnPermute(fxsnPermute(iy + 0.0) + ix + 0.0);
  const p1 = fxsnPermute(fxsnPermute(iy + i1y) + ix + i1x);
  const p2 = fxsnPermute(fxsnPermute(iy + 1.0) + ix + 1.0);
  let m0 = Math.max(0.5 - (x0x * x0x + x0y * x0y), 0.0);
  let m1 = Math.max(0.5 - (x1x * x1x + x1y * x1y), 0.0);
  let m2 = Math.max(0.5 - (x2x * x2x + x2y * x2y), 0.0);
  m0 = m0 * m0;
  m0 = m0 * m0;
  m1 = m1 * m1;
  m1 = m1 * m1;
  m2 = m2 * m2;
  m2 = m2 * m2;
  const gx0 = 2.0 * fxsnFract(p0 * cw) - 1.0;
  const gx1 = 2.0 * fxsnFract(p1 * cw) - 1.0;
  const gx2 = 2.0 * fxsnFract(p2 * cw) - 1.0;
  const h0 = Math.abs(gx0) - 0.5;
  const h1 = Math.abs(gx1) - 0.5;
  const h2 = Math.abs(gx2) - 0.5;
  const ox0 = Math.floor(gx0 + 0.5);
  const ox1 = Math.floor(gx1 + 0.5);
  const ox2 = Math.floor(gx2 + 0.5);
  const a0 = gx0 - ox0;
  const a1 = gx1 - ox1;
  const a2 = gx2 - ox2;
  m0 *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h0 * h0);
  m1 *= 1.79284291400159 - 0.85373472095314 * (a1 * a1 + h1 * h1);
  m2 *= 1.79284291400159 - 0.85373472095314 * (a2 * a2 + h2 * h2);
  const g0 = a0 * x0x + h0 * x0y;
  const g1 = a1 * x1x + h1 * x1y;
  const g2 = a2 * x2x + h2 * x2y;
  return 130.0 * (m0 * g0 + m1 * g1 + m2 * g2);
}

/** 3D twin of {@link fxSnoise2}, mirroring the GLSL `snoise(vec3)` overload op-for-op. */
export function fxSnoise3(vx: number, vy: number, vz: number): number {
  const cx = 1.0 / 6.0;
  const cy = 1.0 / 3.0;
  const s = (vx + vy + vz) * cy;
  let ix = Math.floor(vx + s);
  let iy = Math.floor(vy + s);
  let iz = Math.floor(vz + s);
  const t = (ix + iy + iz) * cx;
  const x0x = vx - ix + t;
  const x0y = vy - iy + t;
  const x0z = vz - iz + t;
  const gx = x0x >= x0y ? 1.0 : 0.0;
  const gy = x0y >= x0z ? 1.0 : 0.0;
  const gz = x0z >= x0x ? 1.0 : 0.0;
  const lx = 1.0 - gx;
  const ly = 1.0 - gy;
  const lz = 1.0 - gz;
  const i1x = Math.min(gx, lz);
  const i1y = Math.min(gy, lx);
  const i1z = Math.min(gz, ly);
  const i2x = Math.max(gx, lz);
  const i2y = Math.max(gy, lx);
  const i2z = Math.max(gz, ly);
  const x1x = x0x - i1x + cx;
  const x1y = x0y - i1y + cx;
  const x1z = x0z - i1z + cx;
  const x2x = x0x - i2x + cy;
  const x2y = x0y - i2y + cy;
  const x2z = x0z - i2z + cy;
  const x3x = x0x - 0.5;
  const x3y = x0y - 0.5;
  const x3z = x0z - 0.5;
  ix = fxsnMod289(ix);
  iy = fxsnMod289(iy);
  iz = fxsnMod289(iz);
  const offz = [0.0, i1z, i2z, 1.0];
  const offy = [0.0, i1y, i2y, 1.0];
  const offx = [0.0, i1x, i2x, 1.0];
  const p = [0.0, 0.0, 0.0, 0.0];
  for (let k = 0; k < 4; k += 1) {
    p[k] = fxsnPermute(fxsnPermute(fxsnPermute(iz + offz[k]) + iy + offy[k]) + ix + offx[k]);
  }
  const oneOverSeven = 1.0 / 7.0;
  const nsx = oneOverSeven * 2.0;
  const nsy = oneOverSeven * 0.5 - 1.0;
  const nsz = oneOverSeven;
  const xx = [0.0, 0.0, 0.0, 0.0];
  const yy = [0.0, 0.0, 0.0, 0.0];
  const hh = [0.0, 0.0, 0.0, 0.0];
  for (let k = 0; k < 4; k += 1) {
    const j = p[k] - 49.0 * Math.floor(p[k] * nsz * nsz);
    const xf = Math.floor(j * nsz);
    const yf = Math.floor(j - 7.0 * xf);
    xx[k] = xf * nsx + nsy;
    yy[k] = yf * nsx + nsy;
    hh[k] = 1.0 - Math.abs(xx[k]) - Math.abs(yy[k]);
  }
  const b0 = [xx[0], xx[1], yy[0], yy[1]];
  const b1 = [xx[2], xx[3], yy[2], yy[3]];
  const s0 = [
    Math.floor(b0[0]) * 2.0 + 1.0,
    Math.floor(b0[1]) * 2.0 + 1.0,
    Math.floor(b0[2]) * 2.0 + 1.0,
    Math.floor(b0[3]) * 2.0 + 1.0,
  ];
  const s1 = [
    Math.floor(b1[0]) * 2.0 + 1.0,
    Math.floor(b1[1]) * 2.0 + 1.0,
    Math.floor(b1[2]) * 2.0 + 1.0,
    Math.floor(b1[3]) * 2.0 + 1.0,
  ];
  const sh = [
    -(hh[0] <= 0.0 ? 1.0 : 0.0),
    -(hh[1] <= 0.0 ? 1.0 : 0.0),
    -(hh[2] <= 0.0 ? 1.0 : 0.0),
    -(hh[3] <= 0.0 ? 1.0 : 0.0),
  ];
  const a00 = b0[0] + s0[0] * sh[0];
  const a01 = b0[2] + s0[2] * sh[0];
  const a02 = b0[1] + s0[1] * sh[1];
  const a03 = b0[3] + s0[3] * sh[1];
  const a10 = b1[0] + s1[0] * sh[2];
  const a11 = b1[2] + s1[2] * sh[2];
  const a12 = b1[1] + s1[1] * sh[3];
  const a13 = b1[3] + s1[3] * sh[3];
  let p0x = a00;
  let p0y = a01;
  let p0z = hh[0];
  let p1x = a02;
  let p1y = a03;
  let p1z = hh[1];
  let p2x = a10;
  let p2y = a11;
  let p2z = hh[2];
  let p3x = a12;
  let p3y = a13;
  let p3z = hh[3];
  const nrm0 = 1.79284291400159 - 0.85373472095314 * (p0x * p0x + p0y * p0y + p0z * p0z);
  const nrm1 = 1.79284291400159 - 0.85373472095314 * (p1x * p1x + p1y * p1y + p1z * p1z);
  const nrm2 = 1.79284291400159 - 0.85373472095314 * (p2x * p2x + p2y * p2y + p2z * p2z);
  const nrm3 = 1.79284291400159 - 0.85373472095314 * (p3x * p3x + p3y * p3y + p3z * p3z);
  p0x *= nrm0;
  p0y *= nrm0;
  p0z *= nrm0;
  p1x *= nrm1;
  p1y *= nrm1;
  p1z *= nrm1;
  p2x *= nrm2;
  p2y *= nrm2;
  p2z *= nrm2;
  p3x *= nrm3;
  p3y *= nrm3;
  p3z *= nrm3;
  let m0 = Math.max(0.6 - (x0x * x0x + x0y * x0y + x0z * x0z), 0.0);
  let m1 = Math.max(0.6 - (x1x * x1x + x1y * x1y + x1z * x1z), 0.0);
  let m2 = Math.max(0.6 - (x2x * x2x + x2y * x2y + x2z * x2z), 0.0);
  let m3 = Math.max(0.6 - (x3x * x3x + x3y * x3y + x3z * x3z), 0.0);
  m0 = m0 * m0;
  m1 = m1 * m1;
  m2 = m2 * m2;
  m3 = m3 * m3;
  const dp0 = p0x * x0x + p0y * x0y + p0z * x0z;
  const dp1 = p1x * x1x + p1y * x1y + p1z * x1z;
  const dp2 = p2x * x2x + p2y * x2y + p2z * x2z;
  const dp3 = p3x * x3x + p3y * x3y + p3z * x3z;
  return 42.0 * (m0 * m0 * dp0 + m1 * m1 * dp1 + m2 * m2 * dp2 + m3 * m3 * dp3);
}

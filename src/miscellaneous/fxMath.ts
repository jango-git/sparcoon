/**
 * CPU-side twins of the compiler's math/noise builtins (`fxMix`, `fxNoise3`, ...). A behavior
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

// Mirrors FBM_MAX_OCTAVES in the editor engine: clamps a runaway octave count (a
// value parameter rebinds with no recompile/sanity gate) so it cannot blow up the update kernel.
const FBM_MAX_OCTAVES = 8;

/** Fractal Brownian motion over {@link fxNoise1} (gain 0.5, lacunarity 2). */
export function fxFbm(x: number, octaves: number): number {
  const octaveCount = Math.min(Math.max(Math.floor(octaves), 0), FBM_MAX_OCTAVES);
  let sum = 0;
  let amplitude = 1;
  let frequency = 1;
  for (let i = 0; i < octaveCount; i += 1) {
    sum += fxNoise1(x * frequency) * amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return sum;
}

/**
 * Fractal Brownian motion over the full {@link fxNoise3} domain (gain 0.5, lacunarity 2) - unlike
 * {@link fxFbm}, which walks a single scalar axis, this samples all three input components
 * together so the field varies with the whole position, not just one of its axes.
 */
export function fxFbm3(x: number, y: number, z: number, octaves: number): number {
  const octaveCount = Math.min(Math.max(Math.floor(octaves), 0), FBM_MAX_OCTAVES);
  let sum = 0;
  let amplitude = 1;
  let frequency = 1;
  for (let i = 0; i < octaveCount; i += 1) {
    sum += fxNoise3(x * frequency, y * frequency, z * frequency) * amplitude;
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

/**
 * Integer-hash sub-primitive, private to `fxNoise1/2/3` - Ken Perlin's classic `IntNoise` bit
 * scramble. `Math.imul` plus `| 0` truncation at each step forces genuine 32-bit wraparound so
 * this tracks the compiler's GLSL `int` version bit-for-bit (see the `noise` case in the editor's
 * `FXFunctions.Internal.ts` standard-tier helper).
 */
function fxIntHash1(n: number): number {
  const shifted = (n << 13) | 0;
  const mixed = (shifted ^ n) | 0;
  const squared = Math.imul(mixed, mixed);
  const step1 = (Math.imul(squared, 15731) + Math.imul(mixed, 789221)) | 0;
  const step2 = (Math.imul(step1, step1) + 1376312589) | 0;
  return (step2 & 0x00ffffff) / 16777216.0;
}

function fxIntHash2(ix: number, iy: number): number {
  return fxIntHash1((ix + Math.imul(iy, 57)) | 0);
}

function fxIntHash3(ix: number, iy: number, iz: number): number {
  return fxIntHash1((ix + Math.imul(iy, 57) + Math.imul(iz, 113)) | 0);
}

/**
 * Cheap deterministic 1D value-noise (smoothed integer-hash interpolation), range [-1, 1]. The
 * CPU twin of the compiler's GLSL `noise(float)` standard-tier form - see {@link fxIntHash1}.
 */
export function fxNoise1(x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return (fxIntHash1(i) * (1 - u) + fxIntHash1(i + 1) * u) * 2 - 1;
}

/**
 * 2D twin of {@link fxNoise1}, mirroring the GLSL `noise(vec2)` standard-tier overload op-for-op.
 * Component arguments (rather than a vector) so it mirrors how the scalarized JS backend calls it.
 */
export function fxNoise2(vx: number, vy: number): number {
  const ix = Math.floor(vx);
  const iy = Math.floor(vy);
  const fx = vx - ix;
  const fy = vy - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = fxIntHash2(ix, iy);
  const b = fxIntHash2(ix + 1, iy);
  const c = fxIntHash2(ix, iy + 1);
  const d = fxIntHash2(ix + 1, iy + 1);
  const ab = a + (b - a) * ux;
  const cd = c + (d - c) * ux;
  return (ab + (cd - ab) * uy) * 2 - 1;
}

/** 3D twin of {@link fxNoise1}, mirroring the GLSL `noise(vec3)` standard-tier overload op-for-op. */
export function fxNoise3(vx: number, vy: number, vz: number): number {
  const ix = Math.floor(vx);
  const iy = Math.floor(vy);
  const iz = Math.floor(vz);
  const fx = vx - ix;
  const fy = vy - iy;
  const fz = vz - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);
  const a = fxIntHash3(ix, iy, iz);
  const b = fxIntHash3(ix + 1, iy, iz);
  const c = fxIntHash3(ix, iy + 1, iz);
  const d = fxIntHash3(ix + 1, iy + 1, iz);
  const e = fxIntHash3(ix, iy, iz + 1);
  const f = fxIntHash3(ix + 1, iy, iz + 1);
  const g = fxIntHash3(ix, iy + 1, iz + 1);
  const h = fxIntHash3(ix + 1, iy + 1, iz + 1);
  const ab = a + (b - a) * ux;
  const cd = c + (d - c) * ux;
  const abcd = ab + (cd - ab) * uy;
  const ef = e + (f - e) * ux;
  const gh = g + (h - g) * ux;
  const efgh = ef + (gh - ef) * uy;
  return (abcd + (efgh - abcd) * uz) * 2 - 1;
}

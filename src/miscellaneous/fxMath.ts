/**
 * CPU-side twins of the compiler's math builtins (`fxMix`, `fxSmoothstep`, ...; noise lives in
 * `noise/`). A behavior kernel's authored `spawn`/`update` body calls these by name - the editor's
 * compiler prints those exact calls - so every exported name here is a frozen contract with
 * already-compiled kernels, like the `a_`/`p_` buffer prefixes. Never rename one without updating
 * the compiler side in lockstep.
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

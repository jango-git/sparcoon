/**
 * PCG hashes (Jarzynski & Olano 2020), bit-identical to the compiler's standard-tier GLSL:
 * `Math.imul` and `|0`/`>>>0` reproduce uint32 wraparound. Internal to the noise samplers.
 */

/** Per-axis lattice multipliers (Teschner et al.); a cell's hash input is `x*P0 ^ y*P1 ^ z*P2`. */
export const LATTICE_P0 = 73856093;
export const LATTICE_P1 = 19349663;
export const LATTICE_P2 = 83492791;

export function pcg(v: number): number {
  const s = (Math.imul(v, 747796405) + 2891336453) >>> 0;
  const w = Math.imul((s >>> ((s >>> 28) + 4)) ^ s, 277803737);
  return ((w >>> 22) ^ w) >>> 0;
}

/** The top 24 bits as [0, 1) - exact in float32, so GLSL and JS agree. */
export function unit(h: number): number {
  return (h >>> 8) * 5.9604644775390625e-8;
}

const floatBitsF32 = new Float32Array(1);
const floatBitsU32 = new Uint32Array(floatBitsF32.buffer);

/** The float32 bit pattern of `x` - GLSL's `floatBitsToUint`. */
export function floatBits(x: number): number {
  floatBitsF32[0] = x;
  return floatBitsU32[0];
}

/** The seed hash's first PCG state: the seed's bits as a lattice point, mixed with the salt's. */
export function seedKey(x: number, y: number, z: number, salt: number): number {
  return pcg(
    (Math.imul(floatBits(x), LATTICE_P0) ^
      Math.imul(floatBits(y), LATTICE_P1) ^
      Math.imul(floatBits(z), LATTICE_P2) ^
      pcg(floatBits(salt))) >>>
      0,
  );
}

import { lattice, pcg, unit } from "./noise/fxNoiseHash.js";

/**
 * The CPU simulation's random draw in [0, 1): the hash of a particle's id, the simulation's seed
 * of the tick and which draw of the kernel it is. The same three give the same draw, so a CPU
 * simulation repeats itself. The GPU's `fxNextRandom` hashes the same way, from the particle's
 * slot instead of its id.
 */
export function fxRandom(particleId: number, seed: number, draw: number): number {
  return unit(pcg(lattice(particleId, seed, draw)));
}

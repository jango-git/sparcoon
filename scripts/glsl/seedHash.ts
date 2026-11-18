import type { FXGLSLHelperDefinition } from "./helperDefinition.js";
import { type FXGLSLNoiseHash, type FXSeedHashComponents, tierHelperName } from "./noiseHash.js";

/**
 * The seed hash, the GLSL twin of `src/helpers/noise/fxSeedHash.ts`: 1-4 independent [0, 1)
 * values of a float point and a salt. Unlike the noise lattice it hashes the float's bits, not its
 * cell, so any two distinct seeds decorrelate.
 */

const COMPONENTS: readonly FXSeedHashComponents[] = [1, 2, 3, 4];
const TYPES = { 1: "float", 2: "vec2", 3: "vec3", 4: "vec4" } as const;

/** `fxSeedHash1..4(vec3 s, float salt)`. */
export function seedHashHelper(hash: FXGLSLNoiseHash): FXGLSLHelperDefinition {
  const overloads = COMPONENTS.map(
    (components) =>
      `${TYPES[components]} fxSeedHash${components.toString()}(vec3 s,float salt){${hash.seed(components)}}`,
  );
  return {
    name: tierHelperName(hash, "SEED_HASH"),
    source: `\n${overloads.join("\n")}`,
    requires: { [hash.tier]: [hash.helper] },
  };
}

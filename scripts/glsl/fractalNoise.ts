import type { FXGLSLRenderTier } from "../../src/artifact/FXArtifact.js";
import { PSI_2, PSI_3 } from "../../src/helpers/noise/fxCurlNoise.js";
import { FX_FBM_MAX_OCTAVES, OCTAVE_SHIFT } from "../../src/helpers/noise/fxFractalNoise.js";
import type { FXGLSLHelperDefinition } from "./helperDefinition.js";

/**
 * fBm and curl, the GLSL twins of `src/helpers/noise/fxFractalNoise.ts` and `fxCurlNoise.ts`: the
 * sum of sample(p_k) * gain^k divided by the sum of gain^k, with p_k = p_(k-1) * lacunarity + shift,
 * and 0 for zero octaves. fBm has a loop over a runtime octave count and an unrolled function per
 * fixed count, so no driver has to fold the loop's break. Curl only has the fixed counts. Their text
 * is the same on both tiers: only the noise they call differs.
 */

/** Octave counts with an unrolled function. */
const FIXED_OCTAVE_COUNTS = [1, 2, 3, 4, 5, 6] as const;

/** A helper each tier links, built on that tier's own one. */
type FXByTier = Readonly<Record<FXGLSLRenderTier, FXGLSLHelperDefinition>>;

const MAX = FX_FBM_MAX_OCTAVES.toString();
const SHIFT = OCTAVE_SHIFT.toString();

/** A loop over `octaves` adding the octave's `sample * amp` to `sum` (of type `sumType`). */
function octaveSum(signature: string, sumType: string, accumulate: string): string {
  return (
    `${signature}{int n=int(clamp(floor(octaves),0.0,${MAX}.0));` +
    `${sumType} sum=${sumType}(0.0);float amp=1.0;float total=0.0;` +
    `for(int o=0;o<${MAX};o++){if(o>=n)break;${accumulate}` +
    `total+=amp;amp*=gain;p=p*lacunarity+${SHIFT};}` +
    `return total>0.0?sum/total:${sumType}(0.0);}`
  );
}

/** {@link octaveSum} unrolled to `octaves`; each octave is its own block, so `accumulate` may
 *  declare locals. */
function octaveSumUnrolled(
  signature: string,
  sumType: string,
  accumulate: string,
  octaves: number,
): string {
  const step = `amp*=gain;p=p*lacunarity+${SHIFT};`;
  const blocks = Array.from(
    { length: octaves },
    (entry, octave) => `${octave === 0 ? "" : step}{${accumulate}}total+=amp;`,
  ).join("");
  return `${signature}{${sumType} sum=${sumType}(0.0);float amp=1.0;float total=0.0;${blocks}return sum/total;}`;
}

const FBM_TYPES = ["float", "vec2", "vec3"] as const;
const FBM_SAMPLE = "sum+=noise(p)*amp;";

const glslOffset = (offset: readonly number[]): string => `vec3(${offset.join(",")})`;

const CURL_SAMPLES = {
  vec2: "vec3 d=fxNoised(p);sum+=vec2(d.z,-d.y)*amp;",
  vec3:
    "vec3 g1=fxNoised(p).yzw;" +
    `vec3 g2=fxNoised(p+${glslOffset(PSI_2)}).yzw;` +
    `vec3 g3=fxNoised(p+${glslOffset(PSI_3)}).yzw;` +
    "sum+=vec3(g3.y-g2.z,g1.z-g3.x,g2.x-g1.y)*amp;",
} as const;

function linkedTo(helpers: FXByTier): FXGLSLHelperDefinition["requires"] {
  return { baseline: [helpers.baseline], standard: [helpers.standard] };
}

/** `float fxFbm(float|vec2|vec3 p, float octaves, float lacunarity, float gain)`. */
function fbmHelper(noise: FXByTier): FXGLSLHelperDefinition {
  const overloads = FBM_TYPES.map((type) =>
    octaveSum(
      `float fxFbm(${type} p,float octaves,float lacunarity,float gain)`,
      "float",
      FBM_SAMPLE,
    ),
  );
  return { name: "FX_GLSL_FBM", source: `\n${overloads.join("\n")}`, requires: linkedTo(noise) };
}

/** `float fxFbmOctaves<N>(float|vec2|vec3 p, float lacunarity, float gain)`. */
function fixedFbmHelper(noise: FXByTier, octaves: number): FXGLSLHelperDefinition {
  const name = `fxFbmOctaves${octaves.toString()}`;
  const overloads = FBM_TYPES.map((type) =>
    octaveSumUnrolled(
      `float ${name}(${type} p,float lacunarity,float gain)`,
      "float",
      FBM_SAMPLE,
      octaves,
    ),
  );
  return {
    name: `FX_GLSL_FBM_OCTAVES_${octaves.toString()}`,
    source: `\n${overloads.join("\n")}`,
    requires: linkedTo(noise),
  };
}

/**
 * `vec2 fxCurlOctaves<N>(vec2 p, ...)`: (dpsi/dy, -dpsi/dx) of psi = noise(p), and the vec3
 * overload: the curl of (psi1, psi2, psi3) = noise at p, p + PSI_2 and p + PSI_3.
 */
function fixedCurlHelper(noised: FXByTier, octaves: number): FXGLSLHelperDefinition {
  const name = `fxCurlOctaves${octaves.toString()}`;
  const overloads = (["vec2", "vec3"] as const).map((type) =>
    octaveSumUnrolled(
      `${type} ${name}(${type} p,float lacunarity,float gain)`,
      type,
      CURL_SAMPLES[type],
      octaves,
    ),
  );
  return {
    name: `FX_GLSL_CURL_OCTAVES_${octaves.toString()}`,
    source: `\n${overloads.join("\n")}`,
    requires: linkedTo(noised),
  };
}

/** fBm over each tier's `noise`, and curl over each tier's `fxNoised`. */
export function fractalHelpers(
  noise: FXByTier,
  noised: FXByTier,
): readonly FXGLSLHelperDefinition[] {
  return [
    fbmHelper(noise),
    ...FIXED_OCTAVE_COUNTS.flatMap((octaves) => [
      fixedFbmHelper(noise, octaves),
      fixedCurlHelper(noised, octaves),
    ]),
  ];
}

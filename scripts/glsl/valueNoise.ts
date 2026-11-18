import type { FXGLSLHelperDefinition } from "./helperDefinition.js";
import { type FXGLSLNoiseHash, tierHelperName } from "./noiseHash.js";

/**
 * Value noise in [-1, 1], the GLSL twin of `src/helpers/noise/fxValueNoise.ts`: cell-corner hashes
 * blended with smoothstep weights.
 * - `noise`: the value;
 * - `fxNoised`: value and analytic gradient, so curl needs one sample per potential instead of a
 *   central difference per axis.
 * One template serves both tiers; only the corner hash differs.
 */

type Dimensions = 1 | 2 | 3;
type Offset = 0 | 1;

const GLSL_TYPES = { 1: "float", 2: "vec2", 3: "vec3" } as const;

/** Corner offsets in index order (bit 0 = x, bit 1 = y, bit 2 = z). */
function cornerOffsets(dimensions: Dimensions): Offset[][] {
  return Array.from({ length: 1 << dimensions }, (corner, index) =>
    Array.from({ length: dimensions }, (entry, axis) => ((index >> axis) & 1) as Offset),
  );
}

/** Shared prologue: cell origin `fl`, fraction `f`, smoothstep weight `u`, corners `c0..`. */
function cellPrologue(hash: FXGLSLNoiseHash, dimensions: Dimensions): string {
  const type = GLSL_TYPES[dimensions];
  const corners = cornerOffsets(dimensions)
    .map((offset, index) => `float c${index.toString()}=${hash.corner(offset)};`)
    .join("");
  return `${type} fl=floor(p);${type} f=p-fl;${type} u=f*f*(3.0-2.0*f);${hash.latticeSetup(dimensions)}${corners}`;
}

const BLEND = {
  1: "mix(c0,c1,u)",
  2: "mix(mix(c0,c1,u.x),mix(c2,c3,u.x),u.y)",
  3: "mix(mix(mix(c0,c1,u.x),mix(c2,c3,u.x),u.y),mix(mix(c4,c5,u.x),mix(c6,c7,u.x),u.y),u.z)",
} as const;

/** `float noise(float|vec2|vec3 p)`. */
export function noiseHelper(hash: FXGLSLNoiseHash): FXGLSLHelperDefinition {
  const overloads = ([1, 2, 3] as const).map(
    (dimensions) =>
      `float noise(${GLSL_TYPES[dimensions]} p){${cellPrologue(hash, dimensions)}return ${BLEND[dimensions]}*2.0-1.0;}`,
  );
  return {
    name: tierHelperName(hash, "NOISE"),
    source: `\n${overloads.join("\n")}`,
    requires: { [hash.tier]: [hash.helper] },
  };
}

/**
 * `vec3 fxNoised(vec2 p)` and `vec4 fxNoised(vec3 p)`: the value, then the gradient. The trilinear
 * blend is expanded into polynomial coefficients k (Inigo Quilez's formulation): the value is a
 * polynomial in u, and d(value)/dp = du * d(value)/du with du = 6f(1-f).
 */
export function noisedHelper(hash: FXGLSLNoiseHash): FXGLSLHelperDefinition {
  const noised2 =
    `vec3 fxNoised(vec2 p){${cellPrologue(hash, 2)}vec2 du=6.0*f*(1.0-f);` +
    "float k1=c1-c0;float k2=c2-c0;float k3=c0-c1-c2+c3;" +
    "float v=c0+k1*u.x+k2*u.y+k3*u.x*u.y;" +
    "vec2 g=du*vec2(k1+k3*u.y,k2+k3*u.x);" +
    "return vec3(v*2.0-1.0,g*2.0);}";
  const noised3 =
    `vec4 fxNoised(vec3 p){${cellPrologue(hash, 3)}vec3 du=6.0*f*(1.0-f);` +
    "float k1=c1-c0;float k2=c2-c0;float k3=c4-c0;" +
    "float k4=c0-c1-c2+c3;float k5=c0-c2-c4+c6;float k6=c0-c1-c4+c5;" +
    "float k7=-c0+c1+c2-c3+c4-c5-c6+c7;" +
    "float v=c0+k1*u.x+k2*u.y+k3*u.z+k4*u.x*u.y+k5*u.y*u.z+k6*u.z*u.x+k7*u.x*u.y*u.z;" +
    "vec3 g=du*vec3(k1+k4*u.y+k6*u.z+k7*u.y*u.z,k2+k5*u.z+k4*u.x+k7*u.z*u.x,k3+k6*u.x+k5*u.y+k7*u.x*u.y);" +
    "return vec4(v*2.0-1.0,g*2.0);}";
  return {
    name: tierHelperName(hash, "NOISED"),
    source: `\n${noised2}\n${noised3}`,
    requires: { [hash.tier]: [hash.helper] },
  };
}

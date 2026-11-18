import type { FXGLSLRenderTier } from "../../src/artifact/FXArtifact.js";
import {
  LATTICE_P0,
  LATTICE_P1,
  LATTICE_P2,
  UNIT_24,
} from "../../src/helpers/noise/fxNoiseHash.js";
import { ID_MIX, UNIT_10, UNIT_11, UNIT_16 } from "../../src/helpers/noise/fxVoronoiNoise.js";
import type { FXGLSLHelperDefinition } from "./helperDefinition.js";

/**
 * Hashes behind every noise helper:
 * - baseline: float hashes (GLSL ES 1.00 has no bitwise ops or guaranteed 32-bit ints);
 * - standard: PCG, bit-identical to the JS twins in `src/helpers/noise`, so a GPU kernel and the
 *   CPU simulation agree.
 * Noise sources and the seed hash reach a hash only through this file.
 */

type Offset = 0 | 1;

/** Component count of a seed hash's result. */
export type FXSeedHashComponents = 1 | 2 | 3 | 4;

/** How a tier hashes lattice points, Voronoi cells and seeds, as source snippets. */
export interface FXGLSLNoiseHash {
  /** The tier hashing this way, the only one linking what is built on it. */
  readonly tier: FXGLSLRenderTier;
  readonly helper: FXGLSLHelperDefinition;
  /** Statements run once per sample, given the cell origin `fl` (float/vecN). */
  readonly latticeSetup: (dimensions: 1 | 2 | 3) => string;
  /** [0, 1) hash of the lattice corner `fl + offset`. */
  readonly corner: (offset: readonly Offset[]) => string;
  readonly voronoi: FXGLSLVoronoiHash;
  /** Body returning `components` independent [0, 1) values of the point `vec3 s` and `float salt`. */
  readonly seed: (components: FXSeedHashComponents) => string;
}

/**
 * Voronoi cell hashing over a search window at `base`, visited with loop counters `ox`, `oy`
 * (, `oz`) and offset `o`. Each cell yields a jitter `h` and a token `t`; the winning cell's
 * token becomes its id.
 */
export interface FXGLSLVoronoiHash {
  /** Statements run once per sample. */
  readonly setup: (dimensions: 2 | 3) => string;
  /** Statements declaring `vecN h` (jitter in [0, 1)) and `t` for the current cell. */
  readonly cell: (dimensions: 2 | 3) => string;
  /** Type and initial value of a token variable. */
  readonly token: (dimensions: 2 | 3) => { readonly type: string; readonly zero: string };
  /** [0, 1) id of the cell with token `token`. */
  readonly cellValue: (dimensions: 2 | 3, token: string) => string;
}

const BASELINE_HASH: FXGLSLHelperDefinition = {
  name: "FX_GLSL_BASELINE_HASH",
  source: `
float fxHash1(float n){float s=sin(n*127.1)*43758.5453123;return s-floor(s);}
float fxHash2(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float fxHash3(vec3 p){p=fract(p*vec3(443.897,441.423,437.195));p+=dot(p,p.yzx+19.19);return fract((p.x+p.y)*p.z);}
vec2 fxHash22(vec2 p){vec3 q=fract(p.xyx*vec3(0.1031,0.1030,0.0973));q+=dot(q,q.yzx+33.33);return fract((q.xx+q.yz)*q.zy);}
vec3 fxHash33(vec3 p){p=fract(p*vec3(0.1031,0.1030,0.0973));p+=dot(p,p.yxz+33.33);return fract((p.xxy+p.yxx)*p.zyx);}
vec4 fxHash44(vec4 p){p=fract(p*vec4(0.1031,0.1030,0.0973,0.1099));p+=dot(p,p.wzxy+33.33);return fract((p.xxyz+p.yzzw)*p.zywx);}`,
  requires: { baseline: [] },
};

function floatVector(offset: readonly Offset[]): string {
  return offset.length === 1
    ? `${offset.join("")}.0`
    : `vec${offset.length.toString()}(${offset.map((o) => `${o.toString()}.0`).join(",")})`;
}

export const BASELINE_NOISE_HASH: FXGLSLNoiseHash = {
  tier: "baseline",
  helper: BASELINE_HASH,
  latticeSetup: () => "",
  corner: (offset) => `fxHash${offset.length.toString()}(fl+${floatVector(offset)})`,
  /** The token is the cell itself; its id is hashed once, for the winner only. */
  voronoi: {
    setup: () => "",
    cell: (dimensions) => {
      const type = `vec${dimensions.toString()}`;
      return `${type} t=base+o;${type} h=fxHash${dimensions.toString()}${dimensions.toString()}(t);`;
    },
    token: (dimensions) => ({
      type: `vec${dimensions.toString()}`,
      zero: `vec${dimensions.toString()}(0.0)`,
    }),
    cellValue: (dimensions, token) => `fxHash${dimensions.toString()}(${token})`,
  },
  /** The salt is the fourth coordinate. */
  seed: (components) => `return fxHash44(vec4(s,salt)).${"xyzw".slice(0, components)};`,
};

const P0 = `${LATTICE_P0.toString()}u`;
const P1 = `${LATTICE_P1.toString()}u`;
const P2 = `${LATTICE_P2.toString()}u`;
const PRIMES = [P0, P1, P2];

/** The PCG hash and its unit conversions; also behind the GPU simulation's `rand()`. */
export const STANDARD_HASH: FXGLSLHelperDefinition = {
  name: "FX_GLSL_STANDARD_HASH",
  source: `
uint fxPcg(uint v){uint s=v*747796405u+2891336453u;uint w=((s>>((s>>28u)+4u))^s)*277803737u;return (w>>22u)^w;}
float fxUnit(uint h){return float(h>>8u)*${UNIT_24.toExponential()};}
vec2 fxUnit2(uint h){return vec2(h>>16u,h&65535u)*${UNIT_16.toExponential()};}
vec3 fxUnit3(uint h){return vec3(h>>22u,(h>>11u)&2047u,h&2047u)*vec3(${UNIT_10.toExponential()},${UNIT_11.toExponential()},${UNIT_11.toExponential()});}
uint fxLattice(uvec3 c){return c.x*${P0}^c.y*${P1}^c.z*${P2};}`,
  requires: { standard: [] },
};

export const STANDARD_NOISE_HASH: FXGLSLNoiseHash = {
  tier: "standard",
  helper: STANDARD_HASH,
  /** `l0`/`l1`: the cell's per-axis products for offsets 0 and 1, so each corner is one xor. */
  latticeSetup: (dimensions) => {
    if (dimensions === 1) {
      return "uint l0=uint(int(fl));uint l1=l0+1u;";
    }
    const vector = `uvec${dimensions.toString()}`;
    const primes = `${vector}(${PRIMES.slice(0, dimensions).join(",")})`;
    return `${vector} l0=${vector}(ivec${dimensions.toString()}(fl))*${primes};${vector} l1=l0+${primes};`;
  },
  corner: (offset) =>
    offset.length === 1
      ? `fxUnit(fxPcg(l${offset.join("")}))`
      : `fxUnit(fxPcg(${offset.map((o, axis) => `l${o.toString()}.${"xyz"[axis]}`).join("^")}))`,
  /**
   * Per-axis products of the window origin; a cell adds its offset's multiple, so each cell costs
   * one xor and one PCG. The token is the cell's 32-bit hash: its remix is the id.
   */
  voronoi: {
    setup: (dimensions) => {
      const vector = `uvec${dimensions.toString()}`;
      const primes = `${vector}(${PRIMES.slice(0, dimensions).join(",")})`;
      return `${vector} l=${vector}(ivec${dimensions.toString()}(base))*${primes};`;
    },
    cell: (dimensions) => {
      const terms = (["x", "y", "z"] as const)
        .slice(0, dimensions)
        .map((axis, i) => `(l.${axis}+uint(o${axis})*${PRIMES[i] ?? P0})`)
        .join("^");
      return `uint t=fxPcg(${terms});vec${dimensions.toString()} h=fxUnit${dimensions.toString()}(t);`;
    },
    token: () => ({ type: "uint", zero: "0u" }),
    cellValue: (dimensions, token) => `fxUnit(${token}*${ID_MIX.toString()}u)`,
  },
  /** The seed's bits are its lattice point; each further component is one more PCG round. */
  seed: (components) => {
    const rounds = Array.from(
      { length: components - 1 },
      (entry, index) => `uint h${(index + 1).toString()}=fxPcg(h${index.toString()});`,
    ).join("");
    const units = Array.from(
      { length: components },
      (entry, index) => `fxUnit(h${index.toString()})`,
    );
    const result = components === 1 ? units[0] : `vec${components.toString()}(${units.join(",")})`;
    return `uint h0=fxPcg(fxLattice(floatBitsToUint(s))^fxPcg(floatBitsToUint(salt)));${rounds}return ${result};`;
  },
};

/** Every tier's hash. */
export const NOISE_HASHES: readonly FXGLSLNoiseHash[] = [BASELINE_NOISE_HASH, STANDARD_NOISE_HASH];

/** `FX_GLSL_<TIER>_<stem>`: the constant of a helper built on `hash`, whose text is the tier's own. */
export function tierHelperName(hash: FXGLSLNoiseHash, stem: string): string {
  return `FX_GLSL_${hash.tier.toUpperCase()}_${stem}`;
}

import type { FXGLSLHelperDefinition } from "./helperDefinition.js";
import { type FXGLSLNoiseHash, tierHelperName } from "./noiseHash.js";

/**
 * Voronoi noise, the GLSL twin of `src/helpers/noise/fxVoronoiNoise.ts`: one feature point per
 * cell at `cell + 0.5 + jitter * (h - 0.5)`; the result is `(F1, F2, cellId)` - nearest and
 * second-nearest distance, and a [0, 1) value of F1's cell.
 * - `fast` searches the 2^N cells whose centers surround `p` (Gustavson's window). F1 and the id
 *   are exact up to jitter 0.5 (~0.1% of samples off at 0.8). F2 often lies outside the window:
 *   at jitter 0.8 ~8% of F2/edge samples are wrong, with seams along the window grid.
 * - `full` searches the 3^N cells around `p`'s cell: F1, F2 and edge exact in practice.
 * F1/F2 update branch-free; euclidean compares squared distances.
 */

const QUALITIES = ["fast", "full"] as const;
const METRICS = ["euclidean", "manhattan", "chebyshev"] as const;

type FXVoronoiQuality = (typeof QUALITIES)[number];
type FXVoronoiMetric = (typeof METRICS)[number];

const AXES = ["x", "y", "z"] as const;

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function metricDistance(metric: FXVoronoiMetric, dimensions: 2 | 3): string {
  const type = `vec${dimensions.toString()}`;
  switch (metric) {
    case "euclidean":
      return "dot(r,r)";
    case "manhattan":
      return `dot(abs(r),${type}(1.0))`;
    case "chebyshev":
      return dimensions === 2 ? "max(abs(r.x),abs(r.y))" : "max(max(abs(r.x),abs(r.y)),abs(r.z))";
  }
}

function voronoi(
  hash: FXGLSLNoiseHash,
  quality: FXVoronoiQuality,
  metric: FXVoronoiMetric,
  name: string,
  dimensions: 2 | 3,
): string {
  const type = `vec${dimensions.toString()}`;
  const span = quality === "fast" ? "2" : "3";
  const base = quality === "fast" ? "floor(p-0.5)" : "floor(p)-1.0";
  const axes = AXES.slice(0, dimensions);
  const loops = axes
    .slice()
    .reverse()
    .map((axis) => `for(int o${axis}=0;o${axis}<${span};o${axis}++){`)
    .join("");
  const offset = `${type}(${axes.map((axis) => `float(o${axis})`).join(",")})`;
  const finish = metric === "euclidean" ? "f1=sqrt(f1);f2=sqrt(f2);" : "";
  const token = hash.voronoi.token(dimensions);
  /** r = o + 0.5 + j*(h - 0.5) - f, with the per-sample part folded into `c`. */
  return (
    `vec3 ${name}(${type} p,float j){${type} base=${base};${type} c=0.5-0.5*j-(p-base);` +
    `${hash.voronoi.setup(dimensions)}float f1=1e4;float f2=1e4;${token.type} best=${token.zero};${loops}` +
    `${type} o=${offset};${hash.voronoi.cell(dimensions)}${type} r=o+c+j*h;` +
    `float d=${metricDistance(metric, dimensions)};` +
    "best=d<f1?t:best;f2=min(f2,max(f1,d));f1=min(f1,d);" +
    "}".repeat(dimensions) +
    `${finish}return vec3(f1,f2,${hash.voronoi.cellValue(dimensions, "best")});}`
  );
}

/** `vec3 fxVoronoi<Quality><Metric>(vec2|vec3 p, float jitter)` of every variant on `hash`. */
export function voronoiHelpers(hash: FXGLSLNoiseHash): readonly FXGLSLHelperDefinition[] {
  return QUALITIES.flatMap((quality) =>
    METRICS.map((metric) => {
      const name = `fxVoronoi${capitalize(quality)}${capitalize(metric)}`;
      return {
        name: tierHelperName(hash, `VORONOI_${quality.toUpperCase()}_${metric.toUpperCase()}`),
        source: `\n${voronoi(hash, quality, metric, name, 2)}\n${voronoi(hash, quality, metric, name, 3)}`,
        requires: { [hash.tier]: [hash.helper] },
      };
    }),
  );
}

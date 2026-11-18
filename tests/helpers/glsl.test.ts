import { describe, expect, it } from "vitest";

import { generateGLSLHelpers } from "../../scripts/glsl/generate";
import * as glsl from "../../src/helpers/glsl";

describe("src/helpers/glsl.ts", () => {
  it("is what scripts/glsl generates (npm run generate rewrites it)", async () => {
    await expect(generateGLSLHelpers()).toMatchFileSnapshot("../../src/helpers/glsl.ts");
  });

  it("requires only helpers its tier links", () => {
    for (const table of Object.values(glsl.FX_GLSL_HELPER_REQUIRES)) {
      for (const required of Object.values(table)) {
        for (const name of required) {
          expect(table[name]).toBeDefined();
        }
      }
    }
  });

  it("unrolls fixed-octave fBm and curl: no loop, one sample per octave", () => {
    const fbm = glsl.FX_GLSL_FBM_OCTAVES_3.split("\n").find((line) => line.includes("vec3 p"));
    expect(glsl.FX_GLSL_FBM_OCTAVES_3).not.toContain("for(");
    expect(fbm?.match(/noise\(p\)/g)).toHaveLength(3);
    expect(glsl.FX_GLSL_CURL_OCTAVES_2).not.toContain("for(");
  });

  it("hashes with floats on baseline and with PCG on standard", () => {
    expect(glsl.FX_GLSL_BASELINE_VORONOI_FAST_EUCLIDEAN).toContain("fxHash22(t)");
    expect(glsl.FX_GLSL_STANDARD_VORONOI_FAST_EUCLIDEAN).toContain("fxUnit2(t)");
    expect(glsl.FX_GLSL_BASELINE_SEED_HASH).toContain("fxHash44(vec4(s,salt)).xy");
    expect(glsl.FX_GLSL_STANDARD_SEED_HASH).toContain("floatBitsToUint(s)");
  });

  it("links a text both tiers share over each tier's own dependencies", () => {
    expect(glsl.FX_GLSL_HELPER_REQUIRES.baseline.FX_GLSL_FBM).toEqual(["FX_GLSL_BASELINE_NOISE"]);
    expect(glsl.FX_GLSL_HELPER_REQUIRES.standard.FX_GLSL_FBM).toEqual(["FX_GLSL_STANDARD_NOISE"]);
    expect(glsl.FX_GLSL_HELPER_REQUIRES.baseline.FX_GLSL_RAND).toBeUndefined();
  });
});

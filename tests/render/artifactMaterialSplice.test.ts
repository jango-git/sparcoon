import { describe, expect, it } from "vitest";

import type { FXRenderArtifact } from "../../src/artifact/FXArtifact";
import type { GLTypeInfo } from "../../src/instancedParticle/glTypeInfo";
import { FXArtifactMaterial } from "../../src/render/FXArtifactMaterial";
import {
  layoutOf,
  NO_PARTICLE_READS,
  NO_SURFACE_READS,
  unlitArtifact,
  VEC2_VARYING,
  VEC3_VARYING,
} from "../helpers/artifacts";

/** The two fixed core buffers plus any named attribute varyings the outputs reference. */
function varyings(attrs: Record<string, GLTypeInfo> = {}): Record<string, GLTypeInfo> {
  return {
    position: VEC3_VARYING,
    lifecycle: VEC3_VARYING,
    ...attrs,
  };
}

/** Builds the (ShaderMaterial-based) artifact material and returns its assembled shader source
 *  plus the extension flags Three reads to decide whether to inject `#extension` pragmas. */
function assembledShaders(
  render: FXRenderArtifact,
  props: Record<string, GLTypeInfo>,
): { vertexShader: string; fragmentShader: string; extensions: { derivatives?: boolean } } {
  const material = new FXArtifactMaterial(render).buildThreeMaterial(
    layoutOf(props),
  ) as unknown as {
    vertexShader: string;
    fragmentShader: string;
    extensions: { derivatives?: boolean };
  };
  return {
    vertexShader: material.vertexShader,
    fragmentShader: material.fragmentShader,
    extensions: material.extensions,
  };
}

describe("unlit ShaderMaterial assembly", () => {
  it("assembles a self-contained shader with no stock splice anchors and a fog/opaque tail", () => {
    const { vertexShader, fragmentShader } = assembledShaders(unlitArtifact(), varyings());

    // The shader is ours end to end - no stock splice anchor in it.
    expect(vertexShader).not.toContain("#include <begin_vertex>");
    expect(vertexShader).not.toContain("#include <project_vertex>");
    expect(fragmentShader).not.toContain("#include <map_fragment>");

    expect(vertexShader).toContain("gl_Position = projectionMatrix * mvPosition;");
    // Core fields reach the shader through the split-buffer defines, not a packed mat4.
    expect(vertexShader).toContain("#define PARTICLE_POSITION_X p_position.x");
    expect(vertexShader).toContain("#define PARTICLE_AGE p_lifecycle.x");

    // Output built from albedo, then Three's chunks assemble/tonemap/fog it.
    expect(fragmentShader).toContain("vec4 diffuseColor = vec4(1.0);");
    expect(fragmentShader).toContain("#include <opaque_fragment>");
    expect(fragmentShader).toContain("#include <fog_fragment>");
    // Three declares modelMatrix for the vertex stage only; a fragment-stage world-matrix read
    // needs it declared there too.
    expect(fragmentShader).toContain("uniform highp mat4 modelMatrix;");
  });

  it("pushes a dead particle's vertex outside the clip volume, unconditionally on render mode", () => {
    // Both backends draw their ring's dead slots in place (no compaction) - this line is what keeps
    // those slots from actually rendering. Checked here (unlit) and not re-checked per render
    // mode: the injection sits before alphaDiscardLines' own per-mode branching entirely.
    const { vertexShader } = assembledShaders(unlitArtifact(), varyings());
    expect(vertexShader).toContain(
      "if (PARTICLE_AGE >= PARTICLE_LIFETIME) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); }",
    );
  });

  it("declares the graph's varyings in both stages, flat ones flat where the GLSL has it", () => {
    const render = {
      ...unlitArtifact(),
      varyings: [
        { name: "v_bridge_0", type: "float", interpolation: "flat" as const },
        { name: "v_bridge_1", type: "vec2", interpolation: "smooth" as const },
      ],
    };
    const { vertexShader, fragmentShader } = assembledShaders(render, varyings());
    for (const shader of [vertexShader, fragmentShader]) {
      expect(shader).toMatch(/^FX_FLAT varying float v_bridge_0;$/m);
      expect(shader).toContain(
        "#if __VERSION__ >= 300\n#define FX_FLAT flat\n#else\n#define FX_FLAT\n#endif",
      );
      expect(shader).toMatch(/^varying vec2 v_bridge_1;$/m);
    }
  });

  it("defines no flat qualifier when nothing is carried flat", () => {
    const { vertexShader } = assembledShaders(unlitArtifact(), varyings());
    expect(vertexShader).not.toContain("FX_FLAT");
  });

  it("builds no surface frame when the fragment reads none of it", () => {
    const { vertexShader, fragmentShader } = assembledShaders(unlitArtifact(), varyings());
    for (const shader of [vertexShader, fragmentShader]) {
      expect(shader).not.toMatch(/vWorldNormal|vWorldTangent|vWorldPos|normal_pars|objectNormal/);
    }
    expect(vertexShader).not.toContain("fxNormalXform");
    expect(vertexShader).not.toContain("defaultnormal_vertex");
  });

  it("builds each surface builtin the fragment reads, and only that one", () => {
    // Normals are authored in WORLD space; view stays behind the ABI.
    const normal = assembledShaders(
      unlitArtifact({ fragmentBody: ["vec3 n = geometryNormal;"] }),
      varyings(),
    );
    expect(normal.vertexShader).toContain("vec3 objectNormal = fxNormalXform * normal;");
    expect(normal.vertexShader).toContain("vWorldNormal = normalize( objectNormal );");
    expect(normal.fragmentShader).toContain(
      "vec3 geometryNormal = normalize( vWorldNormal ) * fxFaceDirection;",
    );
    expect(normal.fragmentShader).not.toMatch(/vWorldTangent|vWorldPos/);

    const tangent = assembledShaders(
      unlitArtifact({ fragmentBody: ["vec3 t = geometryTangent;"] }),
      varyings(),
    );
    expect(tangent.vertexShader).toContain(
      "vWorldTangent = normalize( fxNormalXform * vec3( 1.0, 0.0, 0.0 ) );",
    );
    expect(tangent.fragmentShader).toContain("vec3 geometryTangent = normalize( vWorldTangent );");
    expect(tangent.vertexShader).not.toMatch(/objectNormal|vWorldNormal|vWorldPos/);

    const position = assembledShaders(
      unlitArtifact({ fragmentBody: ["vec3 p = worldPosition;"] }),
      varyings(),
    );
    expect(position.vertexShader).toContain("vWorldPos = fxModelPos;");
    expect(position.fragmentShader).toContain("vec3 worldPosition = vWorldPos;");
    expect(position.vertexShader).not.toContain("fxNormalXform");
    // Still no light infrastructure (it stays unlit).
    expect(position.fragmentShader).not.toContain("#include <lights_pars_begin>");
  });

  it("defaults the particle/vertex transforms to identity when the outputs are unbound", () => {
    const { vertexShader } = assembledShaders(unlitArtifact(), varyings());
    expect(vertexShader).toContain("mat4 fxParticleXform = mat4(1.0);");
    expect(vertexShader).toContain("mat4 fxVertexXform = mat4(1.0);");
    expect(vertexShader).toContain(
      "vec3 fxModelPos = particleCenter + (fxParticleXform * (fxVertexXform * vec4(position, 1.0))).xyz;",
    );
  });

  it("emits the particleTransform/vertexTransform outputs into the vertex transform chain", () => {
    const render = unlitArtifact({
      attributeReads: [{ name: "scale", components: 2 }],
      outputs: {
        albedo: "vec4(1.0)",
        particleTransform: "fxScaleMat(p_fx_scale)",
        vertexTransform: "mat4(2.0)",
      },
    });
    const props = varyings({ fx_scale: VEC2_VARYING });
    const { vertexShader } = assembledShaders(render, props);

    expect(vertexShader).toContain("mat4 fxParticleXform = fxScaleMat(p_fx_scale);");
    expect(vertexShader).toContain("mat4 fxVertexXform = mat4(2.0);");
    // The attribute is mirrored a_fx_scale -> p_fx_scale up front.
    expect(vertexShader).toContain("attribute vec2 a_fx_scale;");
    expect(vertexShader).toContain("p_fx_scale = a_fx_scale;");
  });
});

describe("lit ShaderMaterial assembly (non-empty lighting capability)", () => {
  const lit = (intrinsics: readonly string[]): FXRenderArtifact => ({
    lightingIntrinsics: intrinsics,
    sceneDepth: false,
    varyings: [],
    vertex: {
      uniformDeclarations: [],
      helperFunctions: [],
      body: [],
      particleReads: NO_PARTICLE_READS,
    },
    fragment: {
      uniformDeclarations: [],
      helperFunctions: [],
      body: [],
      particleReads: NO_PARTICLE_READS,
      // The intrinsic call below reads the normal.
      surfaceReads: { ...NO_SURFACE_READS, normal: true },
    },
    // Shading lives in the graph: `albedo` already carries the intrinsic call.
    outputs: { albedo: "fxLambertShade(vec4(1.0), geometryNormal)" },
    uniforms: {},
    attributeReads: [],
  });

  it("lights up Three's infrastructure and defines the shade intrinsics before main", () => {
    const { vertexShader, fragmentShader } = assembledShaders(lit(["fxLambertShade"]), varyings());

    // Full lambert light + shadow infrastructure so the intrinsic bodies resolve.
    expect(fragmentShader).toContain("#include <lights_pars_begin>");
    expect(fragmentShader).toContain("#include <lights_lambert_pars_fragment>");
    expect(fragmentShader).toContain("#include <shadowmap_pars_fragment>");
    expect(vertexShader).toContain("vec3 objectNormal = fxNormalXform * normal;");
    expect(vertexShader).toContain("vec4 worldPosition = vec4(particleCenter, 1.0);");
    expect(vertexShader).toContain("#include <shadowmap_vertex>");

    // Only the listed intrinsic is defined. It takes a WORLD normal and converts to view on its first
    // line, so view space stays behind the ABI.
    expect(fragmentShader).toContain("vec4 fxLambertShade(vec4 diffuseColor, vec3 worldNormal) {");
    expect(fragmentShader).not.toContain("fxAmbientShade");
    expect(fragmentShader).toContain(
      "vec3 normal = normalize( mat3( viewMatrix ) * worldNormal );",
    );

    // geometryNormal builtin (world) at the top of main; unlit tail (shading already lives in albedo).
    expect(fragmentShader).toContain(
      "vec3 geometryNormal = normalize( vWorldNormal ) * fxFaceDirection;",
    );
    expect(fragmentShader).toContain(
      "vec4 diffuseColor = fxLambertShade(vec4(1.0), geometryNormal);",
    );
    expect(fragmentShader).toContain("vec3 outgoingLight = diffuseColor.rgb;");
  });

  it("stays flat (no light infrastructure or intrinsics) when the capability is empty", () => {
    const { vertexShader, fragmentShader } = assembledShaders(unlitArtifact(), varyings());
    expect(fragmentShader).not.toContain("#include <lights_pars_begin>");
    expect(fragmentShader).not.toContain("vec4 fxLambertShade(vec4 diffuseColor");
    expect(vertexShader).not.toContain("#include <shadowmap_vertex>");
  });
});

// The opaque and alphaTest tails, shared with the mesh material, are materialContract.test.ts.
describe("render mode + additivity blend tail", () => {
  const artifact = (over: Partial<FXRenderArtifact>): FXRenderArtifact => ({
    lightingIntrinsics: [],
    sceneDepth: false,
    varyings: [],
    vertex: {
      uniformDeclarations: [],
      helperFunctions: [],
      body: [],
      particleReads: NO_PARTICLE_READS,
    },
    fragment: {
      uniformDeclarations: [],
      helperFunctions: [],
      body: [],
      particleReads: NO_PARTICLE_READS,
      surfaceReads: NO_SURFACE_READS,
    },
    outputs: { albedo: "vec4(1.0)" },
    uniforms: {},
    attributeReads: [],
    ...over,
  });

  it("blending (default): folds additivity into the output alpha, keeps floor + cutoff discards", () => {
    const { fragmentShader } = assembledShaders(
      artifact({ outputs: { albedo: "vec4(1.0)", additivity: "0.7" } }),
      varyings(),
    );
    // Premultiply, then additivity reduces the output alpha (over -> additive).
    expect(fragmentShader).toContain("gl_FragColor.rgb *= gl_FragColor.a;");
    expect(fragmentShader).toContain("gl_FragColor.a *= (1.0 - clamp(0.7, 0.0, 1.0));");
    // Near-zero floor + the default 0.0075 cutoff (unwired alphaThreshold), clamped to [0,1].
    expect(fragmentShader).toContain("if (diffuseColor.a < 0.0035) discard;");
    expect(fragmentShader).toContain("if (diffuseColor.a < clamp(0.0075, 0.0, 1.0)) discard;");
  });

  it("intensity scales the color alone, after the discards and before tone mapping", () => {
    const { fragmentShader } = assembledShaders(
      artifact({ outputs: { albedo: "vec4(1.0)", intensity: "2.5" } }),
      varyings(),
    );
    const line = "diffuseColor.rgb *= max(2.5, 0.0);";
    expect(fragmentShader).toContain(line);
    // The discards read the alpha before it; tone mapping and the premultiply come after it
    expect(fragmentShader.indexOf("if (diffuseColor.a < 0.0035) discard;")).toBeLessThan(
      fragmentShader.indexOf(line),
    );
    expect(fragmentShader.indexOf(line)).toBeLessThan(
      fragmentShader.indexOf("gl_FragColor.rgb *= gl_FragColor.a;"),
    );
    expect(fragmentShader).not.toContain("diffuseColor.a *=");
  });

  it("no intensity slot: no multiplier line", () => {
    const { fragmentShader } = assembledShaders(artifact({}), varyings());
    expect(fragmentShader).not.toContain("diffuseColor.rgb *= max(");
  });

  it("alphaHash mode requests the derivatives extension (dFdx/dFdy need it under WebGL1)", () => {
    const { extensions } = assembledShaders(
      artifact({ options: { renderMode: "alphaHash" } }),
      varyings(),
    );
    expect(extensions.derivatives).toBe(true);
  });

  it("every other render mode leaves the derivatives extension unset", () => {
    for (const renderMode of ["blending", "alphaTest", "opaque"] as const) {
      const { extensions } = assembledShaders(artifact({ options: { renderMode } }), varyings());
      expect(extensions.derivatives).toBe(false);
    }
  });
});

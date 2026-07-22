import { describe, expect, it } from "vitest";
import { FXArtifactMaterial } from "../../src/render/FXArtifactMaterial";
import type { FXRenderArtifact } from "../../src/artifact/FXArtifact";
import type { GLTypeInfo } from "../../src/instancedParticle/glTypeInfo";
import { unlitArtifact, VEC2_VARYING, VEC3_VARYING } from "../helpers/artifacts";

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
  const material = new FXArtifactMaterial(render).buildThreeMaterial(props) as unknown as {
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

    // The shader is ours end to end - none of the former onBeforeCompile anchors survive.
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
  });

  it("pushes a dead particle's vertex outside the clip volume, unconditionally on render mode", () => {
    // A GPU-driven emitter always draws its full fixed capacity, dead slots included (no
    // compaction, unlike FXInstancedParticle's removeDeadParticles) - this line is what keeps
    // those slots from actually rendering. Checked here (unlit) and not re-checked per render
    // mode: the injection sits before alphaDiscardLines' own per-mode branching entirely.
    const { vertexShader } = assembledShaders(unlitArtifact(), varyings());
    expect(vertexShader).toContain(
      "if (PARTICLE_AGE >= PARTICLE_LIFETIME) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); }",
    );
  });

  it("always sets up the world-space surface frame for the geometryNormal builtin", () => {
    const { vertexShader, fragmentShader } = assembledShaders(unlitArtifact(), varyings());
    // The world frame is built even with no lighting, so a surface-normal / normal-map / fresnel node
    // resolves. Normals are authored in WORLD space; view stays behind the ABI.
    expect(vertexShader).toContain("vec3 objectNormal = fxNormalXform * normal;");
    expect(vertexShader).toContain("vWorldNormal  = normalize( objectNormal );");
    expect(vertexShader).toContain(
      "vWorldTangent = normalize( fxNormalXform * vec3( 1.0, 0.0, 0.0 ) );",
    );
    expect(vertexShader).toContain("vWorldPos     = fxModelPos;");
    expect(fragmentShader).toContain(
      "vec3 geometryNormal  = normalize( vWorldNormal ) * fxFaceDirection;",
    );
    expect(fragmentShader).toContain("vec3 geometryTangent = normalize( vWorldTangent );");
    expect(fragmentShader).toContain("vec3 worldPosition   = vWorldPos;");
    // Still no light infrastructure (it stays unlit).
    expect(fragmentShader).not.toContain("#include <lights_pars_begin>");
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
    uniformDeclarations: [],
    vertex: { varyingDeclarations: [], helperFunctions: [], body: [] },
    fragment: { varyingDeclarations: [], helperFunctions: [], body: [] },
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

    // Both fx_ intrinsics are defined whenever lit (the GPU strips the unused one). They take a WORLD
    // normal and convert to view on their first line, so view space stays behind the ABI.
    expect(fragmentShader).toContain("vec4 fxLambertShade(vec4 diffuseColor, vec3 worldNormal) {");
    expect(fragmentShader).toContain("vec4 fxAmbientShade(vec4 diffuseColor, vec3 worldNormal) {");
    expect(fragmentShader).toContain(
      "vec3 normal = normalize( mat3( viewMatrix ) * worldNormal );",
    );
    expect(fragmentShader).toContain("getAmbientLightIrradiance( ambientLightColor )");

    // geometryNormal builtin (world) at the top of main; unlit tail (shading already lives in albedo).
    expect(fragmentShader).toContain(
      "vec3 geometryNormal  = normalize( vWorldNormal ) * fxFaceDirection;",
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

describe("render mode + additivity blend tail", () => {
  const artifact = (over: Partial<FXRenderArtifact>): FXRenderArtifact => ({
    lightingIntrinsics: [],
    uniformDeclarations: [],
    vertex: { varyingDeclarations: [], helperFunctions: [], body: [] },
    fragment: { varyingDeclarations: [], helperFunctions: [], body: [] },
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

  it("alphaTest mode: hard cutoff from the wired threshold, clamped; no floor, no additivity", () => {
    const { fragmentShader } = assembledShaders(
      artifact({
        options: { renderMode: "alphaTest" },
        outputs: { albedo: "vec4(1.0)", alphaThreshold: "0.5" },
      }),
      varyings(),
    );
    expect(fragmentShader).toContain("if (diffuseColor.a < clamp(0.5, 0.0, 1.0)) discard;");
    expect(fragmentShader).not.toContain("if (diffuseColor.a < 0.0035) discard;");
    expect(fragmentShader).not.toContain("gl_FragColor.a *=");
  });

  it("opaque mode: no discard and no additivity", () => {
    const { fragmentShader } = assembledShaders(
      artifact({ options: { renderMode: "opaque" } }),
      varyings(),
    );
    expect(fragmentShader).not.toContain("discard");
    expect(fragmentShader).not.toContain("clamp(");
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

describe("particle material object-velocity/object-angular-velocity uniforms", () => {
  it("declares objectVelocity/objectAngularVelocity in both stages, unlit and lit alike", () => {
    // Unprefixed (no u_): a domain-shared builtin (behavior reads the same name off the emitter
    // argument), same convention as modelMatrix/viewMatrix - not a particle-local u_ uniform like
    // u_time/u_deltaTime. Mirrors FX_MESH_TARGET's own declarations (meshMaterial.test.ts).
    const unlit = assembledShaders(unlitArtifact(), varyings());
    expect(unlit.vertexShader).toContain("uniform vec3 objectVelocity;");
    expect(unlit.vertexShader).toContain("uniform vec3 objectAngularVelocity;");
    expect(unlit.fragmentShader).toContain("uniform vec3 objectVelocity;");
    expect(unlit.fragmentShader).toContain("uniform vec3 objectAngularVelocity;");

    const lit = assembledShaders(
      { ...unlitArtifact(), lightingIntrinsics: ["fxLambertShade"] },
      varyings(),
    );
    expect(lit.vertexShader).toContain("uniform vec3 objectVelocity;");
    expect(lit.fragmentShader).toContain("uniform vec3 objectAngularVelocity;");
  });

  interface Vec3Uniform {
    value: readonly [number, number, number];
  }
  interface AssembledMaterialUniforms {
    uniforms: { objectVelocity: Vec3Uniform; objectAngularVelocity: Vec3Uniform };
  }

  it("defaults both to zero and updates live through the setters", () => {
    const material = new FXArtifactMaterial(unlitArtifact());
    const built = material.buildThreeMaterial(varyings()) as unknown as AssembledMaterialUniforms;
    expect(built.uniforms.objectVelocity.value).toEqual([0, 0, 0]);
    expect(built.uniforms.objectAngularVelocity.value).toEqual([0, 0, 0]);

    material.setObjectVelocity([1, 2, 3]);
    material.setObjectAngularVelocity([4, 5, 6]);
    expect(built.uniforms.objectVelocity.value).toEqual([1, 2, 3]);
    expect(built.uniforms.objectAngularVelocity.value).toEqual([4, 5, 6]);
  });

  it("also wires the depth material's uniforms (shadow-caster geometry pass)", () => {
    const material = new FXArtifactMaterial(unlitArtifact());
    const depth = material.buildThreeDepthMaterial(
      varyings(),
    ) as unknown as AssembledMaterialUniforms;
    material.setObjectVelocity([7, 8, 9]);
    expect(depth.uniforms.objectVelocity.value).toEqual([7, 8, 9]);
  });
});

import { describe, expect, it } from "vitest";
import type { Texture } from "three";
import { FXMeshMaterial } from "../../src/render/FXMeshMaterial";
import type { FXRenderArtifact } from "../../src/artifact/FXArtifact";
import { unlitArtifact } from "../helpers/artifacts";

interface AssembledMaterial {
  name: string;
  vertexShader: string;
  fragmentShader: string;
  lights: boolean;
}

function meshMaterial(render: FXRenderArtifact): AssembledMaterial {
  return new FXMeshMaterial(render).buildThreeMaterial() as unknown as AssembledMaterial;
}

describe("VFX mesh material assembly (attribute-free)", () => {
  it("projects a plain mesh vertex with none of the particle plumbing", () => {
    const material = meshMaterial(unlitArtifact());

    expect(material.name).toBe("FXMeshUnlitArtifactMaterial");
    // Plain object-space projection - a single mesh, not an instanced particle.
    expect(material.vertexShader).toContain("gl_Position = projectionMatrix * mvPosition;");

    // None of the three per-particle couplings survive.
    expect(material.vertexShader).not.toContain("#define PARTICLE_POSITION_X");
    expect(material.vertexShader).not.toContain("particleCenter");
    expect(material.vertexShader).not.toContain("p_position");
    expect(material.vertexShader).not.toMatch(/attribute\s+\w+\s+a_/);
    expect(material.fragmentShader).not.toContain("p_cameraDistance");
    expect(material.fragmentShader).not.toContain("#define PARTICLE_AGE");
  });

  it("still builds the world surface frame from the real mesh normal", () => {
    const material = meshMaterial(unlitArtifact());
    expect(material.vertexShader).toContain("vec3 objectNormal = fxNormalXform * normal;");
    expect(material.fragmentShader).toContain("vec3 geometryNormal");
    expect(material.fragmentShader).toContain("vec3 worldPosition");
  });

  it("honors the object-local transform slots (no particle center added)", () => {
    const material = meshMaterial(
      unlitArtifact({ outputs: { albedo: "vec4(1.0)", particleTransform: "mat4(2.0)" } }),
    );
    expect(material.vertexShader).toContain("mat4 fxParticleXform = mat4(2.0);");
    expect(material.vertexShader).toContain(
      "vec3 fxModelPos = (fxParticleXform * (fxVertexXform * vec4(position, 1.0))).xyz;",
    );
  });

  it("builds the lit variant when the graph carries lighting intrinsics", () => {
    const lit: FXRenderArtifact = { ...unlitArtifact(), lightingIntrinsics: ["fxLambertShade"] };
    const material = meshMaterial(lit);

    expect(material.name).toBe("FXMeshLightingNodesArtifactMaterial");
    expect(material.lights).toBe(true);
    expect(material.fragmentShader).toContain("vec4 fxLambertShade(");
    // Even lit, no particle plumbing.
    expect(material.vertexShader).not.toContain("particleCenter");
  });

  it("declares objectVelocity/objectAngularVelocity in both stages, unlit and lit alike", () => {
    // Unprefixed (no u_): this is a domain-shared builtin (behavior reads the same name off the
    // emitter argument), same convention as modelMatrix/viewMatrix - not a mesh-local u_ uniform
    // like u_time/u_deltaTime.
    const unlit = meshMaterial(unlitArtifact());
    expect(unlit.vertexShader).toContain("uniform vec3 objectVelocity;");
    expect(unlit.vertexShader).toContain("uniform vec3 objectAngularVelocity;");
    expect(unlit.fragmentShader).toContain("uniform vec3 objectVelocity;");
    expect(unlit.fragmentShader).toContain("uniform vec3 objectAngularVelocity;");

    const lit = meshMaterial({ ...unlitArtifact(), lightingIntrinsics: ["fxLambertShade"] });
    expect(lit.vertexShader).toContain("uniform vec3 objectVelocity;");
    expect(lit.fragmentShader).toContain("uniform vec3 objectAngularVelocity;");
  });
});

describe("VFX mesh material object-velocity/object-angular-velocity uniforms", () => {
  interface Vec3Uniform {
    value: readonly [number, number, number];
  }
  interface AssembledMaterialUniforms {
    uniforms: { objectVelocity: Vec3Uniform; objectAngularVelocity: Vec3Uniform };
  }

  it("defaults both to zero and updates live through the setters", () => {
    const material = new FXMeshMaterial(unlitArtifact());
    const built = material.buildThreeMaterial() as unknown as AssembledMaterialUniforms;
    expect(built.uniforms.objectVelocity.value).toEqual([0, 0, 0]);
    expect(built.uniforms.objectAngularVelocity.value).toEqual([0, 0, 0]);

    material.setObjectVelocity([1, 2, 3]);
    material.setObjectAngularVelocity([4, 5, 6]);
    expect(built.uniforms.objectVelocity.value).toEqual([1, 2, 3]);
    expect(built.uniforms.objectAngularVelocity.value).toEqual([4, 5, 6]);
  });

  it("also wires the depth material's uniforms (shadow-caster geometry pass)", () => {
    const material = new FXMeshMaterial(unlitArtifact());
    const depth = material.buildThreeDepthMaterial() as unknown as AssembledMaterialUniforms;
    material.setObjectVelocity([7, 8, 9]);
    expect(depth.uniforms.objectVelocity.value).toEqual([7, 8, 9]);
  });
});

describe("VFX mesh render mode", () => {
  // A discard anywhere in a fragment shader (even behind a runtime `if`) forces the GPU to skip
  // early depth/stencil rejection for the whole draw - opaque must carry no discard at all, not
  // merely an unreachable one, for both the unlit and lit mesh builders.
  it("opaque mode: no discard text in either the unlit or lit mesh fragment shader", () => {
    const unlit = meshMaterial({
      ...unlitArtifact({ outputs: { albedo: "vec4(1.0)" } }),
      options: { renderMode: "opaque" },
    });
    expect(unlit.fragmentShader).not.toContain("discard");

    const lit = meshMaterial({
      ...unlitArtifact({ outputs: { albedo: "vec4(1.0)" } }),
      lightingIntrinsics: ["fxLambertShade"],
      options: { renderMode: "opaque" },
    });
    expect(lit.fragmentShader).not.toContain("discard");
  });

  it("alphaTest mode: clamps the wired threshold into the discard", () => {
    const material = meshMaterial({
      ...unlitArtifact({ outputs: { albedo: "vec4(1.0)", alphaThreshold: "0.5" } }),
      options: { renderMode: "alphaTest" },
    });
    expect(material.fragmentShader).toContain(
      "if (diffuseColor.a < clamp(0.5, 0.0, 1.0)) discard;",
    );
  });
});

describe("VFX mesh material external textures and value edits", () => {
  const fakeTexture = { isTexture: true } as unknown as Texture;
  const otherTexture = { isTexture: true } as unknown as Texture;

  function externalArtifact(): FXRenderArtifact {
    return unlitArtifact({
      uniformDeclarations: ["uniform sampler2D u_param_map;"],
      uniforms: { u_param_map: { type: "sampler2D", external: "map" } },
    });
  }

  it("throws when an external texture slot has no supplied texture", () => {
    expect(() => new FXMeshMaterial(externalArtifact())).toThrow(/external slot "map"/);
  });

  it("binds a supplied external texture and builds a material", () => {
    const material = new FXMeshMaterial(externalArtifact(), { map: fakeTexture });
    expect(() => material.buildThreeMaterial()).not.toThrow();
  });

  it("applyUniformValues mutates a non-external artifact uniform in place", () => {
    const render = unlitArtifact({
      uniformDeclarations: ["uniform float u_param_size;"],
      uniforms: { u_param_size: { type: "float", value: 0 } },
    });
    const material = new FXMeshMaterial(render);
    material.applyUniformValues({ u_param_size: 3 });
    expect((render.uniforms["u_param_size"] as { value: number }).value).toBe(3);
  });

  it("applyUniformValues retargets an external slot and ignores an unknown name", () => {
    const render = externalArtifact();
    const material = new FXMeshMaterial(render, { map: fakeTexture });
    expect(() => material.applyUniformValues({ nope: 1, u_param_map: otherTexture })).not.toThrow();
    // The external slot rebinds to the mesh's own slot, never the shared artifact uniform.
    expect(render.uniforms["u_param_map"]).not.toHaveProperty("value", otherTexture);
  });
});

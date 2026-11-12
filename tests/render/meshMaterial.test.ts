import { describe, expect, it } from "vitest";

import type { FXRenderArtifact } from "../../src/artifact/FXArtifact";
import { FXMeshMaterial } from "../../src/render/FXMeshMaterial";
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

// What the mesh material shares with the particle one (object motion, render mode, value edits) is
// materialContract.test.ts.
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

  it("builds the world surface frame it reads from the real mesh normal", () => {
    const material = meshMaterial(
      unlitArtifact({ fragmentBody: ["vec3 n = geometryNormal + worldPosition;"] }),
    );
    expect(material.vertexShader).toContain("vec3 objectNormal = fxNormalXform * normal;");
    expect(material.fragmentShader).toContain("vec3 geometryNormal");
    expect(material.fragmentShader).toContain("vec3 worldPosition");
    expect(material.fragmentShader).not.toContain("vWorldTangent");
  });

  it("builds no surface frame for a mesh whose fragment reads none of it", () => {
    const material = meshMaterial(unlitArtifact());
    expect(material.vertexShader).not.toMatch(/objectNormal|vWorld|normal_pars/);
    expect(material.fragmentShader).not.toMatch(/geometryNormal|vWorld|normal_pars/);
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
});

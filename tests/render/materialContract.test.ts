import { describe, expect, it } from "vitest";
import { Texture, type ShaderMaterial } from "three";
import type { FXRenderArtifact } from "../../src/artifact/FXArtifact";
import { FXArtifactMaterial } from "../../src/render/FXArtifactMaterial";
import { FXMeshMaterial } from "../../src/render/FXMeshMaterial";
import { layoutOf, unlitArtifact, VEC2_VARYING, VEC3_VARYING } from "../helpers/artifacts";

/**
 * What the particle material (FXArtifactMaterial) and the VFX mesh material (FXMeshMaterial) share,
 * driven from one table: the object-motion uniforms, the render-mode discard tail and value edits.
 * Each class's own assembly is artifactMaterialSplice.test.ts / meshMaterial.test.ts; their depth
 * materials, depthMaterialSplice.test.ts.
 */

type Vec3 = readonly [number, number, number];

interface MaterialUnderTest {
  build(): ShaderMaterial;
  buildDepth(): ShaderMaterial;
  setObjectVelocity(velocity: Vec3): void;
  setObjectAngularVelocity(angularVelocity: Vec3): void;
  applyUniformValues(values: Readonly<Record<string, number | Texture>>): void;
}

const CORE_LAYOUT = layoutOf({ position: VEC3_VARYING, lifecycle: VEC2_VARYING });

const MATERIALS = [
  {
    kind: "particle",
    create: (render: FXRenderArtifact, textures?: Record<string, Texture>): MaterialUnderTest => {
      const material = new FXArtifactMaterial(render, textures);
      return {
        build: () => material.buildThreeMaterial(CORE_LAYOUT) as ShaderMaterial,
        buildDepth: () => material.buildThreeDepthMaterial(CORE_LAYOUT) as ShaderMaterial,
        setObjectVelocity: (velocity) => material.setObjectVelocity(velocity),
        setObjectAngularVelocity: (velocity) => material.setObjectAngularVelocity(velocity),
        applyUniformValues: (values) => material.applyUniformValues(values),
      };
    },
  },
  {
    kind: "mesh",
    create: (render: FXRenderArtifact, textures?: Record<string, Texture>): MaterialUnderTest => {
      const material = new FXMeshMaterial(render, textures);
      return {
        build: () => material.buildThreeMaterial() as ShaderMaterial,
        buildDepth: () => material.buildThreeDepthMaterial() as ShaderMaterial,
        setObjectVelocity: (velocity) => material.setObjectVelocity(velocity),
        setObjectAngularVelocity: (velocity) => material.setObjectAngularVelocity(velocity),
        applyUniformValues: (values) => material.applyUniformValues(values),
      };
    },
  },
] as const;

function lit(render: FXRenderArtifact): FXRenderArtifact {
  return { ...render, lightingIntrinsics: ["fxLambertShade"] };
}

describe.each(MATERIALS)("$kind material object-velocity/object-angular-velocity", ({ create }) => {
  it("declares both in both stages, unlit and lit alike", () => {
    // Unprefixed (no u_): a domain-shared builtin (behavior reads the same name off the emitter
    // argument), same convention as modelMatrix/viewMatrix - not a local u_ uniform like u_time.
    const unlit = create(unlitArtifact()).build();
    expect(unlit.vertexShader).toContain("uniform vec3 objectVelocity;");
    expect(unlit.vertexShader).toContain("uniform vec3 objectAngularVelocity;");
    expect(unlit.fragmentShader).toContain("uniform vec3 objectVelocity;");
    expect(unlit.fragmentShader).toContain("uniform vec3 objectAngularVelocity;");

    const litMaterial = create(lit(unlitArtifact())).build();
    expect(litMaterial.vertexShader).toContain("uniform vec3 objectVelocity;");
    expect(litMaterial.fragmentShader).toContain("uniform vec3 objectAngularVelocity;");
  });

  it("defaults both to zero and updates them live through the setters, depth material too", () => {
    const material = create(unlitArtifact());
    const built = material.build();
    const depth = material.buildDepth();
    expect(built.uniforms["objectVelocity"].value).toEqual([0, 0, 0]);
    expect(built.uniforms["objectAngularVelocity"].value).toEqual([0, 0, 0]);

    material.setObjectVelocity([1, 2, 3]);
    material.setObjectAngularVelocity([4, 5, 6]);
    for (const shader of [built, depth]) {
      expect(shader.uniforms["objectVelocity"].value).toEqual([1, 2, 3]);
      expect(shader.uniforms["objectAngularVelocity"].value).toEqual([4, 5, 6]);
    }
  });
});

describe.each(MATERIALS)("$kind material render mode", ({ create }) => {
  // A discard anywhere in a fragment shader (even behind a runtime `if`) makes the GPU skip early
  // depth/stencil rejection for the whole draw: opaque carries no discard at all, not merely an
  // unreachable one.
  it("opaque: no discard and no additivity, unlit or lit", () => {
    const opaque = unlitArtifact({ outputs: { albedo: "vec4(1.0)", additivity: "0.5" } });
    for (const render of [opaque, lit(opaque)]) {
      const { fragmentShader } = create({ ...render, options: { renderMode: "opaque" } }).build();
      expect(fragmentShader).not.toContain("discard");
      expect(fragmentShader).not.toContain("gl_FragColor.a *=");
    }
  });

  it("alphaTest: a hard cutoff from the wired threshold, clamped; no floor, no additivity", () => {
    const { fragmentShader } = create({
      ...unlitArtifact({
        outputs: { albedo: "vec4(1.0)", alphaThreshold: "0.5", additivity: "0.5" },
      }),
      options: { renderMode: "alphaTest" },
    }).build();
    expect(fragmentShader).toContain("if (diffuseColor.a < clamp(0.5, 0.0, 1.0)) discard;");
    expect(fragmentShader).not.toContain("if (diffuseColor.a < 0.0035) discard;");
    expect(fragmentShader).not.toContain("gl_FragColor.a *=");
  });
});

describe.each(MATERIALS)("$kind material value edits", ({ create }) => {
  /** A render with a float uniform `u_speed` and an external texture slot `u_flame` ("flame"). */
  function valuesRender(): FXRenderArtifact {
    return unlitArtifact({
      uniformDeclarations: ["uniform float u_speed;", "uniform sampler2D u_flame;"],
      uniforms: {
        u_speed: { type: "float", value: 0.5 },
        u_flame: { type: "sampler2D", external: "flame" },
      },
    });
  }

  it("throws when an external texture slot has no supplied texture", () => {
    expect(() => create(valuesRender())).toThrow(/no texture supplied for external slot "flame"/);
  });

  it("scrubs a uniform through the artifact slot the built material shares", () => {
    const render = valuesRender();
    const material = create(render, { flame: new Texture() });
    const bound = material.build().uniforms["u_speed"];
    expect(bound.value).toBe(0.5);

    material.applyUniformValues({ u_speed: 0.9 });
    expect(bound.value).toBe(0.9);
    expect(render.uniforms["u_speed"]).toHaveProperty("value", 0.9);
  });

  it("binds a supplied external texture, and retargets it in its own slot, not the artifact's", () => {
    const first = new Texture();
    const second = new Texture();
    const render = valuesRender();
    const material = create(render, { flame: first });
    const bound = material.build().uniforms["u_flame"];
    expect(bound.value).toBe(first);

    material.applyUniformValues({ u_flame: second });
    expect(bound.value).toBe(second);
    expect(render.uniforms["u_flame"]).not.toHaveProperty("value");
  });

  it("ignores an unknown uniform name", () => {
    const render = valuesRender();
    const material = create(render, { flame: new Texture() });
    const built = material.build();
    material.applyUniformValues({ u_nope: 1 });
    expect(built.uniforms["u_nope"]).toBeUndefined();
    expect(Object.keys(render.uniforms)).toEqual(["u_speed", "u_flame"]);
  });
});

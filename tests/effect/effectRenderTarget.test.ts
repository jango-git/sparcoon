import {
  Group,
  type Material,
  PerspectiveCamera,
  Scene,
  type ShaderMaterial,
  type WebGLRenderer,
} from "three";
import { afterEach, describe, expect, it } from "vitest";

import type { FXEffect } from "../../src/effect/FXEffect";
import type { FXEffectEmitterSpec, FXEffectMeshSpec } from "../../src/effect/FXEffectSpec";
import { FXWorld } from "../../src/world/FXWorld";
import { unlitArtifact } from "../helpers/artifacts";
import {
  effectSpec,
  emitterSpec as baseEmitterSpec,
  meshSpec as baseMeshSpec,
  TestEffect,
} from "../helpers/effectSpecs";
import { emitterUniform, particlesOf } from "../helpers/internals";

// Only `capabilities.isWebGL2` is ever read off the renderer, so a minimal stand-in is enough -
// building a real WebGLRenderer needs an actual GL context, unavailable under headless vitest.
function rendererWithCapability(isWebGL2: boolean): WebGLRenderer {
  return { isWebGLRenderer: true, capabilities: { isWebGL2 } } as unknown as WebGLRenderer;
}

// Distinguishes which target artifact got selected: the albedo expression round-trips into the
// assembled fragment shader verbatim, so a target-specific marker string proves the pick.
function artifactWithMarker(marker: string): ReturnType<typeof unlitArtifact> {
  return unlitArtifact({ outputs: { albedo: marker } });
}

const MARKED_TARGETS = {
  baseline: artifactWithMarker("vec4(1.0)"),
  standard: artifactWithMarker("vec4(2.0)"),
};

function emitterSpec(name: string): FXEffectEmitterSpec {
  return baseEmitterSpec(name, { render: MARKED_TARGETS, expectedCapacity: 8 });
}

function meshSpec(name: string): FXEffectMeshSpec {
  return baseMeshSpec(name, { render: MARKED_TARGETS });
}

function fragmentShaderOf(effect: FXEffect, emitter: string): string {
  return (particlesOf(effect.getEmitter(emitter)!).material as ShaderMaterial).fragmentShader;
}

const worlds: FXWorld[] = [];
function newWorld(): FXWorld {
  const world = new FXWorld();
  worlds.push(world);
  return world;
}
afterEach(() => {
  for (const world of worlds.splice(0)) {
    world.dispose();
  }
});

describe("FXEffect render-target selection", () => {
  it("picks the baseline artifact when no renderer is supplied", () => {
    const effect = new TestEffect(effectSpec({ emitters: [emitterSpec("e")] }), {
      world: newWorld(),
    });
    expect(fragmentShaderOf(effect, "e")).toContain("vec4 diffuseColor = vec4(1.0);");
  });

  it("picks the baseline artifact when the renderer reports no WebGL2 capability", () => {
    const effect = new TestEffect(effectSpec({ emitters: [emitterSpec("e")] }), {
      world: newWorld(),
      renderer: rendererWithCapability(false),
    });
    expect(fragmentShaderOf(effect, "e")).toContain("vec4 diffuseColor = vec4(1.0);");
  });

  it("picks the standard artifact when the renderer reports WebGL2 capability", () => {
    const effect = new TestEffect(effectSpec({ emitters: [emitterSpec("e")] }), {
      world: newWorld(),
      renderer: rendererWithCapability(true),
    });
    expect(fragmentShaderOf(effect, "e")).toContain("vec4 diffuseColor = vec4(2.0);");
  });

  it("refuses a renderer that is not a WebGLRenderer, in the constructor and in compile()", async () => {
    const webgpu = { isWebGPURenderer: true } as unknown as WebGLRenderer;
    const spec = effectSpec({ emitters: [emitterSpec("e")] });
    expect(() => new TestEffect(spec, { world: newWorld(), renderer: webgpu })).toThrow(
      "needs a WebGLRenderer",
    );
    const effect = new TestEffect(spec, { world: newWorld() });
    await expect(effect.compile(webgpu, new PerspectiveCamera())).rejects.toThrow(
      "needs a WebGLRenderer",
    );
  });

  it("checks the drawing renderer on the first draw when none was passed, then unhooks", () => {
    const webgpu = { isWebGPURenderer: true } as unknown as WebGLRenderer;
    const webgl = { isWebGLRenderer: true } as unknown as WebGLRenderer;
    const effect = new TestEffect(
      effectSpec({ emitters: [emitterSpec("e")], meshes: [meshSpec("m")] }),
      { world: newWorld() },
    );
    const mesh = particlesOf(effect.getEmitter("e")!);
    const ownHook = (): void => {};
    effect.getMesh("m")!.onBeforeRender = ownHook;
    const draw = (renderer: WebGLRenderer): void => {
      mesh.onBeforeRender(
        renderer,
        new Scene(),
        new PerspectiveCamera(),
        mesh.geometry,
        mesh.material as Material,
        new Group(),
      );
    };
    expect(() => draw(webgpu)).toThrow("needs a WebGLRenderer");
    expect(() => draw(webgpu)).toThrow("needs a WebGLRenderer");
    draw(webgl);
    expect(Object.prototype.hasOwnProperty.call(mesh, "onBeforeRender")).toBe(false);
    expect(effect.getMesh("m")!.onBeforeRender).toBe(ownHook);
  });

  it("applies the same selection to VFX meshes", () => {
    const effect = new TestEffect(effectSpec({ meshes: [meshSpec("m")] }), {
      world: newWorld(),
      renderer: rendererWithCapability(true),
    });
    const material = effect.getMesh("m")!.material as ShaderMaterial;
    expect(material.fragmentShader).toContain("vec4 diffuseColor = vec4(2.0);");
  });

  it("drives setEmitterParam against the resolved (not the unselected) artifact", () => {
    const standardRender = unlitArtifact({
      uniformDeclarations: ["uniform float u_param_size;"],
      uniforms: { u_param_size: { type: "float", value: 0 } },
    });
    const emitter = baseEmitterSpec("e", {
      render: { baseline: artifactWithMarker("vec4(1.0)"), standard: standardRender },
    });

    const effect = new TestEffect(effectSpec({ emitters: [emitter] }), {
      world: newWorld(),
      renderer: rendererWithCapability(true),
    });
    effect.setEmitterParam("e", "size", 5);
    expect(emitterUniform(effect.getEmitter("e")!, "u_param_size")).toBe(5);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import type { WebGLRenderer } from "three";
import { FXEffect } from "../../src/effect/FXEffect";
import { FXWorld } from "../../src/world/FXWorld";
import type {
  FXEffectEmitterSpec,
  FXEffectMeshSpec,
  FXEffectSpec,
  FXTransform,
} from "../../src/effect/FXEffectSpec";
import type { FXInstancedParticle } from "../../src/instancedParticle/FXInstancedParticle";
import { behaviorArtifact, unlitArtifact } from "../helpers/artifacts";

const IDENTITY_TRANSFORM: FXTransform = {
  position: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
};

// Only `capabilities.isWebGL2` is ever read off the renderer, so a minimal stand-in is enough -
// building a real WebGLRenderer needs an actual GL context, unavailable under headless vitest.
function rendererWithCapability(isWebGL2: boolean): WebGLRenderer {
  return { capabilities: { isWebGL2 } } as unknown as WebGLRenderer;
}

// Distinguishes which target artifact got selected: the albedo expression round-trips into the
// assembled fragment shader verbatim, so a target-specific marker string proves the pick.
function artifactWithMarker(marker: string): ReturnType<typeof unlitArtifact> {
  return unlitArtifact({ outputs: { albedo: marker } });
}

function emitterSpec(name: string): FXEffectEmitterSpec {
  return {
    name,
    render: {
      baseline: artifactWithMarker("vec4(1.0)"),
      standard: artifactWithMarker("vec4(2.0)"),
    },
    behavior: behaviorArtifact({ lifetime: 100 }),
    expectedCapacity: 8,
    sortInterval: 0,
    externalSlots: [],
    transform: IDENTITY_TRANSFORM,
    transformTracks: [],
    tracks: [],
    events: [],
    liveChannels: [],
    liveParams: [],
  };
}

function meshSpec(name: string): FXEffectMeshSpec {
  return {
    name,
    render: {
      baseline: artifactWithMarker("vec4(1.0)"),
      standard: artifactWithMarker("vec4(2.0)"),
    },
    geometry: { type: "primitive", primitive: "plane" },
    externalSlots: [],
    transform: IDENTITY_TRANSFORM,
    transformTracks: [],
    tracks: [],
    liveChannels: [],
    liveParams: [],
  };
}

function spec(over: Partial<FXEffectSpec> = {}): FXEffectSpec {
  return {
    duration: 0,
    fps: 30,
    transform: IDENTITY_TRANSFORM,
    transformTracks: [],
    emitters: over.emitters ?? [],
    meshes: over.meshes ?? [],
  };
}

class TestEffect extends FXEffect {
  public constructor(specification: FXEffectSpec, world: FXWorld, renderer?: WebGLRenderer) {
    super(specification, {}, { world, renderer });
  }
}

function emitterMesh(effect: FXEffect, name: string): FXInstancedParticle {
  const emitter = effect.getEmitter(name)!;
  return (emitter as unknown as { mesh: FXInstancedParticle }).mesh;
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
    const effect = new TestEffect(spec({ emitters: [emitterSpec("e")] }), newWorld());
    const material = emitterMesh(effect, "e").material as unknown as { fragmentShader: string };
    expect(material.fragmentShader).toContain("vec4 diffuseColor = vec4(1.0);");
  });

  it("picks the baseline artifact when the renderer reports no WebGL2 capability", () => {
    const effect = new TestEffect(
      spec({ emitters: [emitterSpec("e")] }),
      newWorld(),
      rendererWithCapability(false),
    );
    const material = emitterMesh(effect, "e").material as unknown as { fragmentShader: string };
    expect(material.fragmentShader).toContain("vec4 diffuseColor = vec4(1.0);");
  });

  it("picks the standard artifact when the renderer reports WebGL2 capability", () => {
    const effect = new TestEffect(
      spec({ emitters: [emitterSpec("e")] }),
      newWorld(),
      rendererWithCapability(true),
    );
    const material = emitterMesh(effect, "e").material as unknown as { fragmentShader: string };
    expect(material.fragmentShader).toContain("vec4 diffuseColor = vec4(2.0);");
  });

  it("applies the same selection to VFX meshes", () => {
    const effect = new TestEffect(
      spec({ meshes: [meshSpec("m")] }),
      newWorld(),
      rendererWithCapability(true),
    );
    const material = effect.getMesh("m")!.material as unknown as { fragmentShader: string };
    expect(material.fragmentShader).toContain("vec4 diffuseColor = vec4(2.0);");
  });

  it("drives setEmitterParam against the resolved (not the unselected) artifact", () => {
    const standardRender = unlitArtifact({
      uniformDeclarations: ["uniform float u_param_size;"],
      uniforms: { u_param_size: { type: "float", value: 0 } },
    });
    const emitter: FXEffectEmitterSpec = {
      ...emitterSpec("e"),
      render: { baseline: artifactWithMarker("vec4(1.0)"), standard: standardRender },
    };

    const effect = new TestEffect(
      spec({ emitters: [emitter] }),
      newWorld(),
      rendererWithCapability(true),
    );
    effect.setEmitterParam("e", "size", 5);
    expect(standardRender.uniforms["u_param_size"].value).toBe(5);
  });
});

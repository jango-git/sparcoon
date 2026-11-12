import { BufferGeometry, type Material, type ShaderMaterial, Texture } from "three";
import { afterEach, describe, expect, it } from "vitest";

import type { FXRenderArtifact } from "../../src/artifact/FXArtifact";
import type { FXEffectMeshSpec } from "../../src/effect/FXEffectSpec";
import { FXWorld } from "../../src/world/FXWorld";
import { renderForBothTargets, unlitArtifact } from "../helpers/artifacts";
import { effectSpec, meshSpec, TestEffect } from "../helpers/effectSpecs";

// FXEffect's VFX meshes: built from the spec, then driven once per world tick - the clock, the
// value tracks and the object velocity/angular velocity a mesh render graph reads, from the mesh's
// own matrixWorld, whether posed by a baked transform track or driven live through getMesh().

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

/** A render declaring a float `u_param_glow` baked at `value`. */
function glowRender(value = 0): FXRenderArtifact {
  return unlitArtifact({
    uniformDeclarations: ["uniform float u_param_glow;"],
    uniforms: { u_param_glow: { type: "float", value } },
  });
}

/** An effect of the one mesh `mesh0`, built over `over`, in a world of its own. */
function meshEffect(
  over: Partial<FXEffectMeshSpec> = {},
  assets: ConstructorParameters<typeof TestEffect>[2] = {},
): { effect: TestEffect; world: FXWorld } {
  const world = newWorld();
  const effect = new TestEffect(
    effectSpec({ meshes: [meshSpec("mesh0", over)] }),
    { world },
    assets,
  );
  return { effect, world };
}

type MeshUniforms = Record<string, { value: unknown }>;

function uniformsOf(effect: TestEffect): MeshUniforms {
  return (effect.getMesh("mesh0")!.material as ShaderMaterial).uniforms as MeshUniforms;
}

describe("FXEffect mesh construction", () => {
  it("wires the shadow flags, building a depth material only for a caster", () => {
    const plain = meshEffect().effect.getMesh("mesh0")!;
    expect(plain.castShadow).toBe(false);
    expect(plain.receiveShadow).toBe(false);
    expect(plain.customDepthMaterial).toBeUndefined();

    const shadowed = meshEffect({ castShadow: true, receiveShadow: true }).effect.getMesh("mesh0")!;
    expect(shadowed.castShadow).toBe(true);
    expect(shadowed.receiveShadow).toBe(true);
    expect(shadowed.customDepthMaterial).toBeDefined();
  });

  it("resolves a custom geometry and an external texture from the effect's assets", () => {
    const geometry = new BufferGeometry();
    const flame = new Texture();
    // An asset named in `externalSlots` binds the external slot `u_param_<name>`.
    const render = unlitArtifact({
      uniformDeclarations: ["uniform sampler2D u_param_flame;"],
      uniforms: { u_param_flame: { type: "sampler2D", external: "u_param_flame" } },
    });
    const { effect } = meshEffect(
      {
        render: renderForBothTargets(render),
        geometry: { type: "custom", external: "rock" },
        externalSlots: ["flame"],
      },
      { rock: geometry, flame },
    );
    expect(effect.getMesh("mesh0")!.geometry).toBe(geometry);
    expect(uniformsOf(effect)["u_param_flame"].value).toBe(flame);

    // The custom geometry is the app's: disposing the effect leaves it alone.
    let geometryDisposed = 0;
    geometry.addEventListener("dispose", () => geometryDisposed++);
    effect.dispose();
    expect(geometryDisposed).toBe(0);
  });
});

describe("FXEffect mesh values", () => {
  it("writes setMeshParam into the declared uniform, and ignores an undeclared parameter", () => {
    const render = glowRender();
    const { effect } = meshEffect({ render: renderForBothTargets(render) });
    effect.setMeshParam("mesh0", "glow", 0.5);
    effect.setMeshParam("mesh0", "missing", 2);
    expect(uniformsOf(effect)["u_param_glow"].value).toBe(0.5);
    expect(uniformsOf(effect)["u_param_missing"]).toBeUndefined();
  });

  it("drives a value track onto the mesh each frame of the fps grid", () => {
    const render = glowRender();
    const { effect, world } = meshEffect({
      render: renderForBothTargets(render),
      tracks: [
        {
          name: "glow",
          keys: [
            { time: 0, value: 0 },
            { time: 1, value: 30 },
          ],
        },
      ],
    });
    effect.play();
    world.update(0.5); // frame 15
    expect(uniformsOf(effect)["u_param_glow"].value as number).toBeCloseTo(15, 6);
  });

  it("runs the mesh clock while playing, and holds it while stopped", () => {
    const { effect, world } = meshEffect();
    world.update(0.5); // never played
    expect(uniformsOf(effect)["u_time"].value).toBe(0);
    effect.play();
    world.update(0.25);
    world.update(0.25);
    expect(uniformsOf(effect)["u_time"].value).toBe(0.5);
    expect(uniformsOf(effect)["u_deltaTime"].value).toBe(0.25);
    effect.stop();
    world.update(0.5);
    expect(uniformsOf(effect)["u_time"].value).toBe(0.5);
    expect(uniformsOf(effect)["u_deltaTime"].value).toBe(0);
  });
});

describe("FXEffect mesh object-velocity/object-angular-velocity uniforms", () => {
  // Position is host-driven (via getMesh().position), not sampled from a baked track.
  const live: Partial<FXEffectMeshSpec> = { liveChannels: ["position"] };

  function motionOf(effect: TestEffect): { velocity: unknown; angularVelocity: unknown } {
    const uniforms = uniformsOf(effect);
    return {
      velocity: [...(uniforms["objectVelocity"].value as number[])],
      angularVelocity: [...(uniforms["objectAngularVelocity"].value as number[])],
    };
  }

  it("reports zero motion on the first update (no prior pose to diff against)", () => {
    const { effect, world } = meshEffect(live);
    effect.play();
    world.update(1);
    expect(motionOf(effect)).toEqual({ velocity: [0, 0, 0], angularVelocity: [0, 0, 0] });
  });

  it("reports the mesh's world-space linear velocity once it has moved", () => {
    const { effect, world } = meshEffect(live);
    effect.play();
    const mesh = effect.getMesh("mesh0")!;
    mesh.position.set(0, 0, 0);
    world.update(1); // establishes the baseline

    mesh.position.set(2, 0, 0);
    world.update(0.5); // moved 2 units in 0.5s -> 4 units/s

    const velocity = uniformsOf(effect)["objectVelocity"].value as number[];
    expect(velocity[0]).toBeCloseTo(4, 6);
    expect(velocity[1]).toBeCloseTo(0, 6);
    expect(velocity[2]).toBeCloseTo(0, 6);
  });

  it("resets the baseline on play() (restart), avoiding a teleport spike", () => {
    const { effect, world } = meshEffect(live);
    effect.play();
    const mesh = effect.getMesh("mesh0")!;
    mesh.position.set(0, 0, 0);
    world.update(1);
    mesh.position.set(10, 0, 0);
    world.update(1); // 10 units/s - the tracker was live before the restart

    effect.play(); // restart
    mesh.position.set(-50, 0, 0); // an unrelated jump, as if posed elsewhere on restart
    world.update(1);

    expect(motionOf(effect).velocity).toEqual([0, 0, 0]);
  });
});

describe("FXEffect mesh disposal", () => {
  it("disposes a primitive geometry and the mesh material once", () => {
    const { effect } = meshEffect();
    const mesh = effect.getMesh("mesh0")!;
    const disposed: string[] = [];
    mesh.geometry.addEventListener("dispose", () => disposed.push("geometry"));
    (mesh.material as Material).addEventListener("dispose", () => disposed.push("material"));
    effect.dispose();
    effect.dispose();
    expect(disposed.sort()).toEqual(["geometry", "material"]);
  });

  it("disposes a shadow caster's depth material too", () => {
    const { effect } = meshEffect({ castShadow: true });
    const depthMaterial = effect.getMesh("mesh0")!.customDepthMaterial!;
    let disposed = 0;
    depthMaterial.addEventListener("dispose", () => disposed++);
    effect.dispose();
    expect(disposed).toBe(1);
  });
});

import type { Material, ShaderMaterial } from "three";
import { describe, expect, it } from "vitest";

import { FXMesh } from "../../src/render/FXMesh";
import { FXWorld } from "../../src/world/FXWorld";
import { unlitArtifact } from "../helpers/artifacts";
import { uniformValue } from "../helpers/internals";

// FXMesh is the mesh twin of FXEmitter: built from one render artifact, self-subscribed to a world,
// and driven by FXWorld.update - including the object velocity/angular velocity a mesh render graph
// reads (which a hand-driven FXMeshMaterial would leave at zero unless the host tracked motion).

type MeshUniforms = Record<string, { value: readonly [number, number, number] }>;

function motionUniforms(mesh: FXMesh): MeshUniforms {
  return (mesh.material as ShaderMaterial).uniforms as MeshUniforms;
}

/** A render declaring a float `u_param_glow` baked at 0. */
function glowRender(): ReturnType<typeof unlitArtifact> {
  return unlitArtifact({
    uniformDeclarations: ["uniform float u_param_glow;"],
    uniforms: { u_param_glow: { type: "float", value: 0 } },
  });
}

describe("FXMesh world drive", () => {
  it("pushes world-space object velocity once the mesh has moved", () => {
    const world = new FXWorld();
    const mesh = FXMesh.fromArtifact(unlitArtifact(), {}, world);
    mesh.position.set(0, 0, 0);
    world.update(1); // establishes the baseline

    mesh.position.set(2, 0, 0);
    world.update(0.5); // moved 2 units in 0.5s -> 4 units/s

    const velocity = motionUniforms(mesh)["objectVelocity"].value;
    expect(velocity[0]).toBeCloseTo(4, 6);
    expect(velocity[1]).toBeCloseTo(0, 6);
    expect(velocity[2]).toBeCloseTo(0, 6);
    world.dispose();
  });

  it("joins the default world when none is passed and is driven by the static update", () => {
    const mesh = FXMesh.fromArtifact(unlitArtifact());
    mesh.position.set(0, 0, 0);
    FXWorld.update(1);
    mesh.position.set(0, 3, 0);
    FXWorld.update(1); // 3 units/s on Y
    expect(motionUniforms(mesh)["objectVelocity"].value[1]).toBeCloseTo(3, 6);
    mesh.destroy();
  });

  it("scrubs a live uniform value by name", () => {
    const world = new FXWorld();
    const render = glowRender();
    const mesh = FXMesh.fromArtifact(render, {}, world);
    mesh.applyValues({ u_param_glow: 0.7 });
    expect(uniformValue(mesh, "u_param_glow") as number).toBeCloseTo(0.7, 6);
    world.dispose();
  });
});

describe("FXMesh lifecycle", () => {
  it("wires shadow flags and a depth material, freed on destroy", () => {
    const world = new FXWorld();
    const mesh = FXMesh.fromArtifact(
      unlitArtifact(),
      { castShadow: true, receiveShadow: true },
      world,
    );
    expect(mesh.castShadow).toBe(true);
    expect(mesh.receiveShadow).toBe(true);
    const depthMaterial = mesh.customDepthMaterial;
    expect(depthMaterial).toBeDefined();

    let depthDisposed = 0;
    depthMaterial?.addEventListener("dispose", () => depthDisposed++);
    mesh.destroy();
    expect(depthDisposed).toBe(1);
    world.dispose();
  });

  it("leaves an inert mesh on destroy: undriven, unscrubbed, disposed once", () => {
    const world = new FXWorld();
    const render = glowRender();
    const mesh = FXMesh.fromArtifact(render, {}, world);
    let materialDisposed = 0;
    (mesh.material as Material).addEventListener("dispose", () => materialDisposed++);
    world.update(1);

    mesh.destroy();
    mesh.destroy();
    expect(materialDisposed).toBe(1);
    // Unregistered: a later tick no longer measures its motion.
    mesh.position.set(5, 0, 0);
    world.update(1);
    expect([...motionUniforms(mesh)["objectVelocity"].value]).toEqual([0, 0, 0]);
    mesh.applyValues({ u_param_glow: 1 });
    expect(render.uniforms["u_param_glow"]).toHaveProperty("value", 0);
    world.dispose();
  });

  it("is disposed together with its world", () => {
    const world = new FXWorld();
    const mesh = FXMesh.fromArtifact(unlitArtifact(), {}, world);
    let materialDisposed = 0;
    (mesh.material as Material).addEventListener("dispose", () => materialDisposed++);

    world.dispose();
    expect(materialDisposed).toBe(1);
  });
});

import { describe, expect, it } from "vitest";
import { FXMesh } from "../../src/render/FXMesh";
import { FXWorld } from "../../src/world/FXWorld";
import { unlitArtifact } from "../helpers/artifacts";

// FXMesh is the mesh twin of FXEmitter: built from one render artifact, self-subscribed to a world,
// and driven by FXWorld.update - including the object velocity/angular velocity a mesh render graph
// reads (which a hand-driven FXMeshMaterial would leave at zero unless the host tracked motion).

type MeshUniforms = Record<string, { value: readonly [number, number, number] }>;

function motionUniforms(mesh: FXMesh): MeshUniforms {
  return (mesh.material as unknown as { uniforms: MeshUniforms }).uniforms;
}

describe("FXMesh construction and world drive", () => {
  it("builds a THREE.Mesh from a render artifact", () => {
    const world = new FXWorld();
    const mesh = FXMesh.fromArtifact(unlitArtifact(), {}, world);
    expect(mesh.isMesh).toBe(true);
    expect(mesh.geometry).toBeDefined();
    expect(mesh.material).toBeDefined();
    world.dispose();
  });

  it("reports zero object motion on the first tick (no prior pose to diff against)", () => {
    const world = new FXWorld();
    const mesh = FXMesh.fromArtifact(unlitArtifact(), {}, world);
    world.update(1);
    const uniforms = motionUniforms(mesh);
    expect([...uniforms["objectVelocity"]!.value]).toEqual([0, 0, 0]);
    expect([...uniforms["objectAngularVelocity"]!.value]).toEqual([0, 0, 0]);
    world.dispose();
  });

  it("pushes world-space object velocity once the mesh has moved (the preview gap)", () => {
    const world = new FXWorld();
    const mesh = FXMesh.fromArtifact(unlitArtifact(), {}, world);
    mesh.position.set(0, 0, 0);
    world.update(1); // establishes the baseline

    mesh.position.set(2, 0, 0);
    world.update(0.5); // moved 2 units in 0.5s -> 4 units/s

    const velocity = motionUniforms(mesh)["objectVelocity"]!.value;
    expect(velocity[0]).toBeCloseTo(4, 6);
    expect(velocity[1]).toBeCloseTo(0, 6);
    expect(velocity[2]).toBeCloseTo(0, 6);
    world.dispose();
  });
});

describe("FXMesh lifecycle", () => {
  it("joins the default world when none is passed and is driven by the static update", () => {
    const mesh = FXMesh.fromArtifact(unlitArtifact());
    mesh.position.set(0, 0, 0);
    FXWorld.update(1);
    mesh.position.set(0, 3, 0);
    FXWorld.update(1); // 3 units/s on Y
    expect(motionUniforms(mesh)["objectVelocity"]!.value[1]).toBeCloseTo(3, 6);
    mesh.destroy();
  });

  it("stops being driven after destroy, and destroy is idempotent", () => {
    const world = new FXWorld();
    const mesh = FXMesh.fromArtifact(unlitArtifact(), {}, world);
    world.update(1);

    mesh.destroy();
    // Unregistered: a later tick must not touch it, and a double destroy is safe.
    expect(() => world.update(1)).not.toThrow();
    expect(() => mesh.destroy()).not.toThrow();
  });

  it("is disposed together with its world", () => {
    const world = new FXWorld();
    const mesh = FXMesh.fromArtifact(unlitArtifact(), {}, world);
    let materialDisposed = 0;
    mesh.material.addEventListener("dispose", () => materialDisposed++);

    world.dispose();
    expect(materialDisposed).toBe(1);
    expect(() => world.update(1)).not.toThrow();
  });
});

describe("FXMesh shadows and live values", () => {
  it("wires shadow flags and a depth material, freed on destroy", () => {
    const world = new FXWorld();
    const mesh = FXMesh.fromArtifact(
      unlitArtifact(),
      { castShadow: true, receiveShadow: true },
      world,
    );
    expect(mesh.castShadow).toBe(true);
    expect(mesh.receiveShadow).toBe(true);
    expect(mesh.customDepthMaterial).toBeDefined();

    let depthDisposed = 0;
    mesh.customDepthMaterial.addEventListener("dispose", () => depthDisposed++);
    mesh.destroy();
    expect(depthDisposed).toBe(1);
    world.dispose();
  });

  it("scrubs a live uniform value by name, and no-ops after destroy", () => {
    const world = new FXWorld();
    const render = unlitArtifact({
      uniformDeclarations: ["uniform float u_param_glow;"],
      uniforms: { u_param_glow: { type: "float", value: 0 } },
    });
    const mesh = FXMesh.fromArtifact(render, {}, world);
    mesh.applyValues({ u_param_glow: 0.7 });
    expect((render.uniforms["u_param_glow"] as { value: number }).value).toBeCloseTo(0.7, 6);

    mesh.destroy();
    expect(() => mesh.applyValues({ u_param_glow: 1 })).not.toThrow();
    world.dispose();
  });
});

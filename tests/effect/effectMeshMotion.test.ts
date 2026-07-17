import { describe, expect, it } from "vitest";
import { FXEffect } from "../../src/effect/FXEffect";
import { FXWorld } from "../../src/world/FXWorld";
import type { FXEffectMeshSpec, FXEffectSpec, FXTransform } from "../../src/effect/FXEffectSpec";
import { unlitArtifact } from "../helpers/artifacts";

// `FXEffect` drives the per-mesh `object-velocity`/`object-angular-velocity` uniforms once per world
// tick, from the mesh's own `matrixWorld` - whether posed by a baked transform track or (as here)
// driven live by the host through `getMesh()`. This builds the minimal spec needed to exercise it.

const IDENTITY_TRANSFORM: FXTransform = {
  position: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
};

function meshSpec(name: string): FXEffectMeshSpec {
  return {
    name,
    render: unlitArtifact(),
    geometry: { type: "primitive", primitive: "plane" },
    externalSlots: [],
    transform: IDENTITY_TRANSFORM,
    transformTracks: [],
    tracks: [],
    // Position is host-driven (via getMesh().position), not sampled from a baked track.
    liveChannels: ["position"],
    liveParams: [],
  };
}

function spec(): FXEffectSpec {
  return {
    duration: 0,
    fps: 30,
    transform: IDENTITY_TRANSFORM,
    transformTracks: [],
    emitters: [],
    meshes: [meshSpec("mesh0")],
  };
}

class TestEffect extends FXEffect {
  public constructor(world: FXWorld) {
    super(spec(), {}, { world });
  }
}

type MeshUniforms = Record<string, { value: readonly [number, number, number] }>;

function objectMotionUniforms(effect: TestEffect): MeshUniforms {
  return (effect.getMesh("mesh0")!.material as unknown as { uniforms: MeshUniforms }).uniforms;
}

describe("FXEffect drives per-mesh object-velocity/object-angular-velocity uniforms", () => {
  it("reports zero motion on the first update (no prior pose to diff against)", () => {
    const world = new FXWorld();
    const effect = new TestEffect(world);
    effect.play();
    world.update(1);
    const uniforms = objectMotionUniforms(effect);
    expect([...uniforms["objectVelocity"]!.value]).toEqual([0, 0, 0]);
    expect([...uniforms["objectAngularVelocity"]!.value]).toEqual([0, 0, 0]);
  });

  it("reports the mesh's world-space linear velocity once it has moved", () => {
    const world = new FXWorld();
    const effect = new TestEffect(world);
    effect.play();
    const mesh = effect.getMesh("mesh0")!;
    mesh.position.set(0, 0, 0);
    world.update(1); // establishes the baseline

    mesh.position.set(2, 0, 0);
    world.update(0.5); // moved 2 units in 0.5s -> 4 units/s

    const uniforms = objectMotionUniforms(effect);
    const velocity = uniforms["objectVelocity"]!.value;
    expect(velocity[0]).toBeCloseTo(4, 6);
    expect(velocity[1]).toBeCloseTo(0, 6);
    expect(velocity[2]).toBeCloseTo(0, 6);
  });

  it("resets the baseline on play() (restart), avoiding a teleport spike", () => {
    const world = new FXWorld();
    const effect = new TestEffect(world);
    effect.play();
    const mesh = effect.getMesh("mesh0")!;
    mesh.position.set(0, 0, 0);
    world.update(1);
    mesh.position.set(10, 0, 0);
    world.update(1); // 10 units/s - proves the tracker was live before restart

    effect.play(); // restart
    const restartedMesh = effect.getMesh("mesh0")!;
    restartedMesh.position.set(-50, 0, 0); // an unrelated jump, as if posed elsewhere on restart
    world.update(1);

    const uniforms = objectMotionUniforms(effect);
    expect([...uniforms["objectVelocity"]!.value]).toEqual([0, 0, 0]);
  });
});

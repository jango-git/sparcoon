import { Bone, BufferAttribute, BufferGeometry, Matrix3, Mesh, Skeleton, SkinnedMesh } from "three";
import { describe, expect, it } from "vitest";

import type { FXBehaviorArtifact } from "../../src/artifact/FXArtifact";
import { FXEmitter } from "../../src/emitter/FXEmitter";
import { kernelResourcesOf } from "../../src/emitter/FXKernelResources.Internal";
import { FXObjectPose } from "../../src/emitter/FXObjectPose.Internal";
import { objectSurfaceOf, skinnedSurfaceOf } from "../../src/emitter/FXSurfaceTable.Internal";
import {
  FX_OBJECT_ENTRIES,
  FX_OBJECT_FRAME,
  FX_OBJECT_NORMAL_FRAME,
  FX_OBJECT_PREVIOUS_FRAME,
  FX_OBJECT_STATE,
  FX_SKINNED_SURFACE_TEXELS_PER_TRIANGLE,
  FX_SURFACE_HEADER_TEXELS,
  FX_SURFACE_SKIN_INDEX_A,
  FX_SURFACE_SKIN_WEIGHT_A,
  FX_SURFACE_TEXEL_FLOATS,
  FX_SURFACE_TEXELS_PER_TRIANGLE,
  FX_SURFACE_VERTEX_A,
  fxObjectInputNames,
} from "../../src/surfaceTableLayout";
import { behaviorArtifact, unlitArtifact } from "../helpers/artifacts";
import { landBirths } from "../helpers/internals";

function triangle(skinned: boolean): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
  );
  if (skinned) {
    geometry.setAttribute(
      "skinIndex",
      new BufferAttribute(new Uint16Array([0, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0]), 4),
    );
    geometry.setAttribute(
      "skinWeight",
      new BufferAttribute(new Float32Array([1, 0, 0, 0, 0.25, 0.75, 0, 0, 0.5, 0.5, 0, 0]), 4),
    );
  }
  return geometry;
}

/** A mesh of {@link triangle} bound to two bones, placed at x = 2. */
function arm(skinned = true): SkinnedMesh {
  const mesh = new SkinnedMesh(triangle(skinned));
  const root = new Bone();
  const tip = new Bone();
  tip.position.y = 1;
  root.add(tip);
  mesh.add(root);
  mesh.position.x = 2;
  mesh.updateMatrixWorld(true);
  mesh.bind(new Skeleton([root, tip]));
  return mesh;
}

/** A mesh of {@link triangle} at x = 2, scaled by 2 along y. */
function rock(): Mesh {
  const mesh = new Mesh(triangle(false));
  mesh.position.x = 2;
  mesh.scale.y = 2;
  mesh.updateMatrixWorld(true);
  return mesh;
}

function texel(data: Float32Array, offset: number): number[] {
  const at = (FX_SURFACE_HEADER_TEXELS + offset) * FX_SURFACE_TEXEL_FLOATS;
  return [...data.subarray(at, at + FX_SURFACE_TEXEL_FLOATS)];
}

/** The `count` columns of entry `first` on, as a flat array of their `size` leading floats. */
function columns(entries: Float32Array, first: number, count: number, size: number): number[] {
  return Array.from({ length: count }, (_, column) => {
    const at = (first + column) * FX_SURFACE_TEXEL_FLOATS;
    return [...entries.subarray(at, at + size)];
  }).flat();
}

/** A behavior sampling the surface `name` through binding `s` from `field`, recording the
 *  bindings its spawn reads. */
function sampling(
  field: "objectSurfaces" | "skinnedSurfaces",
  name: string,
  seen: Record<string, unknown>[],
): FXBehaviorArtifact {
  const base = behaviorArtifact();
  const names = fxObjectInputNames("s");
  return {
    ...base,
    [field]: { s: name },
    spawn(slots, start, count, seed, bindings, emitter, inherited): void {
      seen.push({
        table: bindings["s"]?.value,
        bones: bindings[names.bones]?.value,
        entries: Float32Array.from(bindings[names.entries]?.value as Float32Array),
      });
      base.spawn?.(slots, start, count, seed, bindings, emitter, inherited);
    },
  };
}

const STATE = FX_OBJECT_STATE * FX_SURFACE_TEXEL_FLOATS;

describe("object surface tables", () => {
  it("writes a skinned mesh's bone indices and weights after its vertices and normals", () => {
    const { table } = skinnedSurfaceOf(arm(), "arm");
    expect(table.texels).toBe(FX_SURFACE_HEADER_TEXELS + FX_SKINNED_SURFACE_TEXELS_PER_TRIANGLE);
    expect(texel(table.data, FX_SURFACE_VERTEX_A + 1).slice(0, 3)).toEqual([1, 0, 0]);
    expect(texel(table.data, FX_SURFACE_SKIN_INDEX_A + 1)).toEqual([1, 0, 0, 0]);
    expect(texel(table.data, FX_SURFACE_SKIN_WEIGHT_A + 2)).toEqual([0.5, 0.5, 0, 0]);
  });

  it("reads a mesh's table as a shape's, unplaced", () => {
    const { table } = objectSurfaceOf(rock(), "rock");
    expect(table.texels).toBe(FX_SURFACE_HEADER_TEXELS + FX_SURFACE_TEXELS_PER_TRIANGLE);
    expect(texel(table.data, FX_SURFACE_VERTEX_A + 1).slice(0, 3)).toEqual([1, 0, 0]);
  });

  it("requires the mesh, and a skinned one's skeleton and skin attributes", () => {
    expect(() =>
      kernelResourcesOf(
        { objectSurfaces: { s: "missing" } },
        { geometries: {}, meshes: {}, volumes: {} },
      ),
    ).toThrow(/no mesh "missing"/);
    expect(() => skinnedSurfaceOf(rock(), "r")).toThrow(/no skinned mesh/);
    expect(() => objectSurfaceOf(arm(), "a")).toThrow(/is a skinned mesh/);
    expect(() => skinnedSurfaceOf(new SkinnedMesh(triangle(true)), "u")).toThrow(/no skinned mesh/);
    expect(() => skinnedSurfaceOf(arm(false), "a")).toThrow(/skinIndex/);
  });
});

describe("FXEmitter object surfaces", () => {
  it("hands the behavior a mesh's table and entries: its world and normal matrices", () => {
    const seen: Record<string, unknown>[] = [];
    const mesh = rock();
    const emitter = FXEmitter.fromArtifacts(sampling("objectSurfaces", "rock", seen), {
      particles: unlitArtifact(),
      meshes: { rock: mesh },
    });
    try {
      emitter.burst(1);
      landBirths(emitter);
      const [{ entries }] = seen as { entries: Float32Array }[];
      expect(entries).toHaveLength(FX_OBJECT_ENTRIES * FX_SURFACE_TEXEL_FLOATS);
      expect(entries[STATE]).toBe(1);
      expect(columns(entries, FX_OBJECT_FRAME, 4, 4)).toEqual([...mesh.matrixWorld.elements]);
      const normal = new Matrix3().getNormalMatrix(mesh.matrixWorld).elements;
      expect(columns(entries, FX_OBJECT_NORMAL_FRAME, 3, 3)).toEqual([...normal]);
    } finally {
      emitter.destroy();
    }
  });

  it("hands the behavior a skinned mesh's table, bone matrices and entries: its bind matrix", () => {
    const seen: Record<string, unknown>[] = [];
    const mesh = arm();
    const emitter = FXEmitter.fromArtifacts(sampling("skinnedSurfaces", "arm", seen), {
      particles: unlitArtifact(),
      meshes: { arm: mesh },
    });
    try {
      emitter.burst(1);
      landBirths(emitter);
      mesh.skeleton.update();
      emitter.burst(1);
      landBirths(emitter);

      const [unposed, posed] = seen as {
        table: Float32Array;
        bones: Float32Array;
        entries: Float32Array;
      }[];
      expect(unposed.table[0]).toBe(1);
      expect(unposed.bones).toBe(mesh.skeleton.boneMatrices);
      expect(unposed.entries[STATE]).toBe(0);
      expect(posed.entries[STATE]).toBe(1);
      expect(columns(posed.entries, FX_OBJECT_FRAME, 4, 4)).toEqual([...mesh.bindMatrix.elements]);
    } finally {
      emitter.destroy();
    }
  });

  it("keeps the pose bindings through a value scrub of the same name", () => {
    const seen: Record<string, unknown>[] = [];
    const mesh = arm();
    const emitter = FXEmitter.fromArtifacts(sampling("skinnedSurfaces", "arm", seen), {
      particles: unlitArtifact(),
      meshes: { arm: mesh },
    });
    try {
      emitter.applyValues({ bindings: { [fxObjectInputNames("s").bones]: 7 } });
      emitter.burst(1);
      landBirths(emitter);
      expect(seen[0]["bones"]).toBe(mesh.skeleton.boneMatrices);
    } finally {
      emitter.destroy();
    }
  });
});

describe("FXObjectPose", () => {
  /** The pose flag, and the motion. */
  const posedOf = (pose: FXObjectPose): number => pose.entries.value[STATE];
  const motionOf = (pose: FXObjectPose): number => pose.entries.value[STATE + 1];
  const skinnedPose = (mesh: SkinnedMesh, moving: boolean): FXObjectPose =>
    new FXObjectPose(mesh.bindMatrix, mesh.skeleton, moving);

  it("keeps a skinned pose before the latest change, and moves by 1 over the time between them", () => {
    const mesh = arm();
    const pose = skinnedPose(mesh, true);
    mesh.skeleton.update();
    pose.advance(0.01);
    const first = Float32Array.from(mesh.skeleton.boneMatrices.subarray(0, 32));
    expect(motionOf(pose)).toBe(0);

    pose.advance(0.01);
    mesh.skeleton.bones[1].rotation.z = 0.5;
    mesh.updateMatrixWorld(true);
    mesh.skeleton.update();
    pose.advance(0.01);
    expect([...pose.previousBones.value]).toEqual([...first]);
    expect(motionOf(pose)).toBeCloseTo(1 / 0.02, 6);
  });

  it("moves a mesh by its world matrix, keeping the one before as the previous frame", () => {
    const mesh = rock();
    const pose = new FXObjectPose(mesh.matrixWorld, undefined, true);
    pose.advance(0.01);
    const first = [...mesh.matrixWorld.elements];
    mesh.position.x = 3;
    mesh.updateMatrixWorld(true);
    pose.advance(0.01);
    expect(posedOf(pose)).toBe(1);
    expect(columns(pose.entries.value, FX_OBJECT_PREVIOUS_FRAME, 4, 4)).toEqual(first);
    expect(motionOf(pose)).toBeCloseTo(1 / 0.01, 6);
    expect(pose.previousBones.value).toHaveLength(0);
  });

  it("counts a pose left unchanged for two of its intervals as still", () => {
    const mesh = arm();
    const pose = skinnedPose(mesh, true);
    mesh.skeleton.update();
    pose.advance(0.01);
    mesh.skeleton.bones[1].rotation.z = 0.5;
    mesh.updateMatrixWorld(true);
    mesh.skeleton.update();
    pose.advance(0.02);
    pose.advance(0.04);
    expect(motionOf(pose)).toBeCloseTo(1 / 0.02, 6);
    pose.advance(0.001);
    expect(motionOf(pose)).toBe(0);
  });

  it("keeps no previous pose and no motion for a pose whose velocity no kernel reads", () => {
    const mesh = arm();
    const pose = skinnedPose(mesh, false);
    mesh.skeleton.update();
    pose.advance(0.01);
    mesh.skeleton.bones[1].rotation.z = 0.5;
    mesh.updateMatrixWorld(true);
    mesh.skeleton.update();
    pose.advance(0.01);
    expect(pose.previousBones.value).toHaveLength(0);
    expect(posedOf(pose)).toBe(1);
    expect(motionOf(pose)).toBe(0);
  });

  it("has no pose and no motion while three has not posed the skeleton", () => {
    const pose = skinnedPose(arm(), true);
    pose.advance(0.01);
    expect(posedOf(pose)).toBe(0);
    expect(motionOf(pose)).toBe(0);
  });
});

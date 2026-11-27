import { type DataTexture, Matrix3, type Matrix4, type Skeleton, type WebGLRenderer } from "three";

import type { FXValueSlot } from "../artifact/FXArtifact.js";
import { webglTextureOf } from "../render/FXDataTexture.Internal.js";
import {
  FX_BONE_TEXELS,
  FX_OBJECT_ENTRIES,
  FX_OBJECT_FRAME,
  FX_OBJECT_NORMAL_FRAME,
  FX_OBJECT_PREVIOUS_FRAME,
  FX_OBJECT_STATE,
  FX_SURFACE_TEXEL_FLOATS,
} from "../surfaceTableLayout.js";
import type { FXKernelResources } from "./FXKernelResources.Internal.js";

/** Floats of a 4x4 matrix, a frame or a bone's. */
const MATRIX_FLOATS = FX_BONE_TEXELS * FX_SURFACE_TEXEL_FLOATS;

/** The float of the first bone matrix that is 1 in any pose: its `w` in the translation column. A
 *  skeleton three never updated holds zeros. */
const POSE_MARK = MATRIX_FLOATS - 1;

/** How many of its own intervals a pose may go unchanged before the object counts as still. */
const STILL_AFTER_INTERVALS = 2;

const FRAME = FX_OBJECT_FRAME * FX_SURFACE_TEXEL_FLOATS;
const PREVIOUS_FRAME = FX_OBJECT_PREVIOUS_FRAME * FX_SURFACE_TEXEL_FLOATS;
const NORMAL_FRAME = FX_OBJECT_NORMAL_FRAME * FX_SURFACE_TEXEL_FLOATS;
const STATE = FX_OBJECT_STATE * FX_SURFACE_TEXEL_FLOATS;

const NO_BONES = new Float32Array(0);

/**
 * @internal The pose of an object surface as a simulation reads it (see `surfaceTableLayout.ts`):
 * the object's frame - a mesh's `matrixWorld`, a skinned mesh's `bindMatrix` - and a skinned
 * mesh's bone matrices, read once a tick into the object entries. three updates both when it
 * renders the scene, so the pose read is that of its last render.
 *
 * A moving pose, one whose velocity the kernel reads, keeps its previous pose: the one before the
 * latest change of the frame or the bone matrices, the motion 1 over the simulation time between
 * the two. A pose that goes unchanged for {@link STILL_AFTER_INTERVALS} of that time - an object
 * standing still, a mesh three skips, a paused animation - is still: the motion is 0, as it is
 * before a second pose, and always for a pose that is not moving.
 */
export class FXObjectPose {
  public readonly entries: FXValueSlot<Float32Array> = {
    value: new Float32Array(FX_OBJECT_ENTRIES * FX_SURFACE_TEXEL_FLOATS),
  };
  /** A skinned mesh's bone matrices, as the JS simulation reads them. three replaces the array
   *  when it first builds the bone texture, so {@link advance} points the slot at the current
   *  one. Empty for a mesh. */
  public readonly bones: FXValueSlot<Float32Array>;
  public readonly previousBones: FXValueSlot<Float32Array>;
  /** Counts the changes of {@link previousBones}, for a copy of it to follow. */
  public previousVersion = 0;

  /** A skinned mesh's entries for a program that has no bone texture to read: unposed and still. */
  private readonly entriesWithoutBones = new Float32Array(
    FX_OBJECT_ENTRIES * FX_SURFACE_TEXEL_FLOATS,
  );
  private readonly normalFrame = new Matrix3();
  private readonly currentBones: Float32Array;
  private readonly currentFrame = new Float64Array(MATRIX_FLOATS);
  private readonly previousFrame = new Float64Array(MATRIX_FLOATS);
  /** Whether the current pose holds one, and the previous one a pose before it. */
  private seen = false;
  private moved = false;
  /** The simulation time from the previous pose to the current one, and since the current one. */
  private interval = 0;
  private sinceChange = 0;

  /** `frame` is the object's, `skeleton` a skinned mesh's; `moving` whether the kernel reads the
   *  velocity. */
  constructor(
    private readonly frame: Matrix4,
    private readonly skeleton: Skeleton | undefined,
    public readonly moving: boolean,
  ) {
    const floats = moving && skeleton !== undefined ? skeleton.bones.length * MATRIX_FLOATS : 0;
    this.bones = { value: skeleton?.boneMatrices ?? NO_BONES };
    this.currentBones = new Float32Array(floats);
    this.previousBones = { value: new Float32Array(floats) };
  }

  public get skinned(): boolean {
    return this.skeleton !== undefined;
  }

  /** The number of bones, so of matrices in either set. */
  public get boneCount(): number {
    return this.skeleton?.bones.length ?? 0;
  }

  /** The bone texture three keeps for a skinned mesh, `null` until three first renders it on the
   *  GPU, and for a mesh. */
  public get boneTexture(): DataTexture | null {
    return this.skeleton?.boneTexture ?? null;
  }

  /** The entries a pass of a GPU program on `renderer` reads: a skinned mesh's without a pose
   *  while three has not uploaded its bone texture. */
  public entriesBound(renderer: WebGLRenderer): Float32Array {
    const boneTexture = this.boneTexture;
    const unposed =
      this.skeleton !== undefined &&
      (boneTexture === null || webglTextureOf(renderer, boneTexture) === undefined);
    return unposed ? this.entriesWithoutBones : this.entries.value;
  }

  /**
   * Reads the pose into the entries, and for a moving pose moves its clock on by `deltaTime` (see
   * {@link follow}). Once a tick, before any birth.
   */
  public advance(deltaTime: number): void {
    const frame = this.frame.elements;
    const bones = this.skeleton?.boneMatrices ?? NO_BONES;
    const posed = this.skeleton === undefined || bones[POSE_MARK] === 1;
    this.bones.value = bones;
    const normal = this.normalFrame.getNormalMatrix(this.frame).elements;
    for (const entries of this.entryArrays()) {
      entries.set(frame, FRAME);
      for (let column = 0; column < 3; column += 1) {
        for (let row = 0; row < 3; row += 1) {
          entries[NORMAL_FRAME + column * FX_SURFACE_TEXEL_FLOATS + row] = normal[column * 3 + row];
        }
      }
    }
    this.entries.value[STATE] = posed ? 1 : 0;
    if (this.moving) {
      this.follow(deltaTime, posed, bones, frame);
    }
  }

  /** Takes a changed pose as the current one and the one before it as the previous, and writes
   *  the previous pose's frame and the motion into the entries. */
  private follow(
    deltaTime: number,
    posed: boolean,
    bones: Float32Array,
    frame: ArrayLike<number>,
  ): void {
    this.sinceChange += deltaTime;
    const unchanged =
      this.seen && startsWith(bones, this.currentBones) && startsWith(frame, this.currentFrame);
    if (posed && !unchanged) {
      if (this.seen) {
        this.previousBones.value.set(this.currentBones);
        this.previousFrame.set(this.currentFrame);
        for (const entries of this.entryArrays()) {
          entries.set(this.previousFrame, PREVIOUS_FRAME);
        }
        this.interval = this.sinceChange;
        this.moved = this.interval > 0;
        this.previousVersion += 1;
      }
      this.currentBones.set(bones.subarray(0, this.currentBones.length));
      this.currentFrame.set(frame);
      this.seen = true;
      this.sinceChange = 0;
    }
    const moving = posed && this.moved && this.sinceChange <= STILL_AFTER_INTERVALS * this.interval;
    this.entries.value[STATE + 1] = moving ? 1 / this.interval : 0;
  }

  /** The entries the pose writes: a skinned mesh's also without a pose. */
  private entryArrays(): readonly Float32Array[] {
    return this.skeleton === undefined
      ? [this.entries.value]
      : [this.entries.value, this.entriesWithoutBones];
  }
}

/** @internal The poses of the object surfaces of a kernel's resources, which the simulation moves
 *  on together. */
export class FXObjectPoses {
  /** Each pose, by the binding of its surface. */
  public readonly byName: Readonly<Record<string, FXObjectPose>>;

  /** `moving` are the surfaces, by binding, whose velocity the kernel reads (see
   *  `FXKernelResourceNames.movingSurfaces`). */
  constructor(resources: FXKernelResources, moving: readonly string[] = []) {
    const poses: Record<string, FXObjectPose> = {};
    for (const name in resources) {
      const resource = resources[name];
      if (resource.kind === "objectSurface") {
        poses[name] = new FXObjectPose(resource.mesh.matrixWorld, undefined, moving.includes(name));
      } else if (resource.kind === "skinnedSurface") {
        const { mesh } = resource;
        poses[name] = new FXObjectPose(mesh.bindMatrix, mesh.skeleton, moving.includes(name));
      }
    }
    this.byName = poses;
  }

  /** Moves every pose on by a tick of `deltaTime` (see {@link FXObjectPose.advance}). */
  public advance(deltaTime: number): void {
    for (const name in this.byName) {
      this.byName[name].advance(deltaTime);
    }
  }
}

/** Whether `values` begins with `prefix`. */
function startsWith(values: ArrayLike<number>, prefix: ArrayLike<number>): boolean {
  for (let i = 0; i < prefix.length; i += 1) {
    if (values[i] !== prefix[i]) {
      return false;
    }
  }
  return true;
}

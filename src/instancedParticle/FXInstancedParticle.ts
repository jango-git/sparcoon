import type { BufferGeometry, Material, Matrix4, Vector3 } from "three";
import { InstancedBufferAttribute, InstancedBufferGeometry, Mesh, StreamDrawUsage } from "three";
import {
  FX_AGE,
  FX_CORE_LIFECYCLE,
  FX_CORE_POSITION,
  FX_LIFETIME,
  FX_POSITION_X,
  FX_POSITION_Y,
  FX_POSITION_Z,
} from "../coreLayout.js";
import type { GLTypeInfo } from "./glTypeInfo.js";

/** One contiguous run of ring slots `[start, start + count)` claimed by {@link FXInstancedParticle.claim}. */
export interface FXSlotRange {
  readonly start: number;
  readonly count: number;
}

/**
 * @internal Instanced mesh backing one JS-driven {@link FXEmitter}: a base primitive drawn once per
 * particle, plus packed per-particle state. Each field (core `position`/`lifecycle` and each user
 * attribute) is one `InstancedBufferAttribute` in {@link propertyBuffers}, exposed as `a_<name>`.
 *
 * A fixed-capacity **ring**, the same scheme as the GPU backend's `FXTransformFeedbackParticle`:
 * births claim slots at a wrapping cursor and overwrite whatever occupies them, a particle keeps
 * its slot for life (no compaction, no growth), and dead slots stay in place - hidden by the
 * render shader's own `age >= lifetime` clip, exactly as on the GPU. The drawn range is the
 * high-water mark of slots ever claimed, which reaches `capacity` after the first lap.
 *
 * A birth overwrites the slot at the cursor whether its particle is live or not, so `capacity`
 * must cover the spawn rate times the longest lifetime, bursts included; {@link overflowCount}
 * counts the particles that died early because it did not.
 */
export class FXInstancedParticle extends Mesh {
  public readonly propertyBuffers: Record<string, InstancedBufferAttribute> = {};

  private readonly instancedGeometry: InstancedBufferGeometry;
  private readonly capacity: number;

  // Next slot a birth claims (mod capacity), and how many slots are live / have ever been claimed.
  private cursor = 0;
  private liveCountInternal = 0;
  private highWaterMark = 0;
  // Births lost to a full ring: live particles overwritten plus births beyond capacity in one claim.
  private overflowCountInternal = 0;

  private sortingIndices: Int32Array = new Int32Array(0);
  private sortingSquaredDistances: Float64Array = new Float64Array(0);
  private sortingTemporaryBuffer: Float32Array = new Float32Array(0);

  constructor(
    varyings: Record<string, GLTypeInfo>,
    capacity: number,
    material: Material,
    baseGeometry: BufferGeometry,
  ) {
    const instancedGeometry = new InstancedBufferGeometry();

    // Copy the base geometry's position/uv/normal + index onto the instanced geometry so the
    // geometry-agnostic vertex epilogue transforms real mesh vertices. `baseGeometry` is caller-
    // owned (a primitive or a custom mesh asset, possibly shared across emitters) - never disposed
    // here.
    const baseIndex = baseGeometry.getIndex();
    if (baseIndex !== null) {
      instancedGeometry.setIndex(baseIndex);
    }
    instancedGeometry.setAttribute("position", baseGeometry.getAttribute("position"));
    instancedGeometry.setAttribute("uv", baseGeometry.getAttribute("uv"));
    instancedGeometry.setAttribute("normal", baseGeometry.getAttribute("normal"));

    super(instancedGeometry, material);

    this.frustumCulled = false;
    this.instancedGeometry = instancedGeometry;
    this.instancedGeometry.instanceCount = 0;
    this.capacity = capacity;

    // Zero-filled: every slot starts as `age 0 >= lifetime 0`, i.e. dead.
    for (const name in varyings) {
      const { bufferSize } = varyings[name];
      const attribute = new InstancedBufferAttribute(
        new Float32Array(this.capacity * bufferSize),
        bufferSize,
      );
      attribute.setUsage(StreamDrawUsage);
      this.instancedGeometry.setAttribute(`a_${name}`, attribute);
      this.propertyBuffers[name] = attribute;
    }
  }

  /**
   * The drawn slot range `[0, instanceCount)` - the high-water mark, live and dead slots alike. The
   * geometry itself draws no instance while none is live (every one would be clipped), but this
   * range stays: only {@link drop} and {@link sortByDistance} ever shrink it.
   */
  public get instanceCount(): number {
    return this.highWaterMark;
  }

  public get instanceCapacity(): number {
    return this.capacity;
  }

  /** Exact number of live particles, as of the last {@link advanceAges} plus births since. */
  public get liveCount(): number {
    return this.liveCountInternal;
  }

  /**
   * Particles lost to a full ring since construction (not reset by {@link drop}): live particles a
   * birth overwrote - they died early - plus births beyond capacity in a single claim.
   */
  public get overflowCount(): number {
    return this.overflowCountInternal;
  }

  /**
   * Claims `count` slots at the cursor and zero-fills them, returning the claimed runs in slot
   * order (two when the claim wraps past the end of the ring). Mirrors the GPU backend's cursor
   * exactly: the cursor advances by `count` mod capacity, and a claim larger than the ring seeds
   * every slot once starting at the old cursor - the extra births would only overwrite each other.
   */
  public claim(count: number): readonly FXSlotRange[] {
    const capacity = this.capacity;
    const start = this.cursor;
    const seeded = Math.min(count, capacity);
    this.cursor = (this.cursor + count) % capacity;
    this.overflowCountInternal += count - seeded;

    const head = Math.min(seeded, capacity - start);
    const ranges: FXSlotRange[] =
      head < seeded
        ? [
            { start, count: head },
            { start: 0, count: seeded - head },
          ]
        : [{ start, count: seeded }];

    const lifecycle = this.propertyBuffers[FX_CORE_LIFECYCLE] as
      InstancedBufferAttribute | undefined;
    for (const range of ranges) {
      const end = range.start + range.count;
      if (lifecycle !== undefined) {
        const { array, itemSize } = lifecycle;
        for (let i = range.start; i < end; i++) {
          if (array[i * itemSize + FX_AGE] < array[i * itemSize + FX_LIFETIME]) {
            this.overflowCountInternal += 1; // a live particle is overwritten
          } else {
            this.liveCountInternal += 1;
          }
        }
      }
      // A reused slot still holds its previous occupant's state - most dangerously a stale
      // `age >= lifetime`, which no spawn graph can reset (the spawn target has no `age` slot).
      // Zero it so births start clean, and flag every buffer so the cleared rows reach the GPU
      // even for buffers the spawn kernel does not itself write.
      for (const attribute of Object.values(this.propertyBuffers)) {
        attribute.array.fill(0, range.start * attribute.itemSize, end * attribute.itemSize);
        attribute.needsUpdate = true;
      }
      if (end > this.highWaterMark) {
        this.highWaterMark = end;
      }
    }
    this.syncDrawnInstances();
    return ranges;
  }

  /** Adds `deltaTime` to the age of every drawn slot and recounts the live ones. Age is host-owned. */
  public advanceAges(deltaTime: number): void {
    const lifecycle = this.propertyBuffers[FX_CORE_LIFECYCLE] as
      InstancedBufferAttribute | undefined;
    if (lifecycle === undefined) {
      return;
    }
    const { array, itemSize } = lifecycle;
    let live = 0;
    for (let i = 0; i < this.highWaterMark; i++) {
      const offset = i * itemSize;
      array[offset + FX_AGE] += deltaTime;
      if (array[offset + FX_AGE] < array[offset + FX_LIFETIME]) {
        live += 1;
      }
    }
    this.liveCountInternal = live;
    lifecycle.needsUpdate = true;
    this.syncDrawnInstances();
  }

  /**
   * Reorders every per-particle buffer back-to-front for correct alpha blending. Distances are
   * world-space (each center transformed by `meshWorldMatrix`), matching the shader's own
   * `p_cameraDistance` - correct under any transform, including non-uniform scale and shear.
   *
   * Dead slots sort behind every live one, so a sort also gathers the live particles into
   * `[0, liveCount)`: the drawn range shrinks to them and the cursor restarts right after them,
   * so the next births reuse dead slots instead of overwriting live particles the sort scattered
   * around the ring. Slot stability is given up here by design - a sorted emitter keeps no
   * per-slot history (the editor rejects trails on one).
   */
  public sortByDistance(cameraWorldPosition: Vector3, meshWorldMatrix: Matrix4): void {
    // Shrinks the drawn range below: never call this while a trail records this mesh (a slot past
    // the new range would keep its recorded live points) - `FXEmitter` skips sorting then.
    const instanceCount = this.highWaterMark;

    if (instanceCount < 2) {
      return;
    }

    const positionBuffer = this.propertyBuffers[FX_CORE_POSITION] as
      InstancedBufferAttribute | undefined;
    if (positionBuffer === undefined) {
      return;
    }

    if (this.sortingIndices.length < instanceCount) {
      this.sortingIndices = new Int32Array(this.capacity);
      this.sortingSquaredDistances = new Float64Array(this.capacity);
    }

    const lifecycleBuffer = this.propertyBuffers[FX_CORE_LIFECYCLE] as
      InstancedBufferAttribute | undefined;
    const lifecycleArray = lifecycleBuffer?.array;
    const lifecycleItemSize = lifecycleBuffer?.itemSize ?? 0;

    const { array: positionArray, itemSize: positionItemSize } = positionBuffer;
    // Column-major elements, indexed directly to avoid a per-particle Vector3.
    const elements = meshWorldMatrix.elements;

    for (let particleIndex = 0; particleIndex < instanceCount; particleIndex++) {
      this.sortingIndices[particleIndex] = particleIndex;
      if (
        lifecycleArray !== undefined &&
        lifecycleArray[particleIndex * lifecycleItemSize + FX_AGE] >=
          lifecycleArray[particleIndex * lifecycleItemSize + FX_LIFETIME]
      ) {
        // Squared distances are never negative, so a dead slot lands behind every live one.
        this.sortingSquaredDistances[particleIndex] = -1;
        continue;
      }
      const itemOffset = particleIndex * positionItemSize;
      const positionX = positionArray[itemOffset + FX_POSITION_X];
      const positionY = positionArray[itemOffset + FX_POSITION_Y];
      const positionZ = positionArray[itemOffset + FX_POSITION_Z];
      // meshWorldMatrix * vec4(center, 1.0) - bottom row is (0,0,0,1), so no w divide.
      const deltaX =
        elements[0] * positionX +
        elements[4] * positionY +
        elements[8] * positionZ +
        elements[12] -
        cameraWorldPosition.x;
      const deltaY =
        elements[1] * positionX +
        elements[5] * positionY +
        elements[9] * positionZ +
        elements[13] -
        cameraWorldPosition.y;
      const deltaZ =
        elements[2] * positionX +
        elements[6] * positionY +
        elements[10] * positionZ +
        elements[14] -
        cameraWorldPosition.z;
      this.sortingSquaredDistances[particleIndex] =
        deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ;
    }

    const sortingSquaredDistances = this.sortingSquaredDistances;
    const sortingIndices = this.sortingIndices.subarray(0, instanceCount);
    sortingIndices.sort(
      (indexA, indexB) => sortingSquaredDistances[indexB] - sortingSquaredDistances[indexA],
    );

    let maximumItemSize = 0;
    for (const name in this.propertyBuffers) {
      if (this.propertyBuffers[name].itemSize > maximumItemSize) {
        maximumItemSize = this.propertyBuffers[name].itemSize;
      }
    }

    const requiredTemporaryBufferSize = instanceCount * maximumItemSize;
    if (this.sortingTemporaryBuffer.length < requiredTemporaryBufferSize) {
      this.sortingTemporaryBuffer = new Float32Array(this.capacity * maximumItemSize);
    }

    for (const name in this.propertyBuffers) {
      const attribute = this.propertyBuffers[name];
      const { array, itemSize } = attribute;

      for (let newIndex = 0; newIndex < instanceCount; newIndex++) {
        const originalIndex = sortingIndices[newIndex];
        const sourceOffset = originalIndex * itemSize;
        const destinationOffset = newIndex * itemSize;

        for (let componentIndex = 0; componentIndex < itemSize; componentIndex++) {
          this.sortingTemporaryBuffer[destinationOffset + componentIndex] =
            array[sourceOffset + componentIndex];
        }
      }

      for (let i = 0; i < instanceCount * itemSize; i++) {
        array[i] = this.sortingTemporaryBuffer[i];
      }

      attribute.needsUpdate = true;
    }

    // Live particles now fill [0, liveCount) - see this method's doc comment.
    this.highWaterMark = this.liveCountInternal;
    this.cursor = this.liveCountInternal % this.capacity;
    this.syncDrawnInstances();
  }

  /**
   * Kills every particle at once: zeroes the drawn slots (all dead) and rewinds the cursor. Shrinks
   * the drawn range to nothing, so a trail recording this mesh must be cleared alongside (as
   * `FXEmitter.reset` does) - the drawn range must not shrink under a live trail history.
   */
  public drop(): void {
    for (const attribute of Object.values(this.propertyBuffers)) {
      attribute.array.fill(0, 0, this.highWaterMark * attribute.itemSize);
      attribute.needsUpdate = true;
    }
    this.cursor = 0;
    this.liveCountInternal = 0;
    this.highWaterMark = 0;
    this.syncDrawnInstances();
  }

  /**
   * Swaps the mounted material and base geometry in place for a render-only structural edit -
   * every per-particle buffer in {@link propertyBuffers} and the current instance count are left
   * completely untouched, so live particles never reset. Never called when the varyings shape
   * itself changed (the driver's own `applyRenderArtifact` guards that) - only the constructor
   * path handles a real buffer-layout change.
   */
  public replaceMaterialAndBaseGeometry(material: Material, baseGeometry: BufferGeometry): void {
    // Detach the previous base attributes first, same as destroy()'s dance: they were borrowed by
    // reference from a caller-owned geometry (possibly shared with other live consumers), so they
    // must never be disposed here.
    this.instancedGeometry.deleteAttribute("position");
    this.instancedGeometry.deleteAttribute("uv");
    this.instancedGeometry.deleteAttribute("normal");
    this.instancedGeometry.setIndex(null);

    const baseIndex = baseGeometry.getIndex();
    if (baseIndex !== null) {
      this.instancedGeometry.setIndex(baseIndex);
    }
    this.instancedGeometry.setAttribute("position", baseGeometry.getAttribute("position"));
    this.instancedGeometry.setAttribute("uv", baseGeometry.getAttribute("uv"));
    this.instancedGeometry.setAttribute("normal", baseGeometry.getAttribute("normal"));

    // The mounted material IS disposable here (unlike the base geometry attributes above) - it was
    // built exclusively for this mesh, never shared.
    (this.material as Material | undefined)?.dispose();
    this.material = material;
  }

  // Disposes the instanced geometry and the currently mounted material - not the constructor one,
  // which a live material hot-swap may have replaced and disposed.
  public destroy(): void {
    // position/uv/normal + index were borrowed by reference from the caller-owned base geometry
    // (constructor) - possibly shared with other live consumers of the same custom mesh asset.
    // Detach them first so dispose()'s GPU-buffer cascade only touches the `a_<name>` buffers this
    // instance actually owns, not a shared consumer's GPU cache.
    this.instancedGeometry.deleteAttribute("position");
    this.instancedGeometry.deleteAttribute("uv");
    this.instancedGeometry.deleteAttribute("normal");
    this.instancedGeometry.setIndex(null);
    this.instancedGeometry.dispose();
    (this.material as Material | undefined)?.dispose();
  }

  // Draws the drawn range while any particle is live, else nothing - an all-dead range would only
  // run the vertex shader to clip every instance.
  private syncDrawnInstances(): void {
    this.instancedGeometry.instanceCount = this.liveCountInternal > 0 ? this.highWaterMark : 0;
  }
}

import type { BufferGeometry, Material, Vector3 } from "three";
import {
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  StreamDrawUsage,
} from "three";
import { FX_AGE, FX_LIFETIME, FX_POSITION_X, FX_POSITION_Y, FX_POSITION_Z } from "../coreLayout.js";
import { markRange } from "../render/FXBufferUpload.Internal.js";
import type { FXCoreOffsets, FXSlotLayout } from "./FXParticleSlot.js";
import { coreOffsets } from "./FXParticleSlot.js";
import {
  attachBaseGeometry,
  detachBaseGeometry,
  remountParticleViews,
} from "./FXMeshGeometry.Internal.js";
import type { FXPackedAttribute } from "../render/FXAttributePacking.js";

/** One contiguous run of ring slots `[start, start + count)` claimed by {@link FXInstancedParticle.claim}. */
export interface FXSlotRange {
  readonly start: number;
  readonly count: number;
}

/**
 * @internal Instanced mesh backing one JS-driven {@link FXEmitter}: a base primitive drawn once per
 * particle, plus every particle's state in one interleaved CPU array ({@link slots}), each particle
 * one slot of {@link slot} - the same layout a GPU kernel writes, which the JS kernel indexes by
 * literal offsets. The render reads it through the views its layout packs (`a_pack0`, ...,
 * `FXParticleLayout.packed`), several fields per attribute.
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
 *
 * Whoever writes {@link slots} outside this class (the kernel) says so with {@link markWritten}.
 */
export class FXInstancedParticle extends Mesh {
  public readonly slot: FXSlotLayout;
  /** Every slot back to back, `capacity * slot.stride` floats, zero-filled: every slot starts as
   *  `age 0 >= lifetime 0`, i.e. dead. */
  public readonly slots: Float32Array;
  /** Where the core fields lie in a slot. */
  public readonly core: FXCoreOffsets;

  private readonly instancedGeometry: InstancedBufferGeometry;
  private readonly buffer: InstancedInterleavedBuffer;
  // The views bound over the slots - the current render's (see `particleLayout`).
  private views: readonly FXPackedAttribute[] = [];
  private readonly capacity: number;

  // Next slot a birth claims (mod capacity), and how many slots are live / have ever been claimed.
  private cursor = 0;
  private liveCountInternal = 0;
  private highWaterMark = 0;
  // Births lost to a full ring: live particles overwritten plus births beyond capacity in one claim.
  private overflowCountInternal = 0;

  // Liveness before this tick's update, so a kill in it counts as a death.
  private liveBeforeUpdate = new Uint8Array(0);
  private liveBeforeUpdateCaptured = false;

  private sortingIndices: Int32Array = new Int32Array(0);
  private sortingSquaredDistances: Float64Array = new Float64Array(0);
  private sortingTemporaryBuffer: Float32Array = new Float32Array(0);

  constructor(
    slot: FXSlotLayout,
    views: readonly FXPackedAttribute[],
    capacity: number,
    material: Material,
    baseGeometry: BufferGeometry,
  ) {
    const instancedGeometry = new InstancedBufferGeometry();
    attachBaseGeometry(instancedGeometry, baseGeometry);

    super(instancedGeometry, material);

    this.frustumCulled = false;
    this.instancedGeometry = instancedGeometry;
    this.instancedGeometry.instanceCount = 0;
    this.capacity = capacity;
    this.slot = slot;
    this.core = coreOffsets(slot);

    this.slots = new Float32Array(capacity * slot.stride);
    this.buffer = new InstancedInterleavedBuffer(this.slots, slot.stride, 1);
    this.buffer.setUsage(StreamDrawUsage);
    this.mountViews(views);
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

    const { slots } = this;
    const { stride } = this.slot;
    const lifecycle = this.core.lifecycle;
    for (const range of ranges) {
      const end = range.start + range.count;
      for (let i = range.start; i < end; i++) {
        const offset = i * stride + lifecycle;
        if (slots[offset + FX_AGE] < slots[offset + FX_LIFETIME]) {
          this.overflowCountInternal += 1; // a live particle is overwritten
        } else {
          this.liveCountInternal += 1;
        }
      }
      // A reused slot still holds its previous occupant's state - most dangerously a stale
      // `age >= lifetime`, which no spawn graph can reset (the spawn target has no `age` slot).
      // Zero it so births start clean, fields the spawn kernel does not write included.
      slots.fill(0, range.start * stride, end * stride);
      this.markWritten(range.start, range.count);
      if (end > this.highWaterMark) {
        this.highWaterMark = end;
      }
    }
    this.syncDrawnInstances();
    return ranges;
  }

  /** Uploads slots `[start, start + count)` with the next render, on top of what is pending. */
  public markWritten(start: number, count: number): void {
    const { stride } = this.slot;
    markRange(this.buffer, start * stride, count * stride);
  }

  /**
   * Records which drawn slots are live before the tick's update, so {@link advanceAges} also
   * reports the deaths the update causes (kills). Required before an `advanceAges` with `onDeath`.
   */
  public captureLiveness(): void {
    if (this.liveBeforeUpdate.length !== this.capacity) {
      this.liveBeforeUpdate = new Uint8Array(this.capacity);
    }
    const { slots } = this;
    const { stride } = this.slot;
    const lifecycle = this.core.lifecycle;
    for (let i = 0; i < this.highWaterMark; i++) {
      const offset = i * stride + lifecycle;
      this.liveBeforeUpdate[i] = slots[offset + FX_AGE] < slots[offset + FX_LIFETIME] ? 1 : 0;
    }
    this.liveBeforeUpdateCaptured = true;
  }

  /**
   * Adds `deltaTime` to the age of every drawn slot and recounts the live ones. `onDeath` gets each
   * slot live before the update (see {@link captureLiveness}) and dead now.
   *
   * @throws When `onDeath` is given without a {@link captureLiveness} since the last call.
   */
  public advanceAges(deltaTime: number, onDeath?: (slot: number) => void): void {
    if (onDeath !== undefined && !this.liveBeforeUpdateCaptured) {
      throw new Error("FXInstancedParticle.advanceAges: deaths need captureLiveness() first");
    }
    this.liveBeforeUpdateCaptured = false;
    const { slots } = this;
    const { stride } = this.slot;
    const lifecycle = this.core.lifecycle;
    const liveBefore = this.liveBeforeUpdate;
    let live = 0;
    for (let i = 0; i < this.highWaterMark; i++) {
      const offset = i * stride + lifecycle;
      slots[offset + FX_AGE] += deltaTime;
      if (slots[offset + FX_AGE] < slots[offset + FX_LIFETIME]) {
        live += 1;
      } else if (onDeath !== undefined && liveBefore[i] === 1) {
        onDeath(i);
      }
    }
    this.liveCountInternal = live;
    this.markWritten(0, this.highWaterMark);
    this.syncDrawnInstances();
  }

  /**
   * Reorders the slots back-to-front for correct alpha blending. Distances are from each center as
   * stored: the shader projects positions as they are (it applies no `modelMatrix`, so the mesh's
   * transform moves nothing on screen), and so does this sort.
   *
   * Dead slots sort behind every live one, so a sort also gathers the live particles into
   * `[0, liveCount)`: the drawn range shrinks to them and the cursor restarts right after them,
   * so the next births reuse dead slots instead of overwriting live particles the sort scattered
   * around the ring. Slot stability is given up here by design - a sorted emitter keeps no
   * per-slot history (the editor rejects trails on one).
   */
  public sortByDistance(cameraWorldPosition: Vector3): void {
    // Shrinks the drawn range below: never call this while a trail records this mesh (a slot past
    // the new range would keep its recorded live points) - `FXEmitter` skips sorting then.
    const instanceCount = this.highWaterMark;
    if (instanceCount < 2) {
      return;
    }
    if (this.sortingIndices.length < instanceCount) {
      this.sortingIndices = new Int32Array(this.capacity);
      this.sortingSquaredDistances = new Float64Array(this.capacity);
      this.sortingTemporaryBuffer = new Float32Array(this.slots.length);
    }

    const { slots } = this;
    const { stride } = this.slot;
    const { position, lifecycle } = this.core;
    for (let particleIndex = 0; particleIndex < instanceCount; particleIndex++) {
      this.sortingIndices[particleIndex] = particleIndex;
      const offset = particleIndex * stride;
      if (slots[offset + lifecycle + FX_AGE] >= slots[offset + lifecycle + FX_LIFETIME]) {
        // Squared distances are never negative, so a dead slot lands behind every live one.
        this.sortingSquaredDistances[particleIndex] = -1;
        continue;
      }
      const deltaX = slots[offset + position + FX_POSITION_X] - cameraWorldPosition.x;
      const deltaY = slots[offset + position + FX_POSITION_Y] - cameraWorldPosition.y;
      const deltaZ = slots[offset + position + FX_POSITION_Z] - cameraWorldPosition.z;
      this.sortingSquaredDistances[particleIndex] =
        deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ;
    }

    const sortingSquaredDistances = this.sortingSquaredDistances;
    const sortingIndices = this.sortingIndices.subarray(0, instanceCount);
    sortingIndices.sort(
      (indexA, indexB) => sortingSquaredDistances[indexB] - sortingSquaredDistances[indexA],
    );

    const sorted = this.sortingTemporaryBuffer;
    for (let newIndex = 0; newIndex < instanceCount; newIndex++) {
      const source = sortingIndices[newIndex] * stride;
      sorted.set(slots.subarray(source, source + stride), newIndex * stride);
    }
    slots.set(sorted.subarray(0, instanceCount * stride));
    this.markWritten(0, instanceCount);

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
    this.slots.fill(0, 0, this.highWaterMark * this.slot.stride);
    this.markWritten(0, this.highWaterMark);
    this.cursor = 0;
    this.liveCountInternal = 0;
    this.highWaterMark = 0;
    this.syncDrawnInstances();
  }

  /**
   * Swaps the mounted material, base geometry and views in place for a render-only structural edit -
   * the slots ({@link slots}) and the current instance count are left completely untouched, so live
   * particles never reset; only the views bound over them follow the new render's reads. A new slot
   * means a new mesh (the driver is rebuilt).
   */
  public replaceMaterialAndBaseGeometry(
    material: Material,
    baseGeometry: BufferGeometry,
    views: readonly FXPackedAttribute[],
  ): void {
    detachBaseGeometry(this.instancedGeometry);
    attachBaseGeometry(this.instancedGeometry, baseGeometry);
    this.mountViews(views);

    // The mounted material IS disposable here (unlike the base geometry attributes above) - it was
    // built exclusively for this mesh, never shared.
    (this.material as Material | undefined)?.dispose();
    this.material = material;
  }

  // Disposes the instanced geometry and the currently mounted material - not the constructor one,
  // which a live material hot-swap may have replaced and disposed.
  public destroy(): void {
    detachBaseGeometry(this.instancedGeometry);
    this.instancedGeometry.dispose();
    (this.material as Material | undefined)?.dispose();
  }

  // Binds `views` over the slots, in place of the views bound so far - the same interleaved buffer,
  // so nothing is uploaded again.
  private mountViews(views: readonly FXPackedAttribute[]): void {
    remountParticleViews(
      this.instancedGeometry,
      this.views,
      views,
      (view) => new InterleavedBufferAttribute(this.buffer, view.components, view.offset),
    );
    this.views = views;
  }

  // Draws the drawn range while any particle is live, else nothing - an all-dead range would only
  // run the vertex shader to clip every instance.
  private syncDrawnInstances(): void {
    this.instancedGeometry.instanceCount = this.liveCountInternal > 0 ? this.highWaterMark : 0;
  }
}

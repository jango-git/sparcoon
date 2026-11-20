import type { InstancedBufferGeometry } from "three";
import { DynamicDrawUsage, InstancedBufferAttribute, InstancedInterleavedBuffer } from "three";

import { FX_AGE, FX_ID, FX_LIFETIME } from "../coreLayout.js";
import type { FXInstancedParticle } from "../instancedParticle/FXInstancedParticle.js";
import type { FXTransformFeedbackParticle } from "../instancedParticle/FXTransformFeedbackParticle.js";
import { markRange } from "../render/FXBufferUpload.Internal.js";
import {
  FX_TRAIL_FRAME_ATTRIBUTE,
  type FXStripLayout,
} from "../render/FXStripMaterial.Internal.js";
import {
  copyStripFields,
  type FXPlacedStripField,
  mountCPUStripPoints,
  mountGPUStripPoints,
  placeStripFields,
  stripPointTag,
  writeStripPoint,
} from "../strip/FXStripLayout.Internal.js";

/**
 * @internal The recorded past of every particle slot, for a trail to draw: a ring of `frames`
 * snapshots of the emitter's per-slot state, frame-major (`[frame][slot][field]`). The trail draws
 * one instanced segment per (frame `f`, slot) from the point at frame `f` to the point at `f + 1`,
 * both read from the same buffer at two fixed offsets a whole frame apart - so the history keeps
 * a copy of frame 0 after the last frame (a mirror) for the segment that wraps.
 *
 * A snapshot is taken per slot, and a slot is stable for a particle's whole life on both backends
 * (the fixed ring), so consecutive frames of one slot are one particle's path - until the slot is
 * reused, which the trail shader detects by the particle id differing between the two frames.
 * A never-written frame is all zeros, which reads as dead.
 *
 * Two layouts, one per backend, each named by {@link kind} so the trail shader reads it right:
 * - `"cpu"` (JS backend - and so the whole WebGL1 tier): packed for the WebGL1 attribute budget.
 *   Each point carries its position with the particle id (`id + 1`, `0` when dead) and its joint tangent
 *   with the time it was recorded, computed here; other fields only when the trail reads them, in
 *   the packing-friendly order `stripLayout` picks, several to an attribute.
 * - `"gpu"` (transform-feedback backend): whole particle slots copied inside video memory, plus a
 *   second mirror before frame 0, since the shader works the joint out from the previous point.
 */
export interface FXTrailHistory {
  readonly kind: "cpu" | "gpu";
  readonly frames: number;
  readonly capacity: number;
  /** What it records and how (from `stripLayout`): the fields recorded per point and
   *  interpolated along a segment, their packed views, and the trail's reads it does not hold. On
   *  `"cpu"` the position is not among the fields: it is packed into the point itself. */
  readonly layout: FXStripLayout;
  /** Nothing to draw as of the last record: no particle alive and every frame dead. Always false
   *  where that cannot be seen (`"gpu"`: age and death never leave the GPU). */
  readonly idle: boolean;
  /** Sets every attribute the trail shader reads for this layout onto `geometry`. */
  mount(geometry: InstancedBufferGeometry): void;
  /**
   * Snapshots the emitter's current state into frame `head` at trail time `time`. `advanced` says
   * the head just moved onto `head` this tick. Assumes the head moves at most one frame per call
   * (onto `(previous head + 1) % frames`): the upload and mirror bookkeeping covers only that.
   */
  record(head: number, advanced: boolean, time: number): void;
  /** Forgets every frame (all read as dead). */
  clear(): void;
  destroy(): void;
}

/** The per-instance history frame each segment starts at: `floor(instance / capacity)`. */
function segmentFrames(frames: number, capacity: number): InstancedBufferAttribute {
  const segments = frames * capacity;
  const frameOfSegment = new Float32Array(segments);
  for (let i = 0; i < segments; i++) {
    frameOfSegment[i] = Math.floor(i / capacity);
  }
  return new InstancedBufferAttribute(frameOfSegment, 1);
}

/**
 * @internal History of a JS-driven emitter: a CPU array filled from the particle slots each
 * recorded tick, except while idle (nothing alive, every frame dead). The first record after an
 * idle stretch uploads the whole array.
 *
 * A point's joint tangent is its position minus the particle's previous recorded point (zero for
 * the first point). The segment ending at a point and the one starting there read that one tangent,
 * so the ribbon has no seams and a point never changes once the head has moved past it.
 *
 * Each tick uploads one contiguous range, as three 0.157's single `updateRange` requires: the head
 * frame, or only its mirror while the head is frame 0, and frames 0..1 together on the tick the
 * head moves to frame 1. While the head is frame 0 the GPU copy of frame 0 still holds the point
 * recorded a lap ago. Only the segment starting at frame 0 reads it, and the shader rejects that
 * segment by its start time (older than the tail's, `FXTrailUniforms.tail`), not by the head.
 */
export class FXCPUTrailHistory implements FXTrailHistory {
  public readonly kind = "cpu";

  public readonly capacity: number;

  // Where each recorded field lies in a point and in the mesh's slot.
  private readonly placed: readonly FXPlacedStripField[];
  private readonly stride: number;
  private readonly array: Float32Array;
  private readonly buffer: InstancedInterleavedBuffer;
  // Frames holding at least one live point as of their last record; zero (with no particle alive)
  // means idle - see the class doc.
  private readonly frameLive: Uint8Array;
  private liveFrames = 0;
  // Records skipped as idle since the last real one, which then resyncs the whole GPU copy.
  private skippedRecords = false;

  /**
   * @param mesh - The emitter's particles. Its drawn range (every slot claimed since the last clear)
   *   must not shrink while this history is in use without a {@link clear} alongside - a slot past
   *   it would keep its last recorded point, live tag included.
   * @param layout - A `"cpu"` `stripLayout` over `mesh`'s slot: the fields to record beside
   *   the packed point, where in the point, and the point's stride - this decides none of it.
   */
  constructor(
    private readonly mesh: FXInstancedParticle,
    public readonly layout: FXStripLayout,
    public readonly frames: number,
  ) {
    if (layout.kind !== "cpu") {
      throw new Error("FXCPUTrailHistory: expected a cpu trail layout");
    }
    this.capacity = mesh.instanceCapacity;
    const capacity = this.capacity;
    this.placed = placeStripFields(layout, mesh.slot, "FXCPUTrailHistory");
    const stride = layout.stride;
    this.stride = stride;
    this.array = new Float32Array((frames + 1) * capacity * stride);
    this.buffer = new InstancedInterleavedBuffer(this.array, stride, 1);
    this.buffer.setUsage(DynamicDrawUsage);
    this.frameLive = new Uint8Array(frames);
  }

  // Nothing claimed since the last clear leaves every frame zero, as dead as an idle stretch.
  public get idle(): boolean {
    return this.skippedRecords || this.mesh.instanceCount === 0;
  }

  public mount(geometry: InstancedBufferGeometry): void {
    // The end point is one whole frame further on.
    mountCPUStripPoints(geometry, this.layout, this.buffer, this.capacity * this.stride);
  }

  public record(head: number, advanced: boolean, time: number): void {
    const stride = this.stride;
    const frameFloats = this.capacity * stride;
    // Slots past the drawn range were never claimed since the last clear: zero in the source and
    // in every frame alike, so they need no copy.
    const drawn = Math.min(this.mesh.instanceCount, this.capacity);
    if (drawn === 0) {
      // No slot claimed since the last clear (or ever): every frame is still all zeros.
      return;
    }
    if (this.liveFrames === 0 && this.mesh.liveCount === 0) {
      // Nothing alive, nothing left to fade: this record would only rewrite dead points.
      this.skippedRecords = true;
      return;
    }
    const base = head * frameFloats;
    const previous = ((head + this.frames - 1) % this.frames) * frameFloats;
    const { slots: source, core } = this.mesh;
    const sourceStride = this.mesh.slot.stride;
    const array = this.array;
    let anyAlive = false;
    for (let slot = 0; slot < drawn; slot++) {
      const point = base + slot * stride;
      const before = previous + slot * stride;
      const lifecycle = slot * sourceStride + core.lifecycle;
      const alive = source[lifecycle + FX_AGE] < source[lifecycle + FX_LIFETIME];
      const tag = alive ? source[lifecycle + FX_ID] + 1 : 0;
      anyAlive ||= alive;
      // Linked to the previous frame's point while it holds the same particle.
      const linked = tag > 0 && stripPointTag(array, before) === tag ? before : -1;
      writeStripPoint(array, point, source, slot * sourceStride + core.position, tag, linked, time);
    }
    copyStripFields(this.placed, source, sourceStride, 0, array, stride, base, drawn);
    if (anyAlive !== (this.frameLive[head] === 1)) {
      this.frameLive[head] = anyAlive ? 1 : 0;
      this.liveFrames += anyAlive ? 1 : -1;
    }
    if (head === 0) {
      array.copyWithin(this.frames * frameFloats, 0, drawn * stride);
    }
    if (this.skippedRecords) {
      // The GPU copy missed whatever the idle stretch's head moves left out: resync it whole.
      this.skippedRecords = false;
      markRange(this.buffer, 0, this.array.length);
    } else if (head === 0) {
      markRange(this.buffer, this.frames * frameFloats, drawn * stride);
    } else if (head === 1 && advanced) {
      markRange(this.buffer, 0, 2 * frameFloats);
    } else {
      markRange(this.buffer, base, drawn * stride);
    }
  }

  public clear(): void {
    this.array.fill(0);
    this.frameLive.fill(0);
    this.liveFrames = 0;
    this.skippedRecords = false;
    markRange(this.buffer, 0, this.array.length);
  }

  // The array is the only resource; disposing the trail geometry releases three's GPU copy.
  public destroy(): void {}
}

/**
 * @internal History of a GPU-driven emitter: a raw `WebGLBuffer` of whole interleaved particle
 * slots, filled by `copyBufferSubData` from the half of the transform-feedback pair the renderer
 * draws - a copy inside video memory, nothing crosses to the CPU.
 *
 * `frames + 2` physical frames: frame `f` lives at `f + 1`, with a mirror of the last frame before
 * it and a mirror of frame 0 after it, so a segment reads its previous point (for the joint), its
 * start and its end at three fixed offsets. The shader works the joint tangent out from those, and
 * a segment's age from the per-frame ages uniform, since a slot copy cannot carry either.
 */
export class FXGPUTrailHistory implements FXTrailHistory {
  public readonly kind = "gpu";
  public readonly idle = false;
  public readonly capacity: number;

  private readonly buffer: WebGLBuffer;
  private readonly slotBytes: number;

  /**
   * @param layout - A `"gpu"` `stripLayout` over `mesh`'s slot: the views of the recorded
   *   fields (position and lifecycle among them, which the shader links points into segments by)
   *   and of the previous point - this decides none of it.
   */
  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly mesh: FXTransformFeedbackParticle,
    public readonly layout: FXStripLayout,
    public readonly frames: number,
  ) {
    if (layout.kind !== "gpu" || layout.stride !== mesh.slot.stride) {
      throw new Error("FXGPUTrailHistory: expected a gpu trail layout over this mesh's slot");
    }
    this.capacity = mesh.capacity;
    this.slotBytes = mesh.slot.stride * Float32Array.BYTES_PER_ELEMENT;
    this.buffer = gl.createBuffer();
    this.clear();
  }

  public mount(geometry: InstancedBufferGeometry): void {
    const frameFloats = this.capacity * this.mesh.slot.stride;
    // Physical frame 0 is the mirror before frame 0: the previous point of a segment starting at
    // frame f is at physical f, its start at f + 1 and its end at f + 2.
    mountGPUStripPoints(
      this.gl,
      geometry,
      this.layout,
      this.buffer,
      (this.frames + 2) * this.capacity,
      {
        previous: 0,
        start: frameFloats,
        end: 2 * frameFloats,
      },
    );
    geometry.setAttribute(FX_TRAIL_FRAME_ATTRIBUTE, segmentFrames(this.frames, this.capacity));
  }

  public record(head: number): void {
    const gl = this.gl;
    const frameBytes = this.capacity * this.slotBytes;
    // The copy targets are not part of three's tracked state, and the source is not bound for
    // transform feedback any more once the tick's pass has ended.
    gl.bindBuffer(gl.COPY_READ_BUFFER, this.mesh.readBuffer());
    gl.bindBuffer(gl.COPY_WRITE_BUFFER, this.buffer);
    const copyTo = (physicalFrame: number): void => {
      gl.copyBufferSubData(
        gl.COPY_READ_BUFFER,
        gl.COPY_WRITE_BUFFER,
        0,
        physicalFrame * frameBytes,
        frameBytes,
      );
    };
    copyTo(head + 1);
    if (head === 0) {
      copyTo(this.frames + 1);
    }
    if (head === this.frames - 1) {
      copyTo(0);
    }
    gl.bindBuffer(gl.COPY_READ_BUFFER, null);
    gl.bindBuffer(gl.COPY_WRITE_BUFFER, null);
  }

  /** Reallocates the buffer, which WebGL zero-fills: every frame reads as dead. */
  public clear(): void {
    const gl = this.gl;
    gl.bindBuffer(gl.COPY_WRITE_BUFFER, this.buffer);
    gl.bufferData(
      gl.COPY_WRITE_BUFFER,
      (this.frames + 2) * this.capacity * this.slotBytes,
      gl.DYNAMIC_DRAW,
    );
    gl.bindBuffer(gl.COPY_WRITE_BUFFER, null);
  }

  /**
   * Deletes the buffer. three deletes it too once the trail geometry that drew it is disposed
   * (it registers a raw buffer it was handed); a second delete is a no-op in WebGL, and this one
   * covers a trail that was never drawn, which three never registered.
   */
  public destroy(): void {
    this.gl.deleteBuffer(this.buffer);
  }
}

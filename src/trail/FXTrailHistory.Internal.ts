import type { InstancedBufferGeometry } from "three";
import {
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
} from "three";
import { FX_AGE, FX_ID, FX_LIFETIME } from "../coreLayout.js";
import type { FXInstancedParticle } from "../instancedParticle/FXInstancedParticle.js";
import type { FXTransformFeedbackParticle } from "../instancedParticle/FXTransformFeedbackParticle.js";
import { FXInterleavedGLAttribute } from "../instancedParticle/FXTransformFeedbackParticle.js";
import { mountPacked } from "../instancedParticle/FXMeshGeometry.Internal.js";
import type { FXTrailLayout } from "../render/FXArtifactMaterial.Internal.js";
import {
  FX_TRAIL_CPU_POINT,
  FX_TRAIL_CPU_TANGENT,
  FX_TRAIL_FRAME_ATTRIBUTE,
  trailAttributeNames,
  trailPreviousAttributeName,
} from "../render/FXArtifactMaterial.Internal.js";
import type { FXPackedAttribute } from "../render/FXAttributePacking.js";
import { markRange } from "../render/FXBufferUpload.Internal.js";

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
 *   the packing-friendly order `trailHistoryLayout` picks, several to an attribute.
 * - `"gpu"` (transform-feedback backend): whole particle slots copied inside video memory, plus a
 *   second mirror before frame 0, since the shader works the joint out from the previous point.
 */
export interface FXTrailHistory {
  readonly kind: "cpu" | "gpu";
  readonly frames: number;
  readonly capacity: number;
  /** What it records and how (from `trailHistoryLayout`): the fields recorded per point and
   *  interpolated along a segment, their packed views, and the trail's reads it does not hold. On
   *  `"cpu"` the position is not among the fields: it is packed into the point itself. */
  readonly layout: FXTrailLayout;
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

/** One recorded field's place in a history point, in floats. */
interface FXHistoryField {
  readonly name: string;
  readonly components: number;
  readonly offset: number;
}

/** A point's own vec4s in a `"cpu"` history, ahead of its recorded fields - views carrying no
 *  particle field, mounted alongside the layout's packed ones. */
const CPU_POINT_VIEWS: readonly FXPackedAttribute[] = [
  { name: FX_TRAIL_CPU_POINT, offset: 0, components: 4, members: [] },
  { name: FX_TRAIL_CPU_TANGENT, offset: 4, components: 4, members: [] },
];

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
 * @internal History of a JS-driven emitter: a CPU array the trail's attributes read through three,
 * filled from the emitter's particle slots each recorded tick - except while it
 * is idle: no particle alive, and every frame already dead, so a record would change nothing
 * visible. The first record after an idle stretch uploads the whole array once, which keeps the
 * GPU copy exact without tracking what the skipped ticks left behind.
 *
 * A point's joint tangent is its position minus the previous recorded point of the same particle
 * (zero for a particle's first point): the direction it arrived from. The segment ending at a
 * point and the one starting there both read that one tangent, so their shared vertices are the
 * same - a seamless ribbon - and a point never changes once the head has moved past it.
 *
 * So every tick uploads one contiguous range, which three 0.157's single `updateRange` covers: the
 * head frame, or - while the head is frame 0 - only its mirror, and frames 0..1 together on the
 * tick the head moves on to frame 1, when frame 0 becomes readable with the state the mirror holds.
 * While the head is frame 0, the GPU copy of frame 0 still holds the point recorded there a lap
 * ago. Only the segment starting at frame 0 reads it, and the shader rejects that segment by its
 * start time - older than the tail's (`FXTrailUniforms.tail`) - not by the head (this layout
 * carries no frame index).
 */
export class FXCPUTrailHistory implements FXTrailHistory {
  public readonly kind = "cpu";

  public readonly capacity: number;

  // Where each recorded field lies in a point (read off the layout's packed views), and where it
  // lies in the mesh's slot.
  private readonly placed: readonly (FXHistoryField & { readonly from: number })[];
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
   * @param layout - A `"cpu"` `trailHistoryLayout` over `mesh`'s slot: the fields to record beside
   *   the packed point, where in the point, and the point's stride - this decides none of it.
   */
  constructor(
    private readonly mesh: FXInstancedParticle,
    public readonly layout: FXTrailLayout,
    public readonly frames: number,
  ) {
    if (layout.kind !== "cpu") {
      throw new Error("FXCPUTrailHistory: expected a cpu trail layout");
    }
    this.capacity = mesh.instanceCapacity;
    const capacity = this.capacity;
    this.placed = layout.packed.flatMap((view) =>
      view.members.map((member) => {
        const from = mesh.slot.fields.find((field) => field.name === member.name);
        if (from === undefined) {
          throw new Error(`FXCPUTrailHistory: the slot lacks the recorded "${member.name}"`);
        }
        return {
          name: member.name,
          components: member.components,
          offset: view.offset + member.componentOffset,
          from: from.offset,
        };
      }),
    );
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
    const frameFloats = this.capacity * this.stride;
    const views = [...CPU_POINT_VIEWS, ...this.layout.packed];
    // Each view twice: at the segment's start, and one whole frame further on at its end.
    for (const [end, frameOffset] of [
      ["a", 0],
      ["b", frameFloats],
    ] as const) {
      mountPacked(
        geometry,
        views,
        (view) => trailAttributeNames(view.name)[end],
        (view) =>
          new InterleavedBufferAttribute(this.buffer, view.components, frameOffset + view.offset),
      );
    }
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
      const position = slot * sourceStride + core.position;
      const lifecycle = slot * sourceStride + core.lifecycle;
      const x = source[position];
      const y = source[position + 1];
      const z = source[position + 2];
      const alive = source[lifecycle + FX_AGE] < source[lifecycle + FX_LIFETIME];
      // The particle's id + 1, or 0 when dead - so a zero-filled (never written) point is dead.
      const tag = alive ? source[lifecycle + FX_ID] + 1 : 0;
      anyAlive ||= alive;
      const continues = tag > 0 && array[before + 3] === tag;
      array[point] = x;
      array[point + 1] = y;
      array[point + 2] = z;
      array[point + 3] = tag;
      array[point + 4] = continues ? x - array[before] : 0;
      array[point + 5] = continues ? y - array[before + 1] : 0;
      array[point + 6] = continues ? z - array[before + 2] : 0;
      array[point + 7] = time;
    }
    for (const field of this.placed) {
      for (let slot = 0; slot < drawn; slot++) {
        const target = base + slot * stride + field.offset;
        const origin = slot * sourceStride + field.from;
        for (let c = 0; c < field.components; c++) {
          array[target + c] = source[origin + c];
        }
      }
    }
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
   * @param layout - A `"gpu"` `trailHistoryLayout` over `mesh`'s slot: the views of the recorded
   *   fields (position and lifecycle among them, which the shader links points into segments by)
   *   and of the previous point - this decides none of it.
   */
  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly mesh: FXTransformFeedbackParticle,
    public readonly layout: FXTrailLayout,
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
    const { stride } = this.mesh.slot;
    const points = (this.frames + 2) * this.capacity;
    const frameFloats = this.capacity * stride;
    // Physical frame 0 is the mirror before frame 0: the previous point of a segment starting at
    // frame f is at physical f, its start at f + 1 and its end at f + 2.
    const mount = (
      views: readonly FXPackedAttribute[],
      name: (view: FXPackedAttribute) => string,
      frameOffset: number,
    ): void => {
      mountPacked(
        geometry,
        views,
        name,
        (view) =>
          new FXInterleavedGLAttribute(
            this.gl,
            this.buffer,
            view.components,
            frameOffset + view.offset,
            stride,
            points,
          ),
      );
    };
    mount(this.layout.packed, (view) => trailAttributeNames(view.name).a, frameFloats);
    mount(this.layout.packed, (view) => trailAttributeNames(view.name).b, 2 * frameFloats);
    mount(this.layout.previous, (view) => trailPreviousAttributeName(view.name), 0);
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

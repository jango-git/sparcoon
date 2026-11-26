import type { InstancedBufferGeometry } from "three";
import { DynamicDrawUsage, InstancedInterleavedBuffer } from "three";

import { FX_AGE, FX_ID, FX_LIFETIME, FX_PARTICLE_ID_RANGE } from "../coreLayout.js";
import {
  type FXCPUBirthProbe,
  type FXGPUBirthProbe,
  headOf,
} from "../emitter/FXBirthProbe.Internal.js";
import type { FXInstancedParticle } from "../instancedParticle/FXInstancedParticle.js";
import type { FXTransformFeedbackParticle } from "../instancedParticle/FXTransformFeedbackParticle.js";
import { markRange } from "../render/FXBufferUpload.Internal.js";
import type { FXStripLayout } from "../render/FXStripMaterial.Internal.js";
import type { FXStripFrame } from "../strip/FXStrip.Internal.js";
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
 * @internal What a ribbon draws: every particle slot of its emitter as one point, in birth order -
 * from the slot the next birth takes (the oldest particle once the ring has gone round) to the
 * newest - then its head: the particle a birth would seed now (see `FXBirthProbe`) while the ribbon
 * has one and a play emits from the emitter's pose, a dead point otherwise. The segment from each
 * point to the next reads its points (and, on `"gpu"`, the point before) at fixed offsets.
 *
 * Consecutive slots hold consecutive births on both backends, so a point's particle was born right
 * after the previous point's - while the two ids follow each other (see `FX_PARTICLE_ID_RANGE`).
 * Where they do not (a slot not reused yet, a burst past the ring, a particle that died before its
 * neighbours), and before a particle that starts a section (see `FXRibbonOptions.section`), the
 * shader leaves the segment out. The head takes the next birth's id, so it links to the newest
 * particle by the same rule.
 *
 * Laid out by `stripLayout`, as a trail's history of one frame would be, so the two share their
 * packing and budget:
 * - `"cpu"` (JS backend): packed points filled each tick; a point's joint tangent is its position
 *   minus the previous point's when the two are linked, and the tangent's `w` is the point's
 *   `p_uv.x` (see `ribbonPrologue`).
 * - `"gpu"` (transform-feedback backend): whole slots copied inside video memory.
 */
export interface FXRibbonPoints {
  readonly kind: "cpu" | "gpu";
  readonly capacity: number;
  readonly layout: FXStripLayout;
  /** How many segments to draw as of the last record: 0 when nothing can show. */
  readonly segments: number;
  /** Sets every attribute the ribbon shader reads for this layout onto `geometry`. */
  mount(geometry: InstancedBufferGeometry): void;
  /** Takes the emitter's current state; seeds the head on a tick that simulated time. */
  record(frame: FXStripFrame): void;
  /** Forgets every point (all read as dead). */
  clear(): void;
  destroy(): void;
}

/**
 * @internal The points of a JS-driven emitter's ribbon: a CPU array its attributes read through
 * three, filled from the emitter's drawn slots each record while any particle is alive - `capacity`
 * points of the ring, then the head. Before the ring has gone round the drawn slots run from slot 0
 * in birth order, and the head follows the last of them.
 */
export class FXCPURibbonPoints implements FXRibbonPoints {
  public readonly kind = "cpu";
  public readonly capacity: number;

  private readonly placed: readonly FXPlacedStripField[];
  private readonly stride: number;
  private readonly array: Float32Array;
  private readonly buffer: InstancedInterleavedBuffer;
  private segmentCount = 0;

  /**
   * @param layout - A `"cpu"` `stripLayout` over `mesh`'s slot.
   * @param counts - `tile`: particles per repeat of `p_uv.x`, or 0 for each point's age over its
   *   lifetime; `section`: particles per section, or 0 for none (see `FXRibbonOptions`).
   * @param probe - The head, seeded over `mesh`'s slot; none for a ribbon without one.
   */
  constructor(
    private readonly mesh: FXInstancedParticle,
    public readonly layout: FXStripLayout,
    private readonly counts: { readonly tile: number; readonly section: number },
    private readonly probe: FXCPUBirthProbe | undefined,
  ) {
    if (layout.kind !== "cpu") {
      throw new Error("FXCPURibbonPoints: expected a cpu layout");
    }
    this.capacity = mesh.instanceCapacity;
    this.placed = placeStripFields(layout, mesh.slot, "FXCPURibbonPoints");
    this.stride = layout.stride;
    this.array = new Float32Array((this.capacity + 1) * this.stride);
    this.buffer = new InstancedInterleavedBuffer(this.array, this.stride, 1);
    this.buffer.setUsage(DynamicDrawUsage);
  }

  public get segments(): number {
    return this.segmentCount;
  }

  public mount(geometry: InstancedBufferGeometry): void {
    // The end point is the next one.
    mountCPUStripPoints(geometry, this.layout, this.buffer, this.stride);
  }

  public record(frame: FXStripFrame): void {
    const head = headOf(this.probe, frame);
    const drawn = Math.min(this.mesh.instanceCount, this.capacity);
    if (drawn === 0 || this.mesh.liveCount === 0) {
      // Nothing alive: nothing to link, and nothing uploaded until there is.
      this.segmentCount = 0;
      return;
    }
    const source = this.mesh.slots;
    const sourceStride = this.mesh.slot.stride;
    const { array, stride, placed } = this;
    // Oldest first: from the cursor once the ring has gone round, from slot 0 before.
    const first = drawn === this.capacity ? this.mesh.nextSlot : 0;
    const run = drawn - first;
    for (let point = 0; point < drawn; point++) {
      const slot = point < run ? first + point : point - run;
      this.writePoint(point, source, slot * sourceStride);
    }
    copyStripFields(placed, source, sourceStride, first, array, stride, 0, run);
    copyStripFields(placed, source, sourceStride, 0, array, stride, run * stride, first);
    // The segment from the newest point ends at the head, or at a zero point: left out.
    if (head === undefined) {
      array.fill(0, drawn * stride, (drawn + 1) * stride);
    } else {
      this.writePoint(drawn, head.slot, 0);
      copyStripFields(placed, head.slot, sourceStride, 0, array, stride, drawn * stride, 1);
    }
    markRange(this.buffer, 0, (drawn + 1) * stride);
    this.segmentCount = drawn;
  }

  public clear(): void {
    this.array.fill(0);
    this.probe?.clear();
    this.segmentCount = 0;
    markRange(this.buffer, 0, this.array.length);
  }

  // The array is the only resource; disposing the ribbon geometry releases three's GPU copy.
  public destroy(): void {}

  // Point `point` from the particle whose slot starts at float `base` of `source`, linked to the
  // point before when that one holds the particle born right before, in the same section.
  private writePoint(point: number, source: Float32Array, base: number): void {
    const { array, stride } = this;
    const { tile, section } = this.counts;
    const { core } = this.mesh;
    const at = point * stride;
    const lifecycle = base + core.lifecycle;
    const age = source[lifecycle + FX_AGE];
    const lifetime = source[lifecycle + FX_LIFETIME];
    const id = source[lifecycle + FX_ID];
    const alive = age < lifetime;
    // The point before holds its particle's id + 1 (0 when dead, or when there is none).
    const before = point > 0 ? stripPointTag(array, at - stride) : 0;
    const sectionStart = section > 0 && id % section === 0;
    const linked =
      alive && !sectionStart && before > 0 && before % FX_PARTICLE_ID_RANGE === id
        ? at - stride
        : -1;
    const u = tile > 0 ? (tile - (id % tile)) / tile : alive ? age / lifetime : 1;
    writeStripPoint(array, at, source, base + core.position, alive ? id + 1 : 0, linked, u);
  }
}

/**
 * @internal The points of a GPU-driven emitter's ribbon: a raw `WebGLBuffer` of whole interleaved
 * particle slots, copied by `copyBufferSubData` from the half of the transform-feedback pair the
 * renderer draws (and from the head's probe), every record - a copy inside video memory, nothing
 * crosses to the CPU. Physical point 0 is never written - the dead point before the oldest -
 * points `1..capacity` are the ring in birth order, and point `capacity + 1` is the head. Before
 * the ring has gone round its never-claimed slots come first, dead, so the newest is still last.
 */
export class FXGPURibbonPoints implements FXRibbonPoints {
  public readonly kind = "gpu";
  public readonly capacity: number;

  private readonly buffer: WebGLBuffer;
  private readonly slotBytes: number;
  // What the head point is set back to once the head stops showing.
  private readonly deadSlot: Float32Array;
  private headShown = false;
  private segmentCount = 0;

  /**
   * @param layout - A `"gpu"` `stripLayout` over `mesh`'s slot.
   * @param probe - The head, seeded over `mesh`'s slot; none for a ribbon without one.
   */
  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly mesh: FXTransformFeedbackParticle,
    public readonly layout: FXStripLayout,
    private readonly probe: FXGPUBirthProbe | undefined,
  ) {
    if (layout.kind !== "gpu" || layout.stride !== mesh.slot.stride) {
      throw new Error("FXGPURibbonPoints: expected a gpu layout over this mesh's slot");
    }
    this.capacity = mesh.capacity;
    this.slotBytes = mesh.slot.stride * Float32Array.BYTES_PER_ELEMENT;
    this.deadSlot = new Float32Array(mesh.slot.stride);
    this.buffer = gl.createBuffer();
    this.clear();
  }

  // Whether a slot is alive never leaves the GPU: every segment is drawn once recorded.
  public get segments(): number {
    return this.segmentCount;
  }

  public mount(geometry: InstancedBufferGeometry): void {
    const { stride } = this.mesh.slot;
    // The segment from point p reads its previous point at physical p, its start at p + 1 and its
    // end at p + 2.
    mountGPUStripPoints(this.gl, geometry, this.layout, this.buffer, this.capacity + 2, {
      previous: 0,
      start: stride,
      end: 2 * stride,
    });
  }

  public record(frame: FXStripFrame): void {
    const head = headOf(this.probe, frame);
    const gl = this.gl;
    const { slotBytes, capacity } = this;
    const first = this.mesh.nextSlot;
    // The copy targets are not part of three's tracked state, and the source is not bound for
    // transform feedback any more once the tick's pass has ended.
    gl.bindBuffer(gl.COPY_READ_BUFFER, this.mesh.readBuffer());
    gl.bindBuffer(gl.COPY_WRITE_BUFFER, this.buffer);
    gl.copyBufferSubData(
      gl.COPY_READ_BUFFER,
      gl.COPY_WRITE_BUFFER,
      first * slotBytes,
      slotBytes,
      (capacity - first) * slotBytes,
    );
    if (first > 0) {
      gl.copyBufferSubData(
        gl.COPY_READ_BUFFER,
        gl.COPY_WRITE_BUFFER,
        0,
        (capacity - first + 1) * slotBytes,
        first * slotBytes,
      );
    }
    const headPoint = (capacity + 1) * slotBytes;
    if (head !== undefined) {
      gl.bindBuffer(gl.COPY_READ_BUFFER, head.buffer);
      gl.copyBufferSubData(gl.COPY_READ_BUFFER, gl.COPY_WRITE_BUFFER, 0, headPoint, slotBytes);
    } else if (this.headShown) {
      gl.bufferSubData(gl.COPY_WRITE_BUFFER, headPoint, this.deadSlot);
    }
    this.headShown = head !== undefined;
    gl.bindBuffer(gl.COPY_READ_BUFFER, null);
    gl.bindBuffer(gl.COPY_WRITE_BUFFER, null);
    this.segmentCount = capacity;
  }

  /** Reallocates the buffer, which WebGL zero-fills: every point reads as dead. */
  public clear(): void {
    const gl = this.gl;
    gl.bindBuffer(gl.COPY_WRITE_BUFFER, this.buffer);
    gl.bufferData(gl.COPY_WRITE_BUFFER, (this.capacity + 2) * this.slotBytes, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.COPY_WRITE_BUFFER, null);
    this.probe?.clear();
    this.headShown = false;
    this.segmentCount = 0;
  }

  /**
   * Deletes the buffer (and the head's). three deletes the points buffer too once the ribbon
   * geometry that drew it is disposed (it registers a raw buffer it was handed); a second delete is
   * a no-op in WebGL, and this one covers a ribbon that was never drawn, which three never
   * registered.
   */
  public destroy(): void {
    this.gl.deleteBuffer(this.buffer);
    this.probe?.destroy();
  }
}

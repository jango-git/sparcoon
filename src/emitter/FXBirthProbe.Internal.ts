import type { FXEmitterTransform } from "../artifact/FXArtifact.js";
import type { FXStripFrame } from "../strip/FXStrip.Internal.js";

/**
 * @internal The particle a birth from a pose would seed now: spawned by the behavior's own spawn
 * code into one slot of its own, outside the ring, with the id the next birth will take. It claims
 * no slot, advances no id and reports no event - the emitter's particles never see it. A ribbon
 * ends at it, so its head reaches where the next particle will be born.
 *
 * Until seeded, and once cleared, the slot is zero: a dead particle.
 */
export interface FXBirthProbe {
  /** Seeds the slot from `transform` and `inherited`, as a birth there would be seeded now. */
  seed(transform: FXEmitterTransform, inherited: Float32Array): void;
  clear(): void;
  destroy(): void;
}

/**
 * `probe` when the head it holds shows after the tick `frame` describes - while a birth from the
 * emitter's pose is due - reseeded on a tick that simulated time (a paused tick keeps the head
 * where it was); `undefined` otherwise, and for no probe.
 */
export function headOf<P extends FXBirthProbe>(
  probe: P | undefined,
  { deltaTime, birth }: FXStripFrame,
): P | undefined {
  if (probe === undefined || birth === undefined) {
    return undefined;
  }
  if (deltaTime > 0) {
    probe.seed(birth.transform, birth.inherited);
  }
  return probe;
}

/** Writes the particle a birth from `transform` would seed into `slot`, which is zero. */
export type FXCPUBirthSeeder = (
  slot: Float32Array,
  transform: FXEmitterTransform,
  inherited: Float32Array,
) => void;

/** @internal A JS-driven emitter's birth probe: one slot of `stride` floats. */
export class FXCPUBirthProbe implements FXBirthProbe {
  public readonly slot: Float32Array;

  constructor(
    stride: number,
    private readonly seeder: FXCPUBirthSeeder,
  ) {
    this.slot = new Float32Array(stride);
  }

  public seed(transform: FXEmitterTransform, inherited: Float32Array): void {
    // A birth starts from a zeroed slot, as a claimed one does.
    this.slot.fill(0);
    this.seeder(this.slot, transform, inherited);
  }

  public clear(): void {
    this.slot.fill(0);
  }

  public destroy(): void {}
}

/** Writes the particle a birth from `transform` would seed into `buffer`, one whole slot. */
export type FXGPUBirthSeeder = (
  buffer: WebGLBuffer,
  transform: FXEmitterTransform,
  inherited: Float32Array,
) => void;

/** @internal A GPU-driven emitter's birth probe: a buffer of one slot, written by the kernel. */
export class FXGPUBirthProbe implements FXBirthProbe {
  public readonly buffer: WebGLBuffer;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly slotBytes: number,
    private readonly seeder: FXGPUBirthSeeder,
  ) {
    this.buffer = gl.createBuffer();
    this.clear();
  }

  public seed(transform: FXEmitterTransform, inherited: Float32Array): void {
    this.seeder(this.buffer, transform, inherited);
  }

  /** Reallocates the buffer, which WebGL zero-fills. */
  public clear(): void {
    const gl = this.gl;
    gl.bindBuffer(gl.COPY_WRITE_BUFFER, this.buffer);
    gl.bufferData(gl.COPY_WRITE_BUFFER, this.slotBytes, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.COPY_WRITE_BUFFER, null);
  }

  public destroy(): void {
    this.gl.deleteBuffer(this.buffer);
  }
}

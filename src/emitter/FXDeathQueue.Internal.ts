import { coreOffsets, type FXSlotLayout } from "../instancedParticle/FXParticleSlot.js";
import type { FXParticleDeathListener } from "./FXEmitter.Internal.js";
import type { FXParticleDeathSink } from "./FXEmitterDriver.Internal.js";

// Numbers a queued death holds ahead of its slot: its velocity xyz.
const VELOCITY_STRIDE = 3;

/**
 * @internal The deaths an emitter's ticks found, held until the whole world ticked and then handed
 * to its listeners: each one's velocity and a copy of its whole slot, taken while the driver
 * reports it - a birth later in the same tick may claim the slot. Two queues swapped per hand-out:
 * a death is taken off the pending one before any listener sees it, so one that throws never sees
 * it again.
 */
export class FXDeathQueue {
  private pending: number[] = [];
  private dispatching: number[] = [];
  private readonly recordStride: number;
  // Where a death's slot keeps its position.
  private readonly positionOffset: number;
  // The one object every listener call receives (see FXParticleDeath).
  private readonly death: { position: number[]; velocity: number[]; slot: Float32Array };

  constructor(slot: FXSlotLayout) {
    this.recordStride = VELOCITY_STRIDE + slot.stride;
    this.positionOffset = coreOffsets(slot).position;
    this.death = {
      position: [0, 0, 0],
      velocity: [0, 0, 0],
      slot: new Float32Array(slot.stride),
    };
  }

  /** The driver's death sink: queues one death. */
  public readonly record: FXParticleDeathSink = (
    slots,
    offset,
    velocityX,
    velocityY,
    velocityZ,
  ) => {
    const pending = this.pending;
    pending.push(velocityX, velocityY, velocityZ);
    const end = offset + this.death.slot.length;
    for (let field = offset; field < end; field += 1) {
      pending.push(slots[field]);
    }
  };

  /**
   * Hands every queued death to `listeners`, in order. A listener may {@link clear} the queue,
   * which drops the deaths not handed out yet.
   */
  public dispatch(listeners: readonly FXParticleDeathListener[]): void {
    if (this.pending.length === 0) {
      return;
    }
    const deaths = this.pending;
    this.pending = this.dispatching;
    this.dispatching = deaths;
    const { death, positionOffset } = this;
    const { slot } = death;
    try {
      for (let offset = 0; offset < deaths.length; offset += this.recordStride) {
        death.velocity[0] = deaths[offset];
        death.velocity[1] = deaths[offset + 1];
        death.velocity[2] = deaths[offset + 2];
        for (let field = 0; field < slot.length; field += 1) {
          slot[field] = deaths[offset + VELOCITY_STRIDE + field];
        }
        death.position[0] = slot[positionOffset];
        death.position[1] = slot[positionOffset + 1];
        death.position[2] = slot[positionOffset + 2];
        for (const listener of listeners) {
          listener(death);
        }
      }
    } finally {
      deaths.length = 0;
    }
  }

  /** Drops the deaths not handed out yet - those queued, and those of a hand-out in progress. */
  public clear(): void {
    this.pending.length = 0;
    this.dispatching.length = 0;
  }

  /** Drops the deaths queued since the last hand-out. */
  public clearPending(): void {
    this.pending.length = 0;
  }
}

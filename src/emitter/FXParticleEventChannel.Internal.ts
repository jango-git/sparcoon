import { coreOffsets, type FXSlotLayout } from "../instancedParticle/FXParticleSlot.js";
import type { FXParticleEventListener } from "./FXEmitter.Internal.js";
import type { FXParticleEventSink } from "./FXEmitterDriver.Internal.js";

// Numbers a queued event holds ahead of its slot: its velocity xyz.
const VELOCITY_STRIDE = 3;

/**
 * @internal One kind of particle event of an emitter (births or deaths): its listeners, and the
 * events its ticks found, held until the whole world ticked and then handed to them. Each event
 * keeps its velocity and a copy of its whole slot, taken while the driver reports it - a later
 * birth in the same tick may claim the slot. The driver reports only while a listener is attached
 * (`watch`).
 *
 * Two queues swapped per hand-out: an event is taken off the pending one before any listener sees
 * it, so one that throws never sees it again.
 */
export class FXParticleEventChannel {
  private readonly listeners = new Set<FXParticleEventListener>();
  private pending: number[] = [];
  private dispatching: number[] = [];
  private readonly recordStride: number;
  // Where an event's slot keeps its position.
  private readonly positionOffset: number;
  // The one object every listener call receives (see FXParticleEvent).
  private readonly event: { position: number[]; velocity: number[]; slot: Float32Array };

  /** `watch` starts (a sink) or stops (`undefined`) the driver's reports of this kind. */
  constructor(
    slot: FXSlotLayout,
    private readonly watch: (sink: FXParticleEventSink | undefined) => void,
  ) {
    this.recordStride = VELOCITY_STRIDE + slot.stride;
    this.positionOffset = coreOffsets(slot).position;
    this.event = {
      position: [0, 0, 0],
      velocity: [0, 0, 0],
      slot: new Float32Array(slot.stride),
    };
  }

  /**
   * Attaches `listener`; the first one starts the driver's reports.
   * @returns Detaches it; the last one stops the reports. Events already queued are still handed
   *   to the listeners attached when they are (the hand-out snapshots them).
   */
  public listen(listener: FXParticleEventListener): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      this.watch(this.record);
    }
    return (): void => {
      if (this.listeners.delete(listener) && this.listeners.size === 0) {
        this.watch(undefined);
      }
    };
  }

  /**
   * Hands every queued event to the listeners, in order. A listener may detach itself (or
   * another), or {@link clear} the queue, which drops the events not handed out yet.
   */
  public dispatch(): void {
    if (this.pending.length === 0) {
      return;
    }
    const listeners = [...this.listeners];
    const events = this.pending;
    this.pending = this.dispatching;
    this.dispatching = events;
    const { event, positionOffset } = this;
    const { slot } = event;
    try {
      for (let offset = 0; offset < events.length; offset += this.recordStride) {
        event.velocity[0] = events[offset];
        event.velocity[1] = events[offset + 1];
        event.velocity[2] = events[offset + 2];
        for (let field = 0; field < slot.length; field += 1) {
          slot[field] = events[offset + VELOCITY_STRIDE + field];
        }
        event.position[0] = slot[positionOffset];
        event.position[1] = slot[positionOffset + 1];
        event.position[2] = slot[positionOffset + 2];
        for (const listener of listeners) {
          listener(event);
        }
      }
    } finally {
      events.length = 0;
    }
  }

  /** Drops the events not handed out yet - those queued, and those of a hand-out in progress. */
  public clear(): void {
    this.pending.length = 0;
    this.dispatching.length = 0;
  }

  /** Drops the events queued since the last hand-out. */
  public clearPending(): void {
    this.pending.length = 0;
  }

  /** Detaches every listener and drops every event. The driver is left as it is. */
  public destroy(): void {
    this.listeners.clear();
    this.clear();
  }

  // The driver's sink: queues one event.
  private readonly record: FXParticleEventSink = (
    slots,
    offset,
    velocityX,
    velocityY,
    velocityZ,
  ) => {
    const pending = this.pending;
    pending.push(velocityX, velocityY, velocityZ);
    const end = offset + this.event.slot.length;
    for (let field = offset; field < end; field += 1) {
      pending.push(slots[field]);
    }
  };
}

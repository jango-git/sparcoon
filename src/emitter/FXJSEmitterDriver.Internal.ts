import type { Vector3 } from "three";

import type { FXBehaviorArtifact, FXEmitterTransform } from "../artifact/FXArtifact.js";
import {
  FX_AGE,
  FX_CORE_POSITION_STRIDE,
  FX_ID,
  FX_LIFETIME,
  FX_PARTICLE_ID_RANGE,
  FX_POSITION_X,
  FX_POSITION_Y,
  FX_POSITION_Z,
} from "../coreLayout.js";
import { FXInstancedParticle } from "../instancedParticle/FXInstancedParticle.js";
import type { FXSlotLayout } from "../instancedParticle/FXParticleSlot.js";
import type { GLTypeInfo } from "../instancedParticle/glTypeInfo.js";
import { warnInDevelopment } from "../miscellaneous/asserts.js";
import type { FXParticleLayout } from "../render/FXArtifactMaterial.Internal.js";
import { FXCPURibbonPoints } from "../ribbon/FXRibbonPoints.Internal.js";
import { stripLayout } from "../strip/FXStripLayout.Internal.js";
import { FXCPUTrailHistory } from "../trail/FXTrailHistory.Internal.js";
import type { FXBirthAges } from "./FXBirthAges.Internal.js";
import { birthAgeAt } from "./FXBirthAges.Internal.js";
import { FXCPUBirthProbe } from "./FXBirthProbe.Internal.js";
import type { FXParticleEventKind } from "./FXEmitter.Internal.js";
import type {
  FXEmitterDriver,
  FXParticleDraw,
  FXParticleEventSink,
  FXRibbonPointOptions,
} from "./FXEmitterDriver.Internal.js";
import { attributeViews, particleMeshParts } from "./FXEmitterDriver.Internal.js";
import type { FXKernelResources } from "./FXKernelResources.Internal.js";
import type { FXLinkedProgram } from "./FXLinkedProgram.Internal.js";
import { FXSimulationHolder } from "./FXSimulationHolder.js";

/**
 * @internal The JS backend: a ring `FXInstancedParticle` driven by `FXSimulationHolder`. Its slot
 * is `behavior.buffers` alone. A field only the render reads is a zero constant in the shader, not
 * a buffer (see `particleLayout`).
 *
 * Kept step for step with the GPU pass: each tick updates the slots that existed before it, then
 * ages them, then seeds the tick's births, which are not updated until the next tick. A birth
 * overwrites the slot at the cursor whether it is live or not.
 *
 * While no particle is alive a tick skips update, aging and uploads, and keeps the drawn range (a
 * trail's history relies on it never shrinking, see `FXCPUTrailHistory`).
 */
export class FXJSEmitterDriver implements FXEmitterDriver {
  public readonly mesh: FXInstancedParticle;

  private readonly simulation: FXSimulationHolder;
  // The current render's layout over the slot (the behavior's, fixed for the driver's life).
  private currentLayout: FXParticleLayout;

  // Host-owned per-emitter counter (like age, never touched by the compiled kernel/graph), modulo
  // FX_PARTICLE_ID_RANGE - persists across reset() the same way FXTransformFeedbackSimulationHolder's
  // spawnIdBase does, only restarting when this driver itself is rebuilt from artifacts.
  private nextParticleId = 0;
  // The first overflow of this emitter's ring is reported once, in development builds.
  private warnedAboutOverflow = false;

  // Event reporting (watch): where births and deaths go. For deaths also every slot's position
  // before this tick's update (a death's velocity is how far it moved since), and the tick's delta
  // it is divided by. The snapshot is allocated on the first death watch and only taken while one
  // is set.
  private birthSink: FXParticleEventSink | undefined;
  private deathSink: FXParticleEventSink | undefined;
  private positionsBeforeUpdate = new Float32Array(0);
  private tickDeltaTime = 0;

  constructor(
    behavior: FXBehaviorArtifact,
    draw: FXParticleDraw | undefined,
    capacity: number,
    resources: FXKernelResources,
  ) {
    this.simulation = new FXSimulationHolder(behavior, resources);
    const parts = particleMeshParts(this.simulation.slot, draw);
    this.currentLayout = parts.layout;
    this.mesh = new FXInstancedParticle(
      this.simulation.slot,
      attributeViews(parts.layout),
      capacity,
      parts.material,
      parts.baseGeometry,
    );
    this.mesh.visible = parts.visible;
  }

  public get layout(): FXParticleLayout {
    return this.currentLayout;
  }

  public get slot(): FXSlotLayout {
    return this.mesh.slot;
  }

  public get particleCount(): number {
    return this.mesh.liveCount;
  }

  public get particleOverflowCount(): number {
    return this.mesh.overflowCount;
  }

  public get particleCapacity(): number {
    return this.mesh.instanceCapacity;
  }

  public get canSpawn(): boolean {
    return this.simulation.canSpawn;
  }

  public get reportsEvents(): boolean {
    return true;
  }

  public get programs(): readonly FXLinkedProgram[] {
    return [];
  }

  public watch(kind: FXParticleEventKind, sink: FXParticleEventSink | undefined): void {
    if (kind === "birth") {
      this.birthSink = sink;
      return;
    }
    this.deathSink = sink;
    const size = this.mesh.instanceCapacity * FX_CORE_POSITION_STRIDE;
    if (sink !== undefined && this.positionsBeforeUpdate.length !== size) {
      this.positionsBeforeUpdate = new Float32Array(size);
    }
  }

  public spawn(
    count: number,
    transform: FXEmitterTransform,
    inherited: Float32Array,
    ages?: FXBirthAges,
  ): void {
    // The id and age are set here, not by the graph. Every requested birth takes an id, seeded or
    // not, so a burst larger than the ring consumes `count` ids, as on the GPU (`u_fxSpawnIdBase`
    // plus the relative index, both modulo FX_PARTICLE_ID_RANGE). The age is written before the
    // spawn kernel runs because the kernel places the newborn by it.
    const { slots } = this.mesh;
    const { stride } = this.mesh.slot;
    const idOffset = this.mesh.core.lifecycle + FX_ID;
    const ageOffset = this.mesh.core.lifecycle + FX_AGE;
    const firstId = this.nextParticleId;
    this.nextParticleId = (firstId + count) % FX_PARTICLE_ID_RANGE;
    let birth = 0;
    for (const range of this.mesh.claim(count)) {
      for (let i = range.start; i < range.start + range.count; i++) {
        if (ages !== undefined) {
          slots[i * stride + ageOffset] = birthAgeAt(ages, birth);
        }
        slots[i * stride + idOffset] = (firstId + birth) % FX_PARTICLE_ID_RANGE;
        birth++;
      }
      // Re-checked (defensive): no spawn function would leave the freshly zeroed rows born dead.
      if (this.simulation.canSpawn) {
        this.simulation.spawn(slots, range.start, range.count, transform, inherited);
      }
      if (this.birthSink !== undefined) {
        this.reportBirths(this.birthSink, range.start, range.count, transform.velocity);
      }
      // `claim` marked the range for upload, and the upload waits for the next render - so it
      // carries what the spawn wrote too.
    }
    if (!this.warnedAboutOverflow && this.mesh.overflowCount > 0) {
      this.warnedAboutOverflow = true;
      warnInDevelopment(
        "FXEmitter: a birth overwrote a live particle (or a burst exceeded the ring) - the " +
          `emitter's capacity (${String(this.mesh.instanceCapacity)}) is smaller than its spawn ` +
          "rate x maximum lifetime, so particles die early. See particleOverflowCount.",
      );
    }
  }

  public advance(deltaTime: number): void {
    this.simulation.advance(deltaTime);
  }

  public beginTick(deltaTime: number, transform: FXEmitterTransform): void {
    const slotCount = this.mesh.instanceCount;
    // Nothing alive (or nothing ever born): see the class doc.
    if (slotCount === 0 || this.mesh.liveCount === 0) {
      return;
    }
    const { slots } = this.mesh;
    if (this.deathSink !== undefined) {
      // Before the update, so a kill in it still counts as a death.
      this.mesh.captureLiveness();
      const { stride } = this.mesh.slot;
      const before = this.positionsBeforeUpdate;
      for (let slot = 0; slot < slotCount; slot++) {
        const from = slot * stride + this.mesh.core.position;
        const to = slot * FX_CORE_POSITION_STRIDE;
        before[to + FX_POSITION_X] = slots[from + FX_POSITION_X];
        before[to + FX_POSITION_Y] = slots[from + FX_POSITION_Y];
        before[to + FX_POSITION_Z] = slots[from + FX_POSITION_Z];
      }
      this.tickDeltaTime = deltaTime;
    }
    // Motion integration lives in the graph (an `integrate-motion` node writes
    // `position += velocity * dt`), not in this host loop. Every drawn slot is passed, dead ones
    // too, as the GPU pass covers every slot; the kernel skips the dead ones.
    this.simulation.update(slots, slotCount, deltaTime, transform);
    this.mesh.markWritten(0, slotCount);

    // After the update, as the GPU pass does: the update reads last tick's age. Age is owned by
    // this fixed loop, not the graph - same for every effect.
    this.mesh.advanceAges(deltaTime, this.deathSink === undefined ? undefined : this.reportDeath);
  }

  public endTick(): void {
    // Nothing left: the update ran in beginTick, before this tick's births, and births seed
    // themselves in spawn().
  }

  public prepareDraw(cameraWorldPosition: Vector3 | undefined): void {
    if (cameraWorldPosition === undefined || this.mesh.instanceCount === 0) {
      return;
    }
    this.mesh.sortByDistance(cameraWorldPosition);
  }

  public applyBindingValues(values: Readonly<Record<string, number | Float32Array>>): void {
    this.simulation.applyBindingValues(values);
  }

  public reset(): void {
    this.mesh.drop();
  }

  public applyRenderArtifact(draw: FXParticleDraw | undefined): void {
    // Over this driver's OWN slot (never the other backend's): it depends on the behavior alone,
    // so it always fits - a new unwritten read is one more zero constant. Throws (before anything
    // changes) only on a read at another width than held.
    const parts = particleMeshParts(this.mesh.slot, draw);
    this.mesh.replaceMaterialAndBaseGeometry(
      parts.material,
      parts.baseGeometry,
      attributeViews(parts.layout),
    );
    this.mesh.visible = parts.visible;
    this.currentLayout = parts.layout;
  }

  public createTrailHistory(
    reads: Readonly<Record<string, GLTypeInfo>>,
    frames: number,
  ): FXCPUTrailHistory {
    return new FXCPUTrailHistory(this.mesh, stripLayout("cpu", reads, this.mesh.slot), frames);
  }

  public createRibbonPoints(
    reads: Readonly<Record<string, GLTypeInfo>>,
    { tile, section, head }: FXRibbonPointOptions,
  ): FXCPURibbonPoints {
    const probe = head
      ? new FXCPUBirthProbe(this.mesh.slot.stride, (slot, transform, inherited) => {
          this.seedProbe(slot, transform, inherited);
        })
      : undefined;
    return new FXCPURibbonPoints(
      this.mesh,
      stripLayout("cpu", reads, this.mesh.slot),
      { tile, section },
      probe,
    );
  }

  public destroy(): void {
    this.mesh.destroy();
  }

  // The particle a birth from `transform` would seed now, into the zeroed `slot` (see
  // FXBirthProbe): the next birth's id, age 0, by the behavior's own spawn - no claim, no id taken,
  // no event.
  private seedProbe(
    slot: Float32Array,
    transform: FXEmitterTransform,
    inherited: Float32Array,
  ): void {
    slot[this.mesh.core.lifecycle + FX_ID] = this.nextParticleId;
    if (this.simulation.canSpawn) {
      this.simulation.spawn(slot, 0, 1, transform, inherited);
    }
  }

  // The slots `[start, start + count)` a spawn just seeded, each born alive, with the velocity of
  // the pose it was seeded from. One born dead (a lifetime of 0) never lived.
  private reportBirths(
    sink: FXParticleEventSink,
    start: number,
    count: number,
    velocity: ArrayLike<number>,
  ): void {
    const { slots } = this.mesh;
    const { stride } = this.mesh.slot;
    const lifecycle = this.mesh.core.lifecycle;
    for (let slot = start; slot < start + count; slot++) {
      const offset = slot * stride;
      if (slots[offset + lifecycle + FX_AGE] < slots[offset + lifecycle + FX_LIFETIME]) {
        sink(slots, offset, velocity[0], velocity[1], velocity[2]);
      }
    }
  }

  // One death found by advanceAges: its slot after this tick's update, and its velocity over it.
  private readonly reportDeath = (slot: number): void => {
    const start = slot * this.mesh.slot.stride;
    const position = start + this.mesh.core.position;
    const { slots } = this.mesh;
    const before = this.positionsBeforeUpdate;
    const offset = slot * FX_CORE_POSITION_STRIDE;
    const inverseDelta = 1 / this.tickDeltaTime;
    this.deathSink?.(
      slots,
      start,
      (slots[position + FX_POSITION_X] - before[offset + FX_POSITION_X]) * inverseDelta,
      (slots[position + FX_POSITION_Y] - before[offset + FX_POSITION_Y]) * inverseDelta,
      (slots[position + FX_POSITION_Z] - before[offset + FX_POSITION_Z]) * inverseDelta,
    );
  };
}

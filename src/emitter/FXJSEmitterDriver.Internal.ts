import type { BufferGeometry, Vector3 } from "three";

import type { FXBehaviorArtifact, FXEmitterTransform } from "../artifact/FXArtifact.js";
import {
  FX_AGE,
  FX_CORE_POSITION_STRIDE,
  FX_ID,
  FX_LIFETIME,
  FX_POSITION_X,
  FX_POSITION_Y,
  FX_POSITION_Z,
} from "../coreLayout.js";
import { FXInstancedParticle } from "../instancedParticle/FXInstancedParticle.js";
import type { FXSlotLayout } from "../instancedParticle/FXParticleSlot.js";
import type { GLTypeInfo } from "../instancedParticle/glTypeInfo.js";
import { warnInDevelopment } from "../miscellaneous/asserts.js";
import type { FXParticleLayout } from "../render/FXArtifactMaterial.Internal.js";
import type { FXArtifactMaterial } from "../render/FXArtifactMaterial.js";
import { trailHistoryLayout } from "../trail/FXTrailFields.Internal.js";
import { FXCPUTrailHistory } from "../trail/FXTrailHistory.Internal.js";
import type { FXBirthAges } from "./FXBirthAges.Internal.js";
import { birthAgeAt } from "./FXBirthAges.Internal.js";
import type { FXParticleEventKind } from "./FXEmitter.Internal.js";
import type { FXEmitterDriver, FXParticleEventSink } from "./FXEmitterDriver.Internal.js";
import { particleLayout } from "./FXEmitterDriver.Internal.js";
import { FXSimulationHolder } from "./FXSimulationHolder.js";

/**
 * @internal The CPU (JS) particle-simulation backend: a fixed-capacity ring `FXInstancedParticle`
 * mesh driven by a precompiled `FXBehaviorArtifact` through `FXSimulationHolder`. Self-sufficient
 * from its own artifact - its slot is `behavior.buffers` alone, never a GPU kernel artifact's
 * (though the editor declares both alike); a field only the render reads is a zero constant in the
 * shader, not a buffer (see `particleLayout`).
 *
 * Kept step-for-step with the GPU backend's fused pass, so an emitter looks the same on either:
 * each tick first updates every slot that existed before it, reading its age as of the previous
 * tick, then ages it - and only then do the tick's births land, seeded but not updated until the
 * next tick. A birth overwrites the slot at the cursor whether it is live or not, on both backends.
 *
 * While no particle is alive (after the last one died, until the next birth), a tick skips the
 * update, the aging and every upload: every slot is dead - and stays dead, its age frozen at or
 * past its lifetime - so none of it would change anything drawn (the mesh draws no instance then,
 * see `FXInstancedParticle.instanceCount`). The drawn range itself is kept (a trail's history
 * relies on it never shrinking, see `FXCPUTrailHistory`).
 */
export class FXJSEmitterDriver implements FXEmitterDriver {
  public readonly mesh: FXInstancedParticle;

  private readonly simulation: FXSimulationHolder;
  // The current render's layout over the slot (the behavior's, fixed for the driver's life).
  private currentLayout: FXParticleLayout;

  // Host-owned, monotonic per-emitter counter (like age, never touched by the compiled kernel/
  // graph) - persists across reset() the same way FXTransformFeedbackSimulationHolder's
  // randSeedCounter does, only restarting when this driver itself is rebuilt from artifacts.
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
    material: FXArtifactMaterial,
    capacity: number,
    baseGeometry: BufferGeometry,
  ) {
    this.simulation = new FXSimulationHolder(behavior);
    this.currentLayout = particleLayout(this.simulation.slot, material.artifact);
    const threeMaterial = material.buildThreeMaterial(this.currentLayout);
    this.mesh = new FXInstancedParticle(
      this.simulation.slot,
      this.currentLayout.packed,
      capacity,
      threeMaterial,
      baseGeometry,
    );
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
    // Host-owned, like age: no write slot exists for id (the editor's FXParticleBehaviorTarget.ts
    // scalarWriteSlots never lists it), so no graph can ever collide with this assignment.
    //
    // Every birth asked for takes an id, seeded or not - a burst larger than the ring seeds only
    // `capacity` slots, `firstId + 0..capacity-1` in claim order, yet consumes `count` ids - exactly
    // as the GPU kernel numbers a spawn range (`u_fxSpawnIdBase + relative index`, the base then
    // advanced by the whole count), so the two backends hand out the same ids.
    //
    // Age is host-owned too, and written before the spawn kernel runs: the kernel places a birth
    // by it (the emitter's pose that long ago), as the GPU kernel places it by the age it seeds.
    const { slots } = this.mesh;
    const { stride } = this.mesh.slot;
    const idOffset = this.mesh.core.lifecycle + FX_ID;
    const ageOffset = this.mesh.core.lifecycle + FX_AGE;
    const firstId = this.nextParticleId;
    this.nextParticleId += count;
    let nextId = firstId;
    for (const range of this.mesh.claim(count)) {
      for (let i = range.start; i < range.start + range.count; i++) {
        if (ages !== undefined) {
          slots[i * stride + ageOffset] = birthAgeAt(ages, nextId - firstId);
        }
        slots[i * stride + idOffset] = nextId++;
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
    // too, exactly as the GPU pass covers every slot - a dead slot's state is never shown.
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

  public sortByDistance(cameraWorldPosition: Vector3): void {
    if (this.mesh.instanceCount === 0) {
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

  public applyRenderArtifact(material: FXArtifactMaterial, baseGeometry: BufferGeometry): void {
    // Over this driver's OWN slot (never the other backend's): it depends on the behavior alone,
    // so it always fits - a new unwritten read is one more zero constant. Throws (before anything
    // changes) only on a read at another width than held.
    const layout = particleLayout(this.mesh.slot, material.artifact);
    const threeMaterial = material.buildThreeMaterial(layout);
    this.mesh.replaceMaterialAndBaseGeometry(threeMaterial, baseGeometry, layout.packed);
    this.currentLayout = layout;
  }

  public createTrailHistory(
    reads: Readonly<Record<string, GLTypeInfo>>,
    frames: number,
  ): FXCPUTrailHistory {
    return new FXCPUTrailHistory(
      this.mesh,
      trailHistoryLayout("cpu", reads, this.mesh.slot),
      frames,
    );
  }

  public destroy(): void {
    this.mesh.destroy();
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

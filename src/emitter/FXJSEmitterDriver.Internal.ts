import type { BufferGeometry, InstancedBufferAttribute, Vector3 } from "three";
import type { FXBehaviorArtifact, FXEmitterTransform } from "../artifact/FXArtifact.js";
import { FX_CORE_LIFECYCLE, FX_CORE_POSITION, FX_ID, meshPropertyKeyFor } from "../coreLayout.js";
import { FXInstancedParticle } from "../instancedParticle/FXInstancedParticle.js";
import type { GLTypeInfo } from "../instancedParticle/glTypeInfo.js";
import type { FXArtifactMaterial } from "../render/FXArtifactMaterial.js";
import type { FXParticleLayout } from "../render/FXArtifactMaterial.Internal.js";
import type { FXEmitterDriver, FXHeldParticleFields } from "./FXEmitterDriver.Internal.js";
import { jsHeldFields, particleLayout } from "./FXEmitterDriver.Internal.js";
import { FXSimulationHolder } from "./FXSimulationHolder.js";
import { warnInDevelopment } from "../miscellaneous/asserts.js";
import { heldBehaviorFields, trailHistoryLayout } from "../trail/FXTrailFields.Internal.js";
import { FXCPUTrailHistory } from "../trail/FXTrailHistory.Internal.js";

/**
 * @internal The CPU (JS) particle-simulation backend: a fixed-capacity ring `FXInstancedParticle`
 * mesh driven by a precompiled `FXBehaviorArtifact` through `FXSimulationHolder`. Self-sufficient
 * from its own artifact - its buffers come from `behavior.attributeWrites` alone, never from a GPU
 * kernel artifact; a field only the render reads is a zero constant in the shader, not a buffer
 * (see `particleLayout`). Its attributes stay one per field: the emitted kernel indexes each
 * field's own array by literal offsets, so packing them would change that ABI.
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
  // What the mesh holds - fixed by the behavior - and the current render's layout over it.
  private readonly held: FXHeldParticleFields;
  private currentLayout: FXParticleLayout;

  // Name -> backing array, handed to every kernel call. Built once: the ring never reallocates.
  private readonly kernelBuffers: Record<string, Float32Array>;

  // Host-owned, monotonic per-emitter counter (like age, never touched by the compiled kernel/
  // graph) - persists across reset() the same way FXTransformFeedbackSimulationHolder's
  // randSeedCounter does, only restarting when this driver itself is rebuilt from artifacts.
  private nextParticleId = 0;
  // The first overflow of this emitter's ring is reported once, in development builds.
  private warnedAboutOverflow = false;

  constructor(
    behavior: FXBehaviorArtifact,
    material: FXArtifactMaterial,
    capacity: number,
    baseGeometry: BufferGeometry,
  ) {
    this.simulation = new FXSimulationHolder(behavior);
    this.held = jsHeldFields(this.simulation.attributeWrites);
    this.currentLayout = particleLayout(this.held, material.attributeReads);
    const threeMaterial = material.buildThreeMaterial(this.currentLayout);
    this.mesh = new FXInstancedParticle(
      { ...this.held.fields },
      capacity,
      threeMaterial,
      baseGeometry,
    );
    this.kernelBuffers = this.buildKernelBuffers();
  }

  public get layout(): FXParticleLayout {
    return this.currentLayout;
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

  public spawn(count: number, transform: FXEmitterTransform): void {
    // Host-owned, like age: no write slot exists for id (the editor's FXParticleBehaviorTarget.ts
    // scalarWriteSlots never lists it), so no graph can ever collide with this assignment.
    //
    // Every birth asked for takes an id, seeded or not - a burst larger than the ring seeds only
    // `capacity` slots, `firstId + 0..capacity-1` in claim order, yet consumes `count` ids - exactly
    // as the GPU kernel numbers a spawn range (`u_fxSpawnIdBase + relative index`, the base then
    // advanced by the whole count), so the two backends hand out the same ids.
    const lifecycle = this.mesh.propertyBuffers[FX_CORE_LIFECYCLE];
    const { array: lifecycleArray, itemSize: lifecycleItemSize } = lifecycle;
    const firstId = this.nextParticleId;
    this.nextParticleId += count;
    let nextId = firstId;
    for (const range of this.mesh.claim(count)) {
      for (let i = range.start; i < range.start + range.count; i++) {
        lifecycleArray[i * lifecycleItemSize + FX_ID] = nextId++;
      }
      // Re-checked (defensive): no spawn function would leave the freshly zeroed rows born dead.
      if (this.simulation.canSpawn) {
        this.simulation.spawn(this.kernelBuffers, range.start, range.count, transform);
      }
    }
    this.markBuffersNeedUpdate(this.simulation.spawnWrittenBuffers);
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
    // Motion integration lives in the graph (an `integrate-motion` node writes
    // `position += velocity * dt`), not in this host loop. Every drawn slot is passed, dead ones
    // too, exactly as the GPU pass covers every slot - a dead slot's state is never shown.
    this.simulation.update(this.kernelBuffers, slotCount, deltaTime, transform);
    this.markBuffersNeedUpdate(this.simulation.updateWrittenBuffers);

    // After the update, as the GPU pass does: the update reads last tick's age. Age is owned by
    // this fixed loop, not the graph - same for every effect.
    this.mesh.advanceAges(deltaTime);
  }

  public endTick(): void {
    // Nothing left: the update ran in beginTick, before this tick's births, and births seed
    // themselves in spawn().
  }

  public sortByDistance(cameraWorldPosition: Vector3): void {
    if (this.mesh.instanceCount === 0) {
      return;
    }
    // Sort in world space to match the shader's `p_cameraDistance`, correct under any transform.
    this.mesh.updateWorldMatrix(true, false);
    this.mesh.sortByDistance(cameraWorldPosition, this.mesh.matrixWorld);
  }

  public applyBindingValues(values: Readonly<Record<string, number | Float32Array>>): void {
    this.simulation.applyBindingValues(values);
  }

  public reset(): void {
    this.mesh.drop();
  }

  public applyRenderArtifact(material: FXArtifactMaterial, baseGeometry: BufferGeometry): void {
    // Over this driver's OWN held fields (never the other backend's): they depend on the behavior
    // alone, so the buffers always fit - a new unwritten read is one more zero constant. Throws
    // (before anything changes) only on a read at another width than held.
    const layout = particleLayout(this.held, material.attributeReads);
    const threeMaterial = material.buildThreeMaterial(layout);
    this.mesh.replaceMaterialAndBaseGeometry(threeMaterial, baseGeometry);
    this.currentLayout = layout;
  }

  public createTrailHistory(
    reads: Readonly<Record<string, GLTypeInfo>>,
    frames: number,
  ): FXCPUTrailHistory {
    return new FXCPUTrailHistory(
      this.mesh.propertyBuffers,
      () => this.mesh.instanceCount,
      () => this.mesh.liveCount,
      trailHistoryLayout("cpu", reads, heldBehaviorFields(this.simulation.attributeWrites)),
      this.mesh.instanceCapacity,
      frames,
    );
  }

  public destroy(): void {
    this.mesh.destroy();
  }

  // Maps each kernel state-buffer name to its backing Float32Array.
  private buildKernelBuffers(): Record<string, Float32Array> {
    const buffers: Record<string, Float32Array> = {
      [FX_CORE_POSITION]: this.mesh.propertyBuffers[FX_CORE_POSITION].array as Float32Array,
      [FX_CORE_LIFECYCLE]: this.mesh.propertyBuffers[FX_CORE_LIFECYCLE].array as Float32Array,
    };
    for (const buffer of this.simulation.attributeBuffers) {
      const attribute = this.mesh.propertyBuffers[meshPropertyKeyFor(buffer.name)] as
        InstancedBufferAttribute | undefined;
      if (attribute !== undefined) {
        buffers[buffer.name] = attribute.array as Float32Array;
      }
    }
    return buffers;
  }

  private markBuffersNeedUpdate(names: readonly string[]): void {
    for (const name of names) {
      const attribute = this.mesh.propertyBuffers[meshPropertyKeyFor(name)] as
        InstancedBufferAttribute | undefined;
      if (attribute !== undefined) {
        attribute.needsUpdate = true;
      }
    }
  }
}

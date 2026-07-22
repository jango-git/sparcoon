import type { BufferGeometry, InstancedBufferAttribute, Vector3 } from "three";
import type { FXBehaviorArtifact, FXEmitterTransform } from "../artifact/FXArtifact.js";
import {
  FX_AGE,
  FX_CORE_LIFECYCLE,
  FX_CORE_POSITION,
  FX_ID,
  meshPropertyKeyFor,
} from "../coreLayout.js";
import { FXInstancedParticle } from "../instancedParticle/FXInstancedParticle.js";
import type { GLTypeInfo } from "../instancedParticle/glTypeInfo.js";
import type { FXArtifactMaterial } from "../render/FXArtifactMaterial.js";
import type { FXEmitterDriver } from "./FXEmitterDriver.Internal.js";
import {
  mergeAttributeWidths,
  sameVaryings,
  varyingsFromComponents,
} from "./FXEmitterDriver.Internal.js";
import { FXSimulationHolder } from "./FXSimulationHolder.js";

/**
 * @internal The CPU (JS) particle-simulation backend: a dense, compacting `FXInstancedParticle`
 * mesh driven by a precompiled `FXBehaviorArtifact` through `FXSimulationHolder`. Self-sufficient
 * from its own artifact - its varyings come from `behavior.attributeWrites` (+ the render
 * artifact's `attributeReads`), never from a GPU kernel artifact.
 */
export class FXJSEmitterDriver implements FXEmitterDriver {
  public readonly mesh: FXInstancedParticle;
  public readonly varyings: Record<string, GLTypeInfo>;

  private readonly simulation: FXSimulationHolder;

  // Frame-loop cache for kernelBuffers(); rebuilt when the mesh's buffer set changes.
  private kernelBuffersCache?: Record<string, Float32Array>;
  private kernelBuffersCacheVersion = -1;

  // Host-owned, monotonic per-emitter counter (like age, never touched by the compiled kernel/
  // graph) - persists across reset() the same way FXTransformFeedbackSimulationHolder's
  // randSeedCounter does, only restarting when this driver itself is rebuilt from artifacts.
  private nextParticleId = 0;

  constructor(
    behavior: FXBehaviorArtifact,
    material: FXArtifactMaterial,
    capacity: number,
    capacityStep: number,
    baseGeometry: BufferGeometry,
  ) {
    this.simulation = new FXSimulationHolder(behavior);
    const components = mergeAttributeWidths(
      this.simulation.attributeWrites,
      material.attributeReads,
    );
    this.varyings = varyingsFromComponents(components);
    const threeMaterial = material.buildThreeMaterial(this.varyings);
    this.mesh = new FXInstancedParticle(
      this.varyings,
      capacity,
      capacityStep,
      threeMaterial,
      baseGeometry,
    );
  }

  public get particleCount(): number {
    return this.mesh.instanceCount;
  }

  public get particleCapacity(): number {
    return this.mesh.instanceCapacity;
  }

  public get canSpawn(): boolean {
    return this.simulation.canSpawn;
  }

  public spawn(count: number, transform: FXEmitterTransform): void {
    const instanceBegin = this.mesh.instanceCount;
    this.mesh.createInstances(count);
    const instanceEnd = this.mesh.instanceCount;

    // Host-owned, like age: no write slot exists for id (the editor's FXParticleBehaviorTarget.ts
    // scalarWriteSlots never lists it), so no graph can ever collide with this assignment.
    const lifecycle = this.mesh.propertyBuffers[FX_CORE_LIFECYCLE];
    const { array: lifecycleArray, itemSize: lifecycleItemSize } = lifecycle;
    for (let i = instanceBegin; i < instanceEnd; i++) {
      lifecycleArray[i * lifecycleItemSize + FX_ID] = this.nextParticleId++;
    }

    // Re-checked (defensive): no spawn function would leave the freshly zeroed rows born dead.
    if (this.simulation.canSpawn) {
      this.simulation.spawn(
        this.kernelBuffers(),
        instanceBegin,
        instanceEnd - instanceBegin,
        transform,
      );
      this.markBuffersNeedUpdate(this.simulation.spawnWrittenBuffers);
    }
  }

  public beginTick(deltaTime: number): void {
    // Age increment + cull. Age is owned by this fixed loop, not the graph - same for every effect.
    const lifecycle = this.mesh.propertyBuffers[FX_CORE_LIFECYCLE];
    const { array, itemSize } = lifecycle;
    const instanceCount = this.mesh.instanceCount;

    for (let i = 0; i < instanceCount; i++) {
      array[i * itemSize + FX_AGE] += deltaTime;
    }

    this.mesh.removeDeadParticles();
  }

  public endTick(deltaTime: number, transform: FXEmitterTransform): void {
    if (this.mesh.instanceCount === 0) {
      return;
    }

    // Motion integration lives in the graph (an `integrate-motion` node writes
    // `position += velocity * dt`), not in this host loop.
    this.simulation.update(this.kernelBuffers(), this.mesh.instanceCount, deltaTime, transform);
    this.markBuffersNeedUpdate(this.simulation.updateWrittenBuffers);

    // Age (written in beginTick) must reach the GPU this frame; the update phase's buffers were
    // flagged already.
    this.mesh.propertyBuffers[FX_CORE_LIFECYCLE].needsUpdate = true;
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
    // Recomputed exactly as the constructor does, against this driver's OWN behavior writes
    // (never the other backend's) - a stale merge here would wrongly pass a real layout change.
    const components = mergeAttributeWidths(
      this.simulation.attributeWrites,
      material.attributeReads,
    );
    const nextVaryings = varyingsFromComponents(components);
    if (!sameVaryings(this.varyings, nextVaryings)) {
      throw new Error(
        "FXJSEmitterDriver.applyRenderArtifact: the new render artifact's attribute reads no " +
          "longer match this emitter's allocated buffers - a full rebuild (fromArtifacts) is required",
      );
    }
    // this.varyings is value-equal to nextVaryings (just proved by sameVaryings above) - built
    // from nextVaryings so a future reader never has to re-derive that equivalence to trust this.
    const threeMaterial = material.buildThreeMaterial(nextVaryings);
    this.mesh.replaceMaterialAndBaseGeometry(threeMaterial, baseGeometry);
  }

  public destroy(): void {
    this.kernelBuffersCache = undefined;
    this.mesh.destroy();
  }

  // Maps each kernel state-buffer name to its backing Float32Array. Cached across ticks/bursts and
  // rebuilt only when the mesh's buffer set changes (`bufferVersion` - capacity growth).
  private kernelBuffers(): Record<string, Float32Array> {
    const version = this.mesh.bufferVersion;
    if (this.kernelBuffersCache !== undefined && this.kernelBuffersCacheVersion === version) {
      return this.kernelBuffersCache;
    }
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
    this.kernelBuffersCache = buffers;
    this.kernelBuffersCacheVersion = version;
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

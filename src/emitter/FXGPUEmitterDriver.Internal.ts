import type { BufferGeometry, WebGLRenderer } from "three";
import type { FXEmitterTransform, FXParticleKernelArtifact } from "../artifact/FXArtifact.js";
import { isCoreBufferName } from "../coreLayout.js";
import type { GLTypeInfo } from "../instancedParticle/glTypeInfo.js";
import { FXTransformFeedbackParticle } from "../instancedParticle/FXTransformFeedbackParticle.js";
import type { FXArtifactMaterial } from "../render/FXArtifactMaterial.js";
import type { FXEmitterDriver } from "./FXEmitterDriver.Internal.js";
import {
  mergeAttributeWidths,
  sameVaryings,
  varyingsFromComponents,
} from "./FXEmitterDriver.Internal.js";
import { FXTransformFeedbackSimulationHolder } from "./FXTransformFeedbackSimulationHolder.js";

/**
 * @internal The GPU (WebGL2 transform-feedback) particle-simulation backend: a fixed-capacity
 * `FXTransformFeedbackParticle` mesh driven by a precompiled `FXParticleKernelArtifact` through
 * `FXTransformFeedbackSimulationHolder`. Self-sufficient from its own artifact - its varyings come
 * from `gpu.kernel.buffers` (+ the render artifact's `attributeReads`), never from a JS behavior
 * artifact's `attributeWrites`.
 *
 * No sorting or dead-particle compaction: every particle slot is always drawn at the fixed
 * `capacity`, and `particleCount`/`particleCapacity` both report that capacity rather than an
 * exact live count, which there is no cheap way to know.
 */
export class FXGPUEmitterDriver implements FXEmitterDriver {
  public readonly mesh: FXTransformFeedbackParticle;
  public readonly varyings: Record<string, GLTypeInfo>;

  private readonly simulation: FXTransformFeedbackSimulationHolder;
  // The kernel's own attribute buffers (name + component width), kept for `applyRenderArtifact`'s
  // re-merge against a NEW render artifact - never the kernel artifact itself, which nothing else
  // here needs.
  private readonly behaviorAttributeWidths: readonly { name: string; components: number }[];

  // Cursor/overwrite bookkeeping: `gpuSpawnCursor` is the next write position (mod capacity).
  // Spawns inside a tick (a delayed burst expiring, a play's rate accumulator) all share that
  // tick's pose and parameters, so `gpuSpawnRangeStart`/`gpuPendingSpawnCount` gather them into
  // one contiguous range the tick's own pass seeds. A spawn outside a tick - an immediate
  // `burst()` from host code or from an effect's timeline - is seeded right away by a pass of its
  // own instead (see spawn()), so the range is always empty between ticks.
  private gpuSpawnCursor = 0;
  private gpuSpawnRangeStart = 0;
  private gpuPendingSpawnCount = 0;
  // Between beginTick() and endTick(): spawns join the tick's pass instead of running their own.
  private ticking = false;

  // Depth sorting has no GPU-driven form - warned once, not every tick, if a host sets
  // sortCamera on one anyway.
  private warnedAboutSortCamera = false;

  constructor(
    kernel: FXParticleKernelArtifact,
    renderer: WebGLRenderer,
    material: FXArtifactMaterial,
    capacity: number,
    baseGeometry: BufferGeometry,
  ) {
    const attributeBuffers = kernel.buffers.filter((buffer) => !isCoreBufferName(buffer.name));
    this.behaviorAttributeWidths = attributeBuffers.map((buffer) => ({
      name: buffer.name,
      components: buffer.stride,
    }));
    const components = mergeAttributeWidths(this.behaviorAttributeWidths, material.attributeReads);
    this.varyings = varyingsFromComponents(components);
    const threeMaterial = material.buildThreeMaterial(this.varyings);

    let mesh: FXTransformFeedbackParticle | undefined;
    try {
      mesh = new FXTransformFeedbackParticle(
        renderer.getContext() as WebGL2RenderingContext,
        this.varyings,
        capacity,
        threeMaterial,
        baseGeometry,
      );
      this.simulation = new FXTransformFeedbackSimulationHolder(renderer, kernel);
    } catch (error) {
      // `mesh` can have already succeeded (real WebGL buffers/VAO-backing state allocated) when the
      // simulation holder construction right after it is what actually throws - release those
      // before re-throwing, or they leak for the GL context's lifetime. The caller (FXEmitter.
      // fromArtifacts) decides what happens next - falling back to FXJSEmitterDriver.
      mesh?.destroy();
      throw error;
    }
    this.mesh = mesh;
  }

  public get particleCount(): number {
    return this.mesh.capacity;
  }

  public get particleCapacity(): number {
    return this.mesh.capacity;
  }

  // A fused transform-feedback program always has a spawn branch - assembleTransformFeedbackProgram
  // (the editor's assembler) refuses to build one without it, so a constructed FXParticleKernelArtifact
  // is this guarantee already checked, not something to re-derive here.
  public get canSpawn(): boolean {
    return true;
  }

  public spawn(count: number, transform: FXEmitterTransform): void {
    // Cursor advances by `count`, wrapping at capacity - the buffer slots this claims may already
    // be occupied by still-alive particles, which are simply overwritten (the scheme's cheapness is
    // not checking occupancy at all).
    const start = this.gpuSpawnCursor;
    this.gpuSpawnCursor = (this.gpuSpawnCursor + count) % this.mesh.capacity;
    if (this.ticking) {
      this.gpuPendingSpawnCount += count;
      return;
    }
    // Outside a tick, the emitter may be moved or re-parametrized before the next one (two
    // bursts from two poses in one frame is an ordinary way to author an effect), so this spawn
    // is seeded now, from the pose and bindings of this call. More than `capacity` at once
    // overwrites the whole ring; the extra births would only overwrite each other.
    this.simulation.spawn(
      this.mesh,
      { start, count: Math.min(count, this.mesh.capacity) },
      transform,
    );
    this.gpuSpawnRangeStart = this.gpuSpawnCursor;
  }

  public beginTick(): void {
    this.ticking = true;
  }

  public endTick(deltaTime: number, transform: FXEmitterTransform): void {
    this.ticking = false;
    // Every particle slot is always processed - there is no CPU-visible live count to skip on;
    // the render shader hides dead slots (FXArtifactMaterial.Internal.ts's
    // projectFromModelPos degenerate-position injection).
    this.simulation.tick(
      this.mesh,
      deltaTime,
      { start: this.gpuSpawnRangeStart, count: this.gpuPendingSpawnCount },
      transform,
    );
    // Consumed - the next tick's range starts wherever the cursor now sits.
    this.gpuSpawnRangeStart = this.gpuSpawnCursor;
    this.gpuPendingSpawnCount = 0;
  }

  public sortByDistance(): void {
    // No CPU-visible particle positions to sort, and no cheap way to sort GPU-resident data without
    // a readback that would defeat the point of running on the GPU at all (an accepted loss, not a
    // bug to work around). Never thrown - a host that sets sortCamera on a GPU
    // emitter out of habit should not crash the world tick over it.
    if (!this.warnedAboutSortCamera) {
      this.warnedAboutSortCamera = true;
      console.warn(
        "FXEmitter: sortCamera has no effect on a GPU-driven (transform-feedback) emitter - " +
          "back-to-front depth sorting is not supported for that backend.",
      );
    }
  }

  public applyBindingValues(values: Readonly<Record<string, number | Float32Array>>): void {
    this.simulation.applyBindingValues(values);
  }

  public reset(): void {
    this.mesh.drop();
    this.gpuSpawnCursor = 0;
    // Also drops a range gathered but not yet seeded, so nothing cancelled here spawns later.
    this.gpuSpawnRangeStart = 0;
    this.gpuPendingSpawnCount = 0;
  }

  public applyRenderArtifact(material: FXArtifactMaterial, baseGeometry: BufferGeometry): void {
    // Recomputed exactly as the constructor does, against this driver's OWN kernel buffers (never
    // a JS behavior artifact's attributeWrites) - a stale merge here would wrongly pass a real
    // layout change.
    const components = mergeAttributeWidths(this.behaviorAttributeWidths, material.attributeReads);
    const nextVaryings = varyingsFromComponents(components);
    if (!sameVaryings(this.varyings, nextVaryings)) {
      throw new Error(
        "FXGPUEmitterDriver.applyRenderArtifact: the new render artifact's attribute reads no " +
          "longer match this emitter's allocated buffers - a full rebuild (fromArtifacts) is required",
      );
    }
    // this.varyings is value-equal to nextVaryings (just proved by sameVaryings above) - built
    // from nextVaryings so a future reader never has to re-derive that equivalence to trust this.
    const threeMaterial = material.buildThreeMaterial(nextVaryings);
    this.mesh.replaceMaterialAndBaseGeometry(threeMaterial, baseGeometry);
  }

  public destroy(): void {
    this.mesh.destroy();
    this.simulation.destroy();
  }
}

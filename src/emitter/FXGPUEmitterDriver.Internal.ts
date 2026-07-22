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

  // Cursor/overwrite bookkeeping: `gpuSpawnCursor` is the next write position (mod
  // capacity); `gpuSpawnRangeStart`/`gpuPendingSpawnCount` accumulate every spawn() call since the
  // last endTick() into one contiguous range, since the GPU can only run one transform-feedback pass
  // per tick (unlike the JS backend, which can grow its array once per call with no such constraint) -
  // "since the last endTick()", not "since the start of this tick": an immediate `burst()` between
  // ticks must not lose its contribution (see endTick()'s own doc comment).
  private gpuSpawnCursor = 0;
  private gpuSpawnRangeStart = 0;
  private gpuPendingSpawnCount = 0;

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

  public spawn(count: number): void {
    // Cursor advances by `count`, wrapping at capacity - the buffer slots this claims may already
    // be occupied by still-alive particles, which are simply overwritten (the scheme's cheapness is
    // not checking occupancy at all). Accumulates into
    // `gpuPendingSpawnCount` regardless of whether this call happens during a tick's own scheduling
    // (a delayed burst/play firing) or entirely between ticks (an immediate `burst()` call from host
    // code) - endTick() is the only place that range is ever consumed and reset (see its own doc
    // comment for why beginTick() must NOT also reset it).
    this.gpuSpawnCursor = (this.gpuSpawnCursor + count) % this.mesh.capacity;
    this.gpuPendingSpawnCount += count;
  }

  public beginTick(): void {
    // No begin-of-tick bookkeeping needed: unlike the range/count fields (reset only once consumed,
    // in endTick()), there is nothing here that must happen before this tick's scheduled bursts run.
  }

  public endTick(deltaTime: number, transform: FXEmitterTransform): void {
    // Every particle slot is always processed - there is no CPU-visible live count to skip on;
    // the render shader hides dead slots (FXArtifactMaterial.Internal.ts's
    // projectFromModelPos degenerate-position injection).
    this.simulation.tick(
      this.mesh,
      deltaTime,
      { start: this.gpuSpawnRangeStart, count: this.gpuPendingSpawnCount },
      transform,
    );
    // Consumed - reset for the NEXT accumulation window, starting from wherever the cursor now sits.
    // Must NOT happen in beginTick() instead: an immediate `burst()` call between two ticks (the
    // ordinary way to spawn a one-shot effect, never touching pendingBursts/activePlays at all)
    // already advances the cursor and this count the moment it is called - resetting at the START of
    // the NEXT tick would silently discard that count before it was ever reported as a birth range,
    // leaving those slots' data one full transform-feedback pass behind their real cursor claim.
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
    // Must also clear any not-yet-consumed spawn accumulation (endTick() only resets it AFTER
    // consuming it - see that method's own doc comment), or a burst() that ran earlier this same
    // accumulation window would still spawn on the next tick despite reset() having just cancelled
    // it - a stale range left over from before the cursor was zeroed here.
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

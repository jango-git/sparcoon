import type { BufferGeometry, Vector3, WebGLRenderer } from "three";

import type { FXEmitterTransform, FXParticleKernelArtifact } from "../artifact/FXArtifact.js";
import type { FXSlotLayout } from "../instancedParticle/FXParticleSlot.js";
import { FXTransformFeedbackParticle } from "../instancedParticle/FXTransformFeedbackParticle.js";
import type { GLTypeInfo } from "../instancedParticle/glTypeInfo.js";
import type { FXParticleLayout } from "../render/FXArtifactMaterial.Internal.js";
import type { FXArtifactMaterial } from "../render/FXArtifactMaterial.js";
import { trailHistoryLayout } from "../trail/FXTrailFields.Internal.js";
import { FXGPUTrailHistory } from "../trail/FXTrailHistory.Internal.js";
import type { FXAgedBirths, FXBirthAges } from "./FXBirthAges.Internal.js";
import type { FXParticleEventKind } from "./FXEmitter.Internal.js";
import type { FXEmitterDriver, FXParticleEventSink } from "./FXEmitterDriver.Internal.js";
import { attributeViews, particleLayout } from "./FXEmitterDriver.Internal.js";
import { FXGPUParticleOrder } from "./FXGPUParticleOrder.Internal.js";
import type { FXSurfaceTable } from "./FXSurfaceTable.Internal.js";
import { FXTransformFeedbackSimulationHolder } from "./FXTransformFeedbackSimulationHolder.js";

/**
 * @internal The GPU (WebGL2 transform-feedback) particle-simulation backend: a fixed-capacity
 * `FXTransformFeedbackParticle` mesh driven by a precompiled `FXParticleKernelArtifact` through
 * `FXTransformFeedbackSimulationHolder`. Self-sufficient from its own artifact - its fields are the
 * slot `gpu.kernel.buffers` lays out, never a JS behavior artifact's `buffers`; a field only the
 * render reads is a zero constant in the shader, not a buffer (see `particleLayout`).
 *
 * No dead-particle compaction: every particle slot is always drawn at the fixed `capacity`, and
 * `particleCount`/`particleCapacity` both report that capacity rather than an exact live count,
 * which there is no cheap way to know. Sorted (`sorted`), the slots never move either: the
 * material draws them in the order a {@link FXGPUParticleOrder} keeps, reading them from its
 * textures instead of from attributes.
 */
export class FXGPUEmitterDriver implements FXEmitterDriver {
  public readonly mesh: FXTransformFeedbackParticle;

  private readonly simulation: FXTransformFeedbackSimulationHolder;
  private readonly gl: WebGL2RenderingContext;
  // The current render's layout over the kernel's slot (fixed by the kernel).
  private currentLayout: FXParticleLayout;

  // Cursor/overwrite bookkeeping: `gpuSpawnCursor` is the next write position (mod capacity).
  // Spawns inside a tick are the births at that tick's pose (FXEmitter.tick), so
  // `gpuSpawnRangeStart`/`gpuPendingSpawnCount` gather them into one contiguous range the tick's
  // own pass seeds. A spawn outside a tick - a birth at another pose, or any birth on a paused
  // tick - is seeded right away by a pass of its own instead (see spawn()), so the range is always
  // empty between ticks.
  private gpuSpawnCursor = 0;
  private gpuSpawnRangeStart = 0;
  private gpuPendingSpawnCount = 0;
  // The gathered births born earlier in the tick: the range's tail, so nothing may follow them.
  private gpuAgedSpawns: FXAgedBirths | undefined;
  // What the gathered births inherit: one array for the whole range, as it is one pass.
  private gpuTickInherited: Float32Array = NOTHING_INHERITED;
  // Between beginTick() and endTick(): spawns join the tick's pass instead of running their own.
  private ticking = false;

  // A sorted emitter's order, whose textures its material reads its slots from.
  private readonly order: FXGPUParticleOrder | undefined;

  constructor(options: FXGPUEmitterDriverOptions) {
    const { kernel, renderer, material, capacity, baseGeometry, surfaces, sorted } = options;
    // The holder first: it checks the kernel fits this GPU before any particle buffer exists. A
    // throw from here on (a render the slot cannot draw among them) goes to the caller
    // (FXEmitter.fromArtifacts), which falls back to FXJSEmitterDriver - so what is already
    // allocated is released first, or it would leak for the GL context's lifetime.
    const simulation = new FXTransformFeedbackSimulationHolder(renderer, kernel, surfaces);
    let order: FXGPUParticleOrder | undefined;
    try {
      order = sorted ? new FXGPUParticleOrder(renderer, simulation.slot, capacity) : undefined;
      this.currentLayout = particleLayout(simulation.slot, material.artifact, order?.textures);
      const threeMaterial = material.buildThreeMaterial(this.currentLayout);
      this.mesh = new FXTransformFeedbackParticle(
        renderer.getContext() as WebGL2RenderingContext,
        simulation.slot,
        attributeViews(this.currentLayout),
        capacity,
        threeMaterial,
        baseGeometry,
      );
    } catch (error) {
      order?.destroy();
      simulation.destroy();
      throw error;
    }
    this.order = order;
    this.simulation = simulation;
    this.gl = renderer.getContext() as WebGL2RenderingContext;
  }

  public get layout(): FXParticleLayout {
    return this.currentLayout;
  }

  public get slot(): FXSlotLayout {
    return this.mesh.slot;
  }

  public get particleCount(): number {
    return this.mesh.capacity;
  }

  public get particleCapacity(): number {
    return this.mesh.capacity;
  }

  // Whether a claimed slot was still alive is GPU-resident state - unknowable without a readback.
  public get particleOverflowCount(): undefined {
    return undefined;
  }

  // A fused transform-feedback program always has a spawn branch - assembleTransformFeedbackProgram
  // (the editor's assembler) refuses to build one without it, so a constructed FXParticleKernelArtifact
  // is this guarantee already checked, not something to re-derive here.
  public get canSpawn(): boolean {
    return true;
  }

  // Births and deaths live in transform-feedback buffers only; seeing them would take a readback.
  public get reportsEvents(): boolean {
    return false;
  }

  public watch(kind: FXParticleEventKind, sink: FXParticleEventSink | undefined): void {
    if (sink !== undefined) {
      throw new Error(`FXEmitter: a GPU-driven emitter cannot report its particles' ${kind}s`);
    }
  }

  public spawn(
    count: number,
    transform: FXEmitterTransform,
    inherited: Float32Array,
    ages?: FXBirthAges,
  ): void {
    if (this.ticking && this.gpuAgedSpawns !== undefined) {
      throw new Error(
        "FXGPUEmitterDriver.spawn: a tick's aged births must be its last at its pose",
      );
    }
    if (this.ticking && this.gpuPendingSpawnCount > 0 && inherited !== this.gpuTickInherited) {
      throw new Error(
        "FXGPUEmitterDriver.spawn: a tick's births at its pose share one inheritance",
      );
    }
    // Cursor advances by `count`, wrapping at capacity - the buffer slots this claims may already
    // be occupied by still-alive particles, which are simply overwritten (the scheme's cheapness is
    // not checking occupancy at all).
    const start = this.gpuSpawnCursor;
    this.gpuSpawnCursor = (this.gpuSpawnCursor + count) % this.mesh.capacity;
    this.mesh.occupy();
    if (this.ticking) {
      this.gpuPendingSpawnCount += count;
      this.gpuTickInherited = inherited;
      this.gpuAgedSpawns = ages === undefined ? undefined : { count, ages };
      return;
    }
    // Outside a tick, this birth has a pose of its own (two bursts from two poses in one frame, a
    // spawn at an origin), so it is seeded now, by a pass of its own with that pose. More than `capacity` at once
    // overwrites the whole ring; the extra births would only overwrite each other - but still take
    // their ids, as inside a tick (and on the JS backend).
    const seeded = Math.min(count, this.mesh.capacity);
    this.simulation.spawn(
      this.mesh,
      { start, count: seeded, aged: ages === undefined ? undefined : { count: seeded, ages } },
      transform,
      inherited,
      count,
    );
    this.order?.slotsWritten();
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
      {
        start: this.gpuSpawnRangeStart,
        count: this.gpuPendingSpawnCount,
        aged: this.gpuAgedSpawns,
      },
      transform,
      this.gpuTickInherited,
    );
    this.order?.slotsWritten();
    // Consumed - the next tick's range starts wherever the cursor now sits.
    this.gpuSpawnRangeStart = this.gpuSpawnCursor;
    this.gpuPendingSpawnCount = 0;
    this.gpuAgedSpawns = undefined;
    this.gpuTickInherited = NOTHING_INHERITED;
  }

  public prepareDraw(cameraWorldPosition: Vector3 | undefined): void {
    this.order?.prepare(this.mesh.readBuffer(), cameraWorldPosition);
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
    this.gpuAgedSpawns = undefined;
    this.gpuTickInherited = NOTHING_INHERITED;
  }

  public applyRenderArtifact(material: FXArtifactMaterial, baseGeometry: BufferGeometry): void {
    // Over this driver's OWN kernel slot (never a JS behavior artifact's): it depends on the kernel
    // alone, so it always fits - a new unwritten read is one more zero constant. Throws (before
    // anything changes) only on a read at another width than held.
    const layout = particleLayout(this.mesh.slot, material.artifact, this.order?.textures);
    const threeMaterial = material.buildThreeMaterial(layout);
    this.mesh.replaceMaterialAndBaseGeometry(threeMaterial, baseGeometry, attributeViews(layout));
    this.currentLayout = layout;
  }

  public createTrailHistory(
    reads: Readonly<Record<string, GLTypeInfo>>,
    frames: number,
  ): FXGPUTrailHistory {
    // The kernel's slot: what one copy records, at the offsets the history views it by.
    const layout = trailHistoryLayout("gpu", reads, this.mesh.slot);
    return new FXGPUTrailHistory(this.gl, this.mesh, layout, frames);
  }

  public destroy(): void {
    this.mesh.destroy();
    this.order?.destroy();
    this.simulation.destroy();
  }
}

export interface FXGPUEmitterDriverOptions {
  readonly kernel: FXParticleKernelArtifact;
  readonly renderer: WebGLRenderer;
  readonly material: FXArtifactMaterial;
  readonly capacity: number;
  readonly baseGeometry: BufferGeometry;
  /** The tables of the kernel's `meshSurfaces`, by uniform. */
  readonly surfaces: Readonly<Record<string, FXSurfaceTable>>;
  /** Draws back to front, in the order {@link FXEmitterDriver.prepareDraw} keeps. */
  readonly sorted: boolean;
}

// What a pass without births uploads: its spawn branch runs for no slot, so any value does.
const NOTHING_INHERITED = new Float32Array(0);

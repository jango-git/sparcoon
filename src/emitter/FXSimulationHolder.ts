import type {
  FXBehaviorArtifact,
  FXEmitterTransform,
  FXValueSlot,
} from "../artifact/FXArtifact.js";
import { ownSlots } from "../artifact/FXValueSlots.Internal.js";
import type { FXSlotLayout } from "../instancedParticle/FXParticleSlot.js";
import { particleSlotLayout } from "../instancedParticle/FXParticleSlot.js";
import type { FXKernelResources } from "./FXKernelResources.Internal.js";

/**
 * @internal The JS (CPU) behavior driver, sibling of `FXTransformFeedbackSimulationHolder`. Calls
 * the artifact's `spawn`/`update` each tick with its own bindings, so a value change is read on the
 * next tick.
 */
export class FXSimulationHolder {
  /** The particle slot the artifact's kernels index, by the mesh's property keys. */
  public readonly slot: FXSlotLayout;

  // This emitter's own live bindings - never the shared artifact's.
  private readonly bindings: Record<string, FXValueSlot<number | Float32Array>>;

  /** The kernels' `seed`: a new one every update, counted from 0 so that runs repeat. */
  private seed = 0;

  /** `resources` are the tables of the artifact's mesh surfaces and volumes, by binding. */
  constructor(
    private readonly artifact: FXBehaviorArtifact,
    private readonly resources: FXKernelResources = {},
  ) {
    this.slot = particleSlotLayout(artifact.buffers);
    this.bindings = ownSlots(artifact.bindings);
    for (const name in resources) {
      this.bindings[name] = { value: resources[name].table.data };
    }
  }

  public get canSpawn(): boolean {
    return this.artifact.spawn !== undefined;
  }

  /** Seeds newborns `[begin, begin + count)`. No-op if the artifact is update-only. */
  public spawn(
    slots: Float32Array,
    begin: number,
    count: number,
    emitter: FXEmitterTransform,
    inherited: Float32Array,
  ): void {
    this.artifact.spawn?.(slots, begin, count, this.seed, this.bindings, emitter, inherited);
  }

  public update(
    slots: Float32Array,
    count: number,
    deltaTime: number,
    emitter?: FXEmitterTransform,
  ): void {
    this.seed = (this.seed + 1) >>> 0;
    this.artifact.update(slots, count, deltaTime, this.seed, this.bindings, emitter);
  }

  /**
   * Sets each named slot in place. An unknown name is ignored. The GPU twin is
   * `FXTransformFeedbackSimulationHolder.applyBindingValues`.
   */
  public applyBindingValues(values: Readonly<Record<string, number | Float32Array>>): void {
    for (const name in values) {
      // A resource is the app's asset, not a value.
      if (name in this.bindings && !(name in this.resources)) {
        this.bindings[name].value = values[name];
      }
    }
  }
}

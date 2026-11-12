import type {
  FXBehaviorArtifact,
  FXEmitterTransform,
  FXValueSlot,
} from "../artifact/FXArtifact.js";
import { ownSlots } from "../artifact/FXValueSlots.Internal.js";
import type { FXSlotLayout } from "../instancedParticle/FXParticleSlot.js";
import { particleSlotLayout } from "../instancedParticle/FXParticleSlot.js";

/**
 * @internal The runtime's JS (CPU) behavior driver - the GPU sibling is
 * `FXTransformFeedbackSimulationHolder`. Holds a precompiled {@link FXBehaviorArtifact} and just
 * calls its `spawn`/`update` each tick (no graph, compiler, or `new Function`). It passes its own
 * bindings (seeded from the artifact's) on every call, so a value scrub is read next tick.
 */
export class FXSimulationHolder {
  /** The particle slot the artifact's kernels index, by the mesh's property keys. */
  public readonly slot: FXSlotLayout;

  // This emitter's own live bindings - never the shared artifact's.
  private readonly bindings: Record<string, FXValueSlot<number | Float32Array>>;

  constructor(private readonly artifact: FXBehaviorArtifact) {
    this.slot = particleSlotLayout(artifact.buffers);
    this.bindings = ownSlots(artifact.bindings);
  }

  public get canSpawn(): boolean {
    return this.artifact.spawn !== undefined;
  }

  /** Seeds newborns `[begin, begin + count)`. No-op if the artifact is update-only. */
  public spawn(
    slots: Float32Array,
    begin: number,
    count: number,
    emitter?: FXEmitterTransform,
  ): void {
    this.artifact.spawn?.(slots, begin, count, this.bindings, emitter);
  }

  public update(
    slots: Float32Array,
    count: number,
    deltaTime: number,
    emitter?: FXEmitterTransform,
  ): void {
    this.artifact.update(slots, count, deltaTime, this.bindings, emitter);
  }

  /** Behavior half of {@link FXEmitter.applyValues}: mutate each named slot in place; unknown name
   *  = no-op. Mirrored by `FXTransformFeedbackSimulationHolder.applyBindingValues` for the GPU
   *  tier - `FXEmitter.applyValues` scrubs both, since either backend may be the active one. */
  public applyBindingValues(values: Readonly<Record<string, number | Float32Array>>): void {
    for (const name in values) {
      if (name in this.bindings) {
        this.bindings[name].value = values[name];
      }
    }
  }
}

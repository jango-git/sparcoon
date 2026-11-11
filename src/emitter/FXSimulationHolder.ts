import type { FXBehaviorArtifact, FXEmitterTransform } from "../artifact/FXArtifact.js";
import type { FXSlotLayout } from "../instancedParticle/FXParticleSlot.js";
import { particleSlotLayout } from "../instancedParticle/FXParticleSlot.js";

/**
 * @internal The runtime's JS (CPU) behavior driver - the GPU sibling is
 * `FXTransformFeedbackSimulationHolder`. Holds a precompiled {@link FXBehaviorArtifact} and just
 * calls its `spawn`/`update` each tick (no graph, compiler, or `new Function`). The artifact's
 * `bindings` record is passed through on every call, so a value scrub is read next tick.
 */
export class FXSimulationHolder {
  /** The particle slot the artifact's kernels index, by the mesh's property keys. */
  public readonly slot: FXSlotLayout;

  constructor(private readonly artifact: FXBehaviorArtifact) {
    this.slot = particleSlotLayout(artifact.buffers);
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
    this.artifact.spawn?.(slots, begin, count, this.artifact.bindings, emitter);
  }

  public update(
    slots: Float32Array,
    count: number,
    deltaTime: number,
    emitter?: FXEmitterTransform,
  ): void {
    this.artifact.update(slots, count, deltaTime, this.artifact.bindings, emitter);
  }

  /** Behavior half of {@link FXEmitter.applyValues}: mutate each named slot in place; unknown name
   *  = no-op. Mirrored by `FXTransformFeedbackSimulationHolder.applyBindingValues` for the GPU
   *  tier - `FXEmitter.applyValues` scrubs both, since either backend may be the active one. */
  public applyBindingValues(values: Readonly<Record<string, number | Float32Array>>): void {
    for (const name in values) {
      if (name in this.artifact.bindings) {
        this.artifact.bindings[name].value = values[name];
      }
    }
  }
}

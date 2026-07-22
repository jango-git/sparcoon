import type {
  FXAttributeDecl,
  FXBehaviorArtifact,
  FXBufferLayout,
  FXEmitterTransform,
  FXKernelBuffers,
} from "../artifact/FXArtifact.js";
import { isCoreBufferName } from "../coreLayout.js";

/**
 * @internal The runtime's JS (CPU) behavior driver - the GPU sibling is
 * `FXTransformFeedbackSimulationHolder`. Holds a precompiled {@link FXBehaviorArtifact} and just
 * calls its `spawn`/`update` each tick (no graph, compiler, or `new Function`). The artifact's
 * `bindings` record is passed through on every call, so a value scrub is read next tick.
 */
export class FXSimulationHolder {
  constructor(private readonly artifact: FXBehaviorArtifact) {}

  /** Declared buffers minus the fixed core `position`/`lifecycle` - one per user attribute. */
  public get attributeBuffers(): readonly FXBufferLayout[] {
    return this.artifact.buffers.filter((buffer) => !isCoreBufferName(buffer.name));
  }

  public get attributeWrites(): readonly FXAttributeDecl[] {
    return this.artifact.attributeWrites;
  }

  public get canSpawn(): boolean {
    return this.artifact.spawn !== undefined;
  }

  public get spawnWrittenBuffers(): readonly string[] {
    return this.artifact.spawnWrittenBuffers ?? [];
  }

  public get updateWrittenBuffers(): readonly string[] {
    return this.artifact.updateWrittenBuffers;
  }

  /** Seeds newborns `[begin, begin + count)`. No-op if the artifact is update-only. */
  public spawn(
    buffers: FXKernelBuffers,
    begin: number,
    count: number,
    emitter?: FXEmitterTransform,
  ): void {
    this.artifact.spawn?.(buffers, begin, count, this.artifact.bindings, emitter);
  }

  public update(
    buffers: FXKernelBuffers,
    count: number,
    deltaTime: number,
    emitter?: FXEmitterTransform,
  ): void {
    this.artifact.update(buffers, count, deltaTime, this.artifact.bindings, emitter);
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

import type {
  FXAttributeDecl,
  FXBehaviorArtifact,
  FXBufferLayout,
  FXEmitterTransform,
  FXKernelBuffers,
} from "../artifact/FXArtifact.js";
import { FX_CORE_LIFECYCLE, FX_CORE_POSITION } from "../coreLayout.js";

const CORE_BUFFER_NAMES: ReadonlySet<string> = new Set([FX_CORE_POSITION, FX_CORE_LIFECYCLE]);

/**
 * @internal The runtime's behavior driver: holds a precompiled {@link FXBehaviorArtifact} and just
 * calls its `spawn`/`update` each tick (no graph, compiler, or `new Function`). The artifact's
 * `bindings` record is passed through on every call, so a value scrub is read next tick.
 */
export class FXSimulationHolder {
  constructor(private readonly artifact: FXBehaviorArtifact) {}

  /** Declared buffers minus the fixed core `position`/`lifecycle` - one per user attribute. */
  public get attributeBuffers(): readonly FXBufferLayout[] {
    return this.artifact.buffers.filter((buffer) => !CORE_BUFFER_NAMES.has(buffer.name));
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

  /** Behavior half of {@link FXEmitter.applyValues}: mutate each named slot in place; unknown name = no-op. */
  public applyBindingValues(values: Readonly<Record<string, number | Float32Array>>): void {
    for (const name in values) {
      if (name in this.artifact.bindings) {
        this.artifact.bindings[name].value = values[name];
      }
    }
  }
}

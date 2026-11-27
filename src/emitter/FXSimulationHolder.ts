import type {
  FXBehaviorArtifact,
  FXEmitterTransform,
  FXValueSlot,
} from "../artifact/FXArtifact.js";
import { ownSlots } from "../artifact/FXValueSlots.Internal.js";
import type { FXSlotLayout } from "../instancedParticle/FXParticleSlot.js";
import { particleSlotLayout } from "../instancedParticle/FXParticleSlot.js";
import { fxObjectInputNames } from "../surfaceTableLayout.js";
import type { FXKernelResources } from "./FXKernelResources.Internal.js";
import { FXObjectPoses } from "./FXObjectPose.Internal.js";

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

  /** The bindings the runtime fills from the app's assets, which no value reaches. */
  private readonly assetBindings = new Set<string>();
  private readonly poses: FXObjectPoses;

  /** The kernels' `seed`: a new one every update, counted from 0 so that runs repeat. */
  private seed = 0;

  /** `resources` are the artifact's resources (see `FXKernelResourceNames`), by binding. */
  constructor(
    private readonly artifact: FXBehaviorArtifact,
    resources: FXKernelResources = {},
  ) {
    this.slot = particleSlotLayout(artifact.buffers);
    this.bindings = ownSlots(artifact.bindings);
    for (const name in resources) {
      this.bindAsset(name, { value: resources[name].table.data });
    }
    this.poses = new FXObjectPoses(resources, artifact.movingSurfaces);
    for (const name in this.poses.byName) {
      const pose = this.poses.byName[name];
      const inputs = fxObjectInputNames(name);
      this.bindAsset(inputs.entries, pose.entries);
      this.bindAsset(inputs.bones, pose.bones);
      this.bindAsset(inputs.previousBones, pose.previousBones);
    }
  }

  public get canSpawn(): boolean {
    return this.artifact.spawn !== undefined;
  }

  /** Moves the object surfaces' poses on by a tick of `deltaTime`, before its births. */
  public advance(deltaTime: number): void {
    this.poses.advance(deltaTime);
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
      if (name in this.bindings && !this.assetBindings.has(name)) {
        this.bindings[name].value = values[name];
      }
    }
  }

  private bindAsset(name: string, slot: FXValueSlot<Float32Array>): void {
    this.bindings[name] = slot;
    this.assetBindings.add(name);
  }
}

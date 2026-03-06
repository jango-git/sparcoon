import { NormalBlending, Object3D, type Blending } from "three";
import type { FXBehaviorModule } from "../behaviorModules/FXBehaviorModule";
import { FXInstancedParticle } from "../instancedParticle/FXInstancedParticle";
import {
  collectProperties,
  collectUniforms,
} from "../instancedParticle/FXInstancedParticle.Internal";
import { resolveGLSLTypeInfo, type GLProperty, type GLTypeInfo } from "../instancedParticle/shared";
import {
  BUILTIN_OFFSET_AGE,
  BUILTIN_OFFSET_POSITION_X,
  BUILTIN_OFFSET_POSITION_Y,
  BUILTIN_OFFSET_RANDOM_A,
  BUILTIN_OFFSET_RANDOM_B,
  BUILTIN_OFFSET_RANDOM_C,
  BUILTIN_OFFSET_ROTATION,
  BUILTIN_OFFSET_TORQUE,
  BUILTIN_OFFSET_VELOCITY_X,
  BUILTIN_OFFSET_VELOCITY_Y,
} from "../miscellaneous/miscellaneous";
import type { FXRenderingModule } from "../renderingModules/FXRenderingModule";
import type { FXSpawnModule } from "../spawnModules/FXSpawnModule";
import type { FXEmitterPlayOptions } from "./FXEmitter.Internal";
import {
  EMITTER_DEFAULT_AUTOMATICALLY_DESTROY_MODULES,
  EMITTER_DEFAULT_CAPACITY_STEP,
  EMITTER_DEFAULT_EXPECTED_CAPACITY,
} from "./FXEmitter.Internal";

export interface FXEmitterOptions {
  expectedCapacity: number;
  capacityStep: number;
  automaticallyDestroyModules: boolean;
  blending: Blending;
  useAlphaHashing: boolean;
}

const INSTANCES = new Array<FXEmitter>();

export class FXEmitter extends Object3D {
  public automaticallyDestroyModules: boolean;
  private readonly mesh: FXInstancedParticle;

  private emissionRate = 0;
  private emissionAccumulator = 0;
  private emissionDuration = Infinity;
  private emissionElapsed = 0;

  constructor(
    private readonly spawnSequence: FXSpawnModule[],
    private readonly behaviorSequence: readonly FXBehaviorModule[],
    private readonly renderingSequence: readonly FXRenderingModule[],
    options: Partial<FXEmitterOptions> = {},
  ) {
    super();
    const collectedProperties: Record<string, GLTypeInfo> = {
      builtin: resolveGLSLTypeInfo("Matrix4"),
    };
    collectProperties(collectedProperties, spawnSequence, "UIEmitter.constructor.spawnSequence:");
    collectProperties(
      collectedProperties,
      behaviorSequence,
      "UIEmitter.constructor.behaviorSequence",
    );
    collectProperties(
      collectedProperties,
      renderingSequence,
      "UIEmitter.constructor.renderingSequence",
    );

    const collectedUniforms: Record<string, GLProperty> = {};
    collectUniforms(
      collectedUniforms,
      renderingSequence,
      "UIEmitter.constructor.renderingSequence",
    );

    this.mesh = new FXInstancedParticle(
      this.renderingSequence.map((module) => module.source),
      collectedUniforms,
      collectedProperties,
      options.expectedCapacity ?? EMITTER_DEFAULT_EXPECTED_CAPACITY,
      options.capacityStep ?? EMITTER_DEFAULT_CAPACITY_STEP,
      options.blending ?? NormalBlending,
      options.useAlphaHashing ?? false,
    );

    this.automaticallyDestroyModules =
      options.automaticallyDestroyModules ?? EMITTER_DEFAULT_AUTOMATICALLY_DESTROY_MODULES;

    this.add(this.mesh);
    INSTANCES.push(this);
  }

  public static onWillRender = (deltaTime: number): void => {
    for (const instance of INSTANCES) {
      instance.onRendering(deltaTime);
    }
  };

  public destroy(): void {
    const index = INSTANCES.indexOf(this);
    if (index !== -1) {
      INSTANCES.splice(index, 1);
    }

    if (this.automaticallyDestroyModules) {
      for (const module of this.spawnSequence) {
        module.destroy?.();
      }
      for (const module of this.behaviorSequence) {
        module.destroy?.();
      }
      for (const module of this.renderingSequence) {
        module.destroy?.();
      }
    }

    this.removeFromParent();
  }

  public burst(count: number): void {
    const instanceBegin = this.mesh.instanceCount;
    this.mesh.createInstances(count);
    const instanceEnd = this.mesh.instanceCount;

    {
      const { builtin } = this.mesh.propertyBuffers;
      const { array, itemSize } = builtin;

      for (let i = instanceBegin; i < instanceEnd; i++) {
        const itemOffset = i * itemSize;
        array[itemOffset + BUILTIN_OFFSET_RANDOM_A] = Math.random();
        array[itemOffset + BUILTIN_OFFSET_RANDOM_B] = Math.random();
        array[itemOffset + BUILTIN_OFFSET_RANDOM_C] = Math.random();
      }

      builtin.needsUpdate = true;
    }

    for (const spawnModule of this.spawnSequence) {
      spawnModule.spawn(this.mesh.propertyBuffers, instanceBegin, instanceEnd);
    }
  }

  public reset(): void {
    this.mesh.drop();
  }

  public play(rate: number, options: Partial<FXEmitterPlayOptions> = {}): void {
    this.emissionRate = rate;
    this.emissionAccumulator = 0;
    this.emissionDuration = options.duration ?? Infinity;
    this.emissionElapsed = 0;
  }

  public stop(): void {
    this.emissionRate = 0;
    this.emissionAccumulator = 0;
    this.emissionDuration = Infinity;
    this.emissionElapsed = 0;
  }

  private readonly onRendering = (deltaTime: number): void => {
    {
      const { builtin } = this.mesh.propertyBuffers;
      const { array, itemSize } = builtin;

      for (let i = 0; i < this.mesh.instanceCount; i++) {
        array[i * itemSize + BUILTIN_OFFSET_AGE] += deltaTime;
      }

      builtin.needsUpdate = true;
      this.mesh.removeDeadParticles();
    }

    if (this.emissionRate > 0) {
      this.emissionElapsed += deltaTime;

      if (this.emissionElapsed >= this.emissionDuration) {
        this.stop();
      } else {
        this.emissionAccumulator += this.emissionRate * deltaTime;

        const particlesToSpawn = Math.floor(this.emissionAccumulator);
        if (particlesToSpawn > 0) {
          this.burst(particlesToSpawn);
          this.emissionAccumulator -= particlesToSpawn;
        }
      }
    }

    if (this.mesh.instanceCount === 0) {
      return;
    }

    {
      const { propertyBuffers, instanceCount } = this.mesh;

      for (const module of this.behaviorSequence) {
        module.update(propertyBuffers, instanceCount, deltaTime);
      }
    }

    const { builtin } = this.mesh.propertyBuffers;
    const { array, itemSize } = builtin;

    {
      for (let i = 0; i < this.mesh.instanceCount; i++) {
        const itemOffset = i * itemSize;
        array[itemOffset + BUILTIN_OFFSET_POSITION_X] +=
          array[itemOffset + BUILTIN_OFFSET_VELOCITY_X] * deltaTime;
        array[itemOffset + BUILTIN_OFFSET_POSITION_Y] +=
          array[itemOffset + BUILTIN_OFFSET_VELOCITY_Y] * deltaTime;
      }

      builtin.needsUpdate = true;
    }

    {
      for (let i = 0; i < this.mesh.instanceCount; i++) {
        const itemOffset = i * itemSize;
        array[itemOffset + BUILTIN_OFFSET_ROTATION] +=
          array[itemOffset + BUILTIN_OFFSET_TORQUE] * deltaTime;
      }

      builtin.needsUpdate = true;
    }
  };
}

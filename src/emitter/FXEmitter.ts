import type { Camera } from "three";
import { Object3D, Vector3 } from "three";
import { FXInstancedParticle } from "../instancedParticle/FXInstancedParticle";
import type { GLTypeInfo } from "../instancedParticle/shared";
import { resolveGLSLTypeInfo } from "../instancedParticle/shared";
import type { FXMaterial } from "../materials/FXMaterial/FXMaterial";
import {
  BUILTIN_OFFSET_AGE,
  BUILTIN_OFFSET_POSITION_X,
  BUILTIN_OFFSET_POSITION_Y,
  BUILTIN_OFFSET_POSITION_Z,
  BUILTIN_OFFSET_RANDOM_A,
  BUILTIN_OFFSET_RANDOM_B,
  BUILTIN_OFFSET_RANDOM_C,
  BUILTIN_OFFSET_ROTATION,
  BUILTIN_OFFSET_TORQUE,
  BUILTIN_OFFSET_VELOCITY_X,
  BUILTIN_OFFSET_VELOCITY_Y,
  BUILTIN_OFFSET_VELOCITY_Z,
} from "../miscellaneous/miscellaneous";
import type { FXBehavior } from "./behavior/FXBehavior";
import type { FXEmitterPlayOptions } from "./FXEmitter.Internal";
import {
  collectProperties,
  EMITTER_DEFAULT_AUTOMATICALLY_DESTROY_MODULES,
  EMITTER_DEFAULT_CAPACITY_STEP,
  EMITTER_DEFAULT_CAST_SHADOW,
  EMITTER_DEFAULT_EXPECTED_CAPACITY,
  EMITTER_DEFAULT_RECEIVE_SHADOW,
  EMITTER_DEFAULT_SORT_FRACTION,
} from "./FXEmitter.Internal";
import type { FXSpawn } from "./spawn/FXSpawn";

export interface FXEmitterOptions {
  expectedCapacity: number;
  capacityStep: number;
  automaticallyDestroyModules: boolean;
  castShadow: boolean;
  receiveShadow: boolean;
  sortCamera: Camera;
  sortFraction: number;
}

const EMITTERS = new Array<FXEmitter>();

export class FXEmitter extends Object3D {
  public automaticallyDestroyModules: boolean;
  public sortCamera: Camera | undefined;
  public sortFraction: number;

  private readonly mesh: FXInstancedParticle;
  private readonly material: FXMaterial;

  private emissionRate = 0;
  private emissionAccumulator = 0;
  private emissionDuration = Infinity;
  private emissionElapsed = 0;

  private sortingAccumulator = 0;
  private readonly sortingCameraWorldPosition = new Vector3();

  constructor(
    private readonly spawnSequence: FXSpawn[],
    private readonly behaviorSequence: readonly FXBehavior[],
    material: FXMaterial,
    options: Partial<FXEmitterOptions> = {},
  ) {
    super();

    const collectedProperties: Record<string, GLTypeInfo> = {
      builtin: resolveGLSLTypeInfo("Matrix4"),
    };
    collectProperties(collectedProperties, spawnSequence, "FXEmitter.constructor.spawnSequence");
    collectProperties(
      collectedProperties,
      behaviorSequence,
      "FXEmitter.constructor.behaviorSequence",
    );

    const threeMaterial = material.buildThreeMaterial(collectedProperties);

    this.mesh = new FXInstancedParticle(
      collectedProperties,
      options.expectedCapacity ?? EMITTER_DEFAULT_EXPECTED_CAPACITY,
      options.capacityStep ?? EMITTER_DEFAULT_CAPACITY_STEP,
      threeMaterial,
    );

    if (options.castShadow ?? EMITTER_DEFAULT_CAST_SHADOW) {
      this.mesh.castShadow = true;
      this.mesh.customDepthMaterial = material.buildDepthMaterial();
      this.mesh.customDistanceMaterial = material.buildDistanceMaterial();
    }

    if (options.receiveShadow ?? EMITTER_DEFAULT_RECEIVE_SHADOW) {
      this.mesh.receiveShadow = true;
    }

    this.automaticallyDestroyModules =
      options.automaticallyDestroyModules ?? EMITTER_DEFAULT_AUTOMATICALLY_DESTROY_MODULES;
    this.sortCamera = options.sortCamera;
    this.sortFraction = options.sortFraction ?? EMITTER_DEFAULT_SORT_FRACTION;

    this.material = material;
    this.add(this.mesh);
    EMITTERS.push(this);
  }

  public static onWillRender = (deltaTime: number): void => {
    for (const instance of EMITTERS) {
      instance.onRendering(deltaTime);
    }
  };

  public destroy(): void {
    const index = EMITTERS.indexOf(this);
    if (index !== -1) {
      EMITTERS.splice(index, 1);
    }

    if (this.automaticallyDestroyModules) {
      for (const module of this.spawnSequence) {
        module.destroy?.();
      }
      for (const module of this.behaviorSequence) {
        module.destroy?.();
      }
      this.material.destroy();
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
        array[itemOffset + BUILTIN_OFFSET_POSITION_Z] +=
          array[itemOffset + BUILTIN_OFFSET_VELOCITY_Z] * deltaTime;
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

    if (this.sortCamera !== undefined) {
      this.sortingAccumulator += this.sortFraction;

      if (this.sortingAccumulator >= 1) {
        this.sortingAccumulator -= 1;
        this.sortCamera.getWorldPosition(this.sortingCameraWorldPosition);
        this.mesh.sortByDistance(this.sortingCameraWorldPosition);
      }
    }
  };
}

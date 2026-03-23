import type { Camera } from "three";
import type { FXPropertyName, GLTypeInfo } from "../instancedParticle/shared";
import { resolveGLSLTypeInfo } from "../instancedParticle/shared";
import type { FXEmitter } from "./FXEmitter";

/**
 * Configuration options for {@link FXEmitter}
 */
export interface FXEmitterOptions {
  /**
   * Initial buffer size in particles; grows automatically when exceeded
   *
   * @defaultValue `32`
   */
  expectedCapacity: number;

  /**
   * Growth increment added to the buffer when capacity is reached
   *
   * @defaultValue `32`
   */
  capacityStep: number;

  /**
   * Enables shadow casting
   *
   * @defaultValue `false`
   */
  castShadow: boolean;

  /**
   * Enables shadow receiving
   *
   * @defaultValue `false`
   */
  receiveShadow: boolean;

  /** Camera used for back-to-front depth sorting; omit to disable sorting */
  sortCamera: Camera;

  /**
   * Fraction of frames on which sorting runs (`1` = every frame, `0.1` = ~every 10th frame)
   *
   * @defaultValue `0.1`
   */
  sortFraction: number;
}

/**
 * Options for {@link FXEmitter.burst}
 */
export interface FXEmitterBurstOptions {
  /**
   * Delay in seconds before particles are spawned
   *
   * @defaultValue `0`
   */
  delay: number;
}

/**
 * Options for {@link FXEmitter.play}
 */
export interface FXEmitterPlayOptions {
  /**
   * Delay in seconds before emission starts
   *
   * @defaultValue `0`
   */
  delay: number;

  /**
   * Total emission duration in seconds
   *
   * @defaultValue `Infinity`
   */
  duration: number;
}

export const EMITTERS = new Array<FXEmitter>();

export const EMITTER_DEFAULT_EXPECTED_CAPACITY = 32;
export const EMITTER_DEFAULT_CAPACITY_STEP = 32;
export const EMITTER_DEFAULT_CAST_SHADOW = false;
export const EMITTER_DEFAULT_RECEIVE_SHADOW = false;
export const EMITTER_DEFAULT_SORT_FRACTION = 1 / 10;
export const EMITTER_DEFAULT_PREWARM_MIN_STEP_DURATION = 1 / 60;
export const EMITTER_DEFAULT_PREWARM_MAX_STEP_COUNT = 10;

export function collectProperties(
  keeper: Record<string, GLTypeInfo>,
  modules: readonly { requiredProperties?: Record<string, FXPropertyName> }[],
  debugContext: string,
): void {
  for (const module of modules) {
    if (module.requiredProperties === undefined) {
      continue;
    }

    for (const key in module.requiredProperties) {
      const existingTypeInfo = keeper[key] as GLTypeInfo | undefined;
      const newTypeInfo = resolveGLSLTypeInfo(module.requiredProperties[key]);

      if (existingTypeInfo === undefined) {
        keeper[key] = newTypeInfo;
      } else if (existingTypeInfo.glslTypeName !== newTypeInfo.glslTypeName) {
        throw new Error(`${debugContext}: property conflict for "${key}"`);
      }
    }
  }
}

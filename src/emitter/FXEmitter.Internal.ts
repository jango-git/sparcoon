import type { Camera } from "three";
import type { FXPropertyName, GLTypeInfo } from "../instancedParticle/shared";
import { resolveGLSLTypeInfo } from "../instancedParticle/shared";
import type { FXEmitter } from "./FXEmitter";

export interface FXEmitterOptions {
  expectedCapacity: number;
  capacityStep: number;
  automaticallyDestroyModules: boolean;
  castShadow: boolean;
  receiveShadow: boolean;
  sortCamera: Camera;
  sortFraction: number;
}

export interface FXEmitterBurstOptions {
  delay: number;
}

export interface FXEmitterPlayOptions {
  delay: number;
  duration: number;
}

export const EMITTERS = new Array<FXEmitter>();

export const EMITTER_DEFAULT_EXPECTED_CAPACITY = 32;
export const EMITTER_DEFAULT_CAPACITY_STEP = 32;
export const EMITTER_DEFAULT_AUTOMATICALLY_DESTROY_MODULES = true;
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

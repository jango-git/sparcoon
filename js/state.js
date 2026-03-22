/**
 * state.js
 *
 * Global editor state - the single mutable source of truth.
 *
 * The UI reads from it, mutates it directly (via closures), then calls
 * onParamChange() or onStructureChange() to propagate changes.
 */

import {
  SPAWN_MODULES,
  BEHAVIOR_MODULES,
  NODE_REGISTRIES,
  MATERIAL_BASE_PARAMS,
  EMITTER_OPTIONS_PARAMS,
} from "./registry.js";
import { deepClone } from "./utils.js";

// ID generator

let idCounter = 0;

export function nextId() {
  return `id_${++idCounter}`;
}

// Default param values from descriptors

export function defaultParams(descriptors) {
  const result = {};
  for (const descriptor of descriptors) {
    result[descriptor.key] = deepClone(descriptor.default);
  }
  return result;
}

// Factory helpers

export function createModuleState(type, registry) {
  const descriptor = registry[type];
  if (!descriptor) return null;
  return {
    id: nextId(),
    type,
    params: defaultParams(descriptor.params),
  };
}

export function createNodeState(type, registry) {
  const descriptor = registry[type];
  if (!descriptor) return null;
  return {
    id: nextId(),
    type,
    params: defaultParams(descriptor.params),
  };
}

export function createEmitterState(name = "Emitter") {
  return {
    id: nextId(),
    name,
    timeline: [],
    options: defaultParams(EMITTER_OPTIONS_PARAMS),
    spawnModules: [
      createModuleState("FXSpawnOffset", SPAWN_MODULES),
      createModuleState("FXSpawnRandomLifetime", SPAWN_MODULES),
      createModuleState("FXSpawnRandomRotation", SPAWN_MODULES),
      createModuleState("FXSpawnRandomScale", SPAWN_MODULES),
      createModuleState("FXSpawnRandomTorque", SPAWN_MODULES),
      createModuleState("FXSpawnRandomVelocity", SPAWN_MODULES),
    ],
    behaviorModules: [createModuleState("FXBehaviorDirectionalGravity", BEHAVIOR_MODULES)],
    material: {
      type: "FXUnlitMaterial",
      params: defaultParams(MATERIAL_BASE_PARAMS),
      albedoNodes: [],
      normalNodes: [],
      emissionNodes: [],
    },
  };
}

// Singleton state

export const state = {
  emitters: [],
  assets: {}, // id → THREE.Texture
  assetMeta: {}, // id → { name: string, url: string }
};

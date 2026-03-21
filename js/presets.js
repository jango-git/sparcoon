/**
 * presets.js
 *
 * Factory functions for pre-configured emitter states.
 */

import { nextId, defaultParams } from "./state.js";
import {
  MATERIAL_BASE_PARAMS,
  DIFFUSE_EXTRA_PARAMS,
  EMITTER_OPTIONS_PARAMS,
} from "./registry.js";

// Low-level helpers

const generateId = () => nextId();

const createBaseOptions = () => defaultParams(EMITTER_OPTIONS_PARAMS);

function createUnlitParams(overrides = {}) {
  return { ...defaultParams(MATERIAL_BASE_PARAMS), ...overrides };
}

function createDiffuseParams(overrides = {}) {
  return {
    ...defaultParams(MATERIAL_BASE_PARAMS),
    ...defaultParams(DIFFUSE_EXTRA_PARAMS),
    ...overrides,
  };
}

// --- Node builders ---

function colorOverLifeNode(colors) {
  return { id: generateId(), type: "FXColorOverLifeNode", params: { colors } };
}

function sphericalNormalNode() {
  return { id: generateId(), type: "FXSphericalNormalNode", params: {} };
}

// --- Spawn module builders ---

function spawnOffset(x = 0, y = 0, z = 0) {
  return {
    id: generateId(),
    type: "FXSpawnOffset",
    params: { offset: { x, y, z } },
  };
}

function spawnBox(min, max) {
  return { id: generateId(), type: "FXSpawnBox", params: { min, max } };
}

function spawnLifetime(min, max) {
  return {
    id: generateId(),
    type: "FXSpawnRandomLifetime",
    params: { lifetime: { min, max } },
  };
}

function spawnScale(min, max, aspect = 1) {
  return {
    id: generateId(),
    type: "FXSpawnRandomScale",
    params: { scale: { min, max }, aspect },
  };
}

function spawnRotation(spread = Math.PI) {
  return {
    id: generateId(),
    type: "FXSpawnRandomRotation",
    params: { rotation: spread },
  };
}

function spawnVelocity(
  direction,
  angleMid,
  angleSpread,
  magnitudeMin,
  magnitudeMax,
) {
  return {
    id: generateId(),
    type: "FXSpawnRandomVelocity",
    params: {
      direction,
      angleMid,
      angleSpread,
      magnitude: { min: magnitudeMin, max: magnitudeMax },
    },
  };
}

function spawnTorque(base = 0, spread = Math.PI / 2) {
  return {
    id: generateId(),
    type: "FXSpawnRandomTorque",
    params: { base, spread },
  };
}

// --- Behavior module builders ---

function behaviorGravity(y = -9.8) {
  return {
    id: generateId(),
    type: "FXBehaviorDirectionalGravity",
    params: { direction: { x: 0, y, z: 0 } },
  };
}

function behaviorScaleOverLife(scales) {
  return {
    id: generateId(),
    type: "FXBehaviorScaleOverLife",
    params: { scales, aspect: 1 },
  };
}

function behaviorVelocityDamping(value) {
  return {
    id: generateId(),
    type: "FXBehaviorVelocityDamping",
    params: { damping: { min: value, max: value } },
  };
}

function behaviorTorqueDamping(value) {
  return {
    id: generateId(),
    type: "FXBehaviorTorqueDamping",
    params: { damping: value },
  };
}

function behaviorTorqueNoise(scale, strength) {
  return {
    id: generateId(),
    type: "FXBehaviorTorqueNoise",
    params: { scale, strength },
  };
}

function behaviorVelocityNoise(scale, strength) {
  return {
    id: generateId(),
    type: "FXBehaviorVelocityNoise",
    params: { scale, strength },
  };
}

// --- Color stop shorthand ---

function colorStop(hex, alpha) {
  return { hex, alpha };
}

// Preset definitions

export const PRESETS = {
  unlit: {
    label: "Default Unlit",
    create: () => ({
      id: generateId(),
      name: "Unlit",
      rate: 10,
      playing: true,
      options: createBaseOptions(),
      spawnModules: [
        spawnOffset(),
        spawnLifetime(1, 2),
        spawnScale(0.5, 1.5),
        spawnRotation(Math.PI),
        spawnTorque(0, Math.PI / 2),
        spawnVelocity({ x: 0, y: 1, z: 0 }, 0.25, 0.25, 1, 3),
      ],
      behaviorModules: [behaviorGravity(-9.8)],
      material: {
        type: "FXUnlitMaterial",
        params: createUnlitParams({ blending: 2 }),
        albedoNodes: [
          colorOverLifeNode([colorStop("#ffffff", 1), colorStop("#ffffff", 0)]),
        ],
        normalNodes: [],
        emissionNodes: [],
      },
    }),
  },

  diffuse: {
    label: "Default Diffuse",
    create: () => ({
      id: generateId(),
      name: "Diffuse",
      rate: 10,
      playing: true,
      options: createBaseOptions(),
      spawnModules: [
        spawnOffset(),
        spawnLifetime(1, 2),
        spawnScale(0.5, 1.5),
        spawnRotation(Math.PI),
        spawnTorque(0, Math.PI / 2),
        spawnVelocity({ x: 0, y: 1, z: 0 }, 0.25, 0.25, 1, 3),
      ],
      behaviorModules: [behaviorGravity(-9.8)],
      material: {
        type: "FXDiffuseMaterial",
        params: createDiffuseParams(),
        albedoNodes: [
          colorOverLifeNode([colorStop("#ffffff", 1), colorStop("#ffffff", 0)]),
        ],
        normalNodes: [sphericalNormalNode()],
        emissionNodes: [],
      },
    }),
  },

  fire: {
    label: "Fire",
    create: () => [
      {
        id: generateId(),
        name: "Fire",
        rate: 40,
        playing: true,
        options: createBaseOptions(),
        spawnModules: [
          spawnBox({ x: -0.1, y: 0, z: -0.1 }, { x: 0.1, y: 0.3, z: 0.1 }),
          spawnLifetime(0.5, 1.4),
          spawnRotation(Math.PI),
          spawnVelocity({ x: 0, y: 1, z: 0 }, 0.22, 0.05, 1.5, 1.5),
        ],
        behaviorModules: [
          behaviorScaleOverLife([
            { min: 0.15, max: 0.15 },
            { min: 0.5, max: 0.5 },
            { min: 0.05, max: 0.05 },
            { min: 0, max: 0 },
          ]),
          behaviorVelocityDamping(0.12),
          behaviorTorqueNoise(1.2, 0.6),
        ],
        material: {
          type: "FXUnlitMaterial",
          params: createUnlitParams({
            blending: 2,
            alphaTest: 0.005,
            premultipliedAlpha: true,
          }),
          albedoNodes: [
            colorOverLifeNode([
              colorStop("#fff5cc", 1),
              colorStop("#ff9900", 0.9),
              colorStop("#cc2200", 0.55),
              colorStop("#330000", 0),
            ]),
          ],
          normalNodes: [],
          emissionNodes: [],
        },
      },
      {
        id: generateId(),
        name: "Sparks",
        rate: 20,
        playing: true,
        options: createBaseOptions(),
        spawnModules: [
          spawnBox({ x: -0.2, y: 0.5, z: -0.2 }, { x: 0.2, y: 1, z: 0.2 }),
          spawnLifetime(0.5, 1.4),
          spawnRotation(Math.PI),
          spawnVelocity({ x: 0, y: 1, z: 0 }, 0.22, 0.18, 2, 2.5),
        ],
        behaviorModules: [
          behaviorScaleOverLife([
            { min: 0, max: 0 },
            { min: 0.05, max: 0.05 },
          ]),
          behaviorVelocityDamping(0.12),
          behaviorTorqueNoise(1.2, 0.6),
          behaviorVelocityNoise(100, 25),
        ],
        material: {
          type: "FXUnlitMaterial",
          params: createUnlitParams({
            blending: 2,
            alphaTest: 0.005,
            premultipliedAlpha: true,
          }),
          albedoNodes: [
            colorOverLifeNode([
              colorStop("#fff5cc", 1),
              colorStop("#ff9900", 0.9),
              colorStop("#cc2200", 0.55),
              colorStop("#330000", 0),
            ]),
          ],
          normalNodes: [],
          emissionNodes: [],
        },
      },
      {
        id: generateId(),
        name: "Smoke",
        rate: 15,
        playing: true,
        options: {
          ...createBaseOptions(),
          expectedCapacity: 64,
          useSortCamera: true,
        },
        spawnModules: [
          spawnBox({ x: -0.25, y: 1, z: 0.25 }, { x: 0.25, y: 1, z: 0.25 }),
          spawnLifetime(2.5, 4.5),
          spawnRotation(Math.PI),
          spawnTorque(0, Math.PI / 3),
          spawnVelocity({ x: 0, y: 1, z: 0 }, 0.1, 0.1, 1, 2),
        ],
        behaviorModules: [
          behaviorScaleOverLife([
            { min: 0.25, max: 0.25 },
            { min: 1.5, max: 2 },
          ]),
          behaviorVelocityDamping(0.025),
          behaviorTorqueDamping(0.85),
          behaviorTorqueNoise(0.3, 0.9),
          behaviorVelocityNoise(0.2, 0.12),
        ],
        material: {
          type: "FXDiffuseMaterial",
          params: createDiffuseParams({
            blending: 1,
            alphaTest: 0.005,
            premultipliedAlpha: true,
            enableScatter: true,
            scatterTint: "#ffd999",
            scatterPower: 10,
            forwardScatterStrength: 0.25,
            backScatterStrength: 0.05,
            shadowSensitivity: 0.5,
          }),
          albedoNodes: [
            colorOverLifeNode([
              colorStop("#aaaaaa", 0),
              colorStop("#888888", 0.32),
              colorStop("#666666", 0.22),
              colorStop("#333333", 0),
            ]),
          ],
          normalNodes: [sphericalNormalNode()],
          emissionNodes: [],
        },
      },
    ],
  },

  spark: {
    label: "Spark",
    create: () => ({
      id: generateId(),
      name: "Spark",
      rate: 22,
      playing: true,
      options: createBaseOptions(),
      spawnModules: [
        spawnLifetime(0.35, 0.85),
        spawnScale(0.05, 0.13),
        spawnVelocity({ x: 0, y: 1, z: 0 }, 0.65, 0.6, 2.5, 5.5),
      ],
      behaviorModules: [
        behaviorGravity(-9.8),
        behaviorVelocityDamping(0.07),
        behaviorScaleOverLife([
          { min: 1, max: 1 },
          { min: 0, max: 0 },
        ]),
      ],
      material: {
        type: "FXUnlitMaterial",
        params: createUnlitParams({ blending: 2 }),
        albedoNodes: [
          colorOverLifeNode([
            colorStop("#ffffff", 1),
            colorStop("#ffe066", 0.85),
            colorStop("#ff4400", 0.3),
            colorStop("#ff0000", 0),
          ]),
        ],
        normalNodes: [],
        emissionNodes: [],
      },
    }),
  },

  smoke: {
    label: "Smoke",
    create: () => ({
      id: generateId(),
      name: "Smoke",
      rate: 6,
      playing: true,
      options: {
        ...createBaseOptions(),
        expectedCapacity: 64,
        castShadow: true,
      },
      spawnModules: [
        spawnBox({ x: -0.3, y: 0, z: -0.3 }, { x: 0.3, y: 0, z: 0.3 }),
        spawnLifetime(2.5, 4.5),
        spawnScale(0.5, 1.0),
        spawnRotation(Math.PI),
        spawnTorque(0, Math.PI / 3),
        spawnVelocity({ x: 0, y: 1, z: 0 }, 0.1, 0.1, 0.2, 0.55),
      ],
      behaviorModules: [
        behaviorScaleOverLife([
          { min: 0.7, max: 0.7 },
          { min: 2.2, max: 2.2 },
        ]),
        behaviorVelocityDamping(0.025),
        behaviorTorqueDamping(0.85),
        behaviorTorqueNoise(0.3, 0.9),
        behaviorVelocityNoise(0.2, 0.12),
      ],
      material: {
        type: "FXDiffuseMaterial",
        params: createDiffuseParams({
          blending: 1,
          alphaTest: 0.005,
          enableScatter: true,
          forwardScatterStrength: 0.25,
          backScatterStrength: 0.05,
        }),
        albedoNodes: [
          colorOverLifeNode([
            colorStop("#aaaaaa", 0),
            colorStop("#888888", 0.32),
            colorStop("#666666", 0.22),
            colorStop("#333333", 0),
          ]),
        ],
        normalNodes: [sphericalNormalNode()],
        emissionNodes: [],
      },
    }),
  },
};

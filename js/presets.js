/**
 * presets.js
 *
 * Factory functions for pre-configured emitter states.
 */

import { nextId, defaultParams } from "./state.js";
import { MATERIAL_BASE_PARAMS, DIFFUSE_EXTRA_PARAMS, EMITTER_OPTIONS_PARAMS } from "./registry.js";

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
  return { id: generateId(), type: "FXNodeColorOverLife", params: { colors } };
}

function sphericalClipNode(innerRadius = 0) {
  return { id: generateId(), type: "FXNodeSphericalClip", params: { innerRadius } };
}

function sphericalNormalNode() {
  return { id: generateId(), type: "FXNodeSphericalNormal", params: {} };
}

// --- Spawn module builders ---

function spawnPoint(x = 0, y = 0, z = 0) {
  return {
    id: generateId(),
    type: "FXSpawnPoint",
    params: { position: { x, y, z } },
  };
}

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

function spawnSphere(innerRadius = 0, outerRadius = 1, angle = 1.5708) {
  return {
    id: generateId(),
    type: "FXSpawnSphere",
    params: { innerRadius, outerRadius, angle },
  };
}

function spawnLifetime(min, max) {
  return {
    id: generateId(),
    type: "FXSpawnLifetime",
    params: { lifetime: { min, max } },
  };
}

function spawnScale(min, max, aspect = 1) {
  return {
    id: generateId(),
    type: "FXSpawnScale",
    params: { scale: { min, max }, aspect },
  };
}

function spawnRotation(spread = Math.PI) {
  return {
    id: generateId(),
    type: "FXSpawnRotation",
    params: { rotation: spread },
  };
}

function spawnVelocity(direction, angleMid, angleSpread, magnitudeMin, magnitudeMax) {
  return {
    id: generateId(),
    type: "FXSpawnVelocity",
    params: {
      direction,
      angleMid,
      angleSpread,
      magnitude: { min: magnitudeMin, max: magnitudeMax },
    },
  };
}

function spawnTorque(base = 0, spread = 1.5708) {
  return {
    id: generateId(),
    type: "FXSpawnTorque",
    params: { base, spread },
  };
}

// --- Behavior module builders ---

function behaviorGravity(x = 0, y = -9.8, z = 0) {
  const magnitude = Math.sqrt(x * x + y * y + z * z) || 1;
  return {
    id: generateId(),
    type: "FXBehaviorDirectionalForce",
    params: {
      direction: { x: x / magnitude, y: y / magnitude, z: z / magnitude },
      magnitude,
    },
  };
}

function rangesToCurve(ranges) {
  const n = ranges.length;
  return ranges.map((r, i) => ({
    position: n <= 1 ? 0 : i / (n - 1),
    center: (r.min + r.max) / 2,
    spread: (r.max - r.min) / 2,
  }));
}

function behaviorScaleOverLife(scales) {
  return {
    id: generateId(),
    type: "FXBehaviorScaleOverLife",
    params: { curve: rangesToCurve(scales), aspect: 1 },
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
      timeline: [{ id: generateId(), type: "play", rate: 10, delay: 0 }],
      options: createBaseOptions(),
      spawnModules: [
        spawnPoint(),
        spawnLifetime(1, 2),
        spawnScale(0.5, 1.5),
        spawnVelocity({ x: 0, y: 1, z: 0 }, 0.25, 0.25, 1, 3),
      ],
      behaviorModules: [behaviorGravity(0, -9.8, 0)],
      material: {
        type: "FXUnlitMaterial",
        params: createUnlitParams({ blending: 2 }),
        albedoNodes: [colorOverLifeNode([colorStop("#ffffff", 1), colorStop("#ffffff", 0)])],
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
      timeline: [{ id: generateId(), type: "play", rate: 10, delay: 0 }],
      options: createBaseOptions(),
      spawnModules: [
        spawnPoint(),
        spawnLifetime(1, 2),
        spawnScale(0.5, 1.5),
        spawnVelocity({ x: 0, y: 1, z: 0 }, 0.25, 0.25, 1, 3),
      ],
      behaviorModules: [behaviorGravity(0, -9.8, 0)],
      material: {
        type: "FXDiffuseMaterial",
        params: createDiffuseParams(),
        albedoNodes: [colorOverLifeNode([colorStop("#ffffff", 1), colorStop("#ffffff", 0)])],
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
        timeline: [{ id: generateId(), type: "play", rate: 32, delay: 0 }],
        options: createBaseOptions(),
        spawnModules: [
          spawnSphere(0, 0.05, 0),
          spawnOffset(0, 0.1, 0),
          spawnLifetime(0.75, 1),
          spawnVelocity({ x: 0, y: 1, z: 0 }, 0, 0.16, 0.5, 1.12),
        ],
        behaviorModules: [
          behaviorVelocityDamping(0.12),
          behaviorScaleOverLife([
            { min: 0, max: 0 },
            { min: 0.212, max: 0.212 },
            { min: 0.275, max: 0.275 },
            { min: 0.212, max: 0.212 },
            { min: 0.05, max: 0.05 },
            { min: 0, max: 0 },
          ]),
        ],
        material: {
          type: "FXUnlitMaterial",
          params: createUnlitParams({
            blending: 2,
            alphaTest: 0.0075,
            depthAlphaTest: 0.5,
            premultipliedAlpha: true,
          }),
          albedoNodes: [
            colorOverLifeNode([
              colorStop("#fff5cc", 1),
              colorStop("#ff9900", 0.9),
              colorStop("#cc2200", 0.55),
              colorStop("#330000", 0),
            ]),
            sphericalClipNode(0.4),
          ],
          normalNodes: [],
          emissionNodes: [],
        },
      },
      {
        id: generateId(),
        name: "FireSpark",
        timeline: [{ id: generateId(), type: "play", rate: 8, delay: 0 }],
        options: { ...createBaseOptions(), expectedCapacity: 32 },
        spawnModules: [
          spawnSphere(0, 0.35, 0.1),
          spawnOffset(0, 0.35, 0),
          spawnLifetime(0.85, 0.85),
          spawnVelocity({ x: 0, y: 1, z: 0 }, 0.12, 0.1, 2, 2.5),
        ],
        behaviorModules: [
          behaviorVelocityDamping(0.07),
          behaviorVelocityNoise(1000, 20),
          behaviorScaleOverLife([
            { min: 0, max: 0 },
            { min: 0.025, max: 0.035 },
            { min: 0, max: 0 },
          ]),
        ],
        material: {
          type: "FXUnlitMaterial",
          params: createUnlitParams({
            blending: 2,
            alphaTest: 0.0075,
            depthAlphaTest: 0.5,
            premultipliedAlpha: true,
          }),
          albedoNodes: [
            colorOverLifeNode([
              colorStop("#ffffff", 1),
              colorStop("#ffe066", 0.85),
              colorStop("#ff4400", 0.3),
              colorStop("#ff0000", 0),
            ]),
            sphericalClipNode(),
          ],
          normalNodes: [],
          emissionNodes: [],
        },
      },
      {
        id: generateId(),
        name: "FireSmoke",
        timeline: [{ id: generateId(), type: "play", rate: 15, delay: 0 }],
        options: {
          ...createBaseOptions(),
          expectedCapacity: 64,
          useSortCamera: true,
        },
        spawnModules: [
          spawnSphere(0, 0.35),
          spawnOffset(0, 0.5, 0),
          spawnLifetime(2.5, 4.5),
          spawnVelocity({ x: 0, y: 1, z: 0 }, 0.1, 0.1, 1, 2),
        ],
        behaviorModules: [
          behaviorScaleOverLife([
            { min: 0.25, max: 0.25 },
            { min: 1.5, max: 2 },
          ]),
          behaviorVelocityDamping(0.025),
          behaviorVelocityNoise(0.2, 0.12),
          behaviorGravity(-0.5, 0, 0),
        ],
        material: {
          type: "FXDiffuseMaterial",
          params: createDiffuseParams({
            blending: 1,
            alphaTest: 0.0075,
            depthAlphaTest: 0.5,
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
              colorStop("#888888", 0.6),
              colorStop("#666666", 0.3),
              colorStop("#333333", 0),
            ]),
            sphericalClipNode(0.1),
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
      timeline: [{ id: generateId(), type: "play", rate: 22, delay: 0 }],
      options: createBaseOptions(),
      spawnModules: [
        spawnPoint(),
        spawnLifetime(0.35, 0.85),
        spawnVelocity({ x: 0, y: 1, z: 0 }, 0.65, 0.6, 2.5, 5.5),
      ],
      behaviorModules: [
        behaviorGravity(0, -9.8, 0),
        behaviorVelocityDamping(0.07),
        behaviorScaleOverLife([
          { min: 0, max: 0 },
          { min: 0.025, max: 0.05 },
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
          sphericalClipNode(),
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
      timeline: [{ id: generateId(), type: "play", rate: 32, delay: 0 }],
      options: {
        ...createBaseOptions(),
        expectedCapacity: 64,
        useSortCamera: true,
        castShadow: true,
      },
      spawnModules: [
        spawnSphere(0, 0.15, 1.5708),
        spawnOffset(0, 0.15, 0),
        spawnLifetime(2.5, 4.5),
        spawnVelocity({ x: 0, y: 1, z: 0 }, 0.1, 0.1, 1, 2),
      ],
      behaviorModules: [
        behaviorScaleOverLife([
          { min: 0.25, max: 0.25 },
          { min: 1.5, max: 2 },
        ]),
        behaviorVelocityDamping(0.025),
        behaviorVelocityNoise(0.2, 0.12),
        behaviorGravity(-0.5, 0, 0),
      ],
      material: {
        type: "FXDiffuseMaterial",
        params: createDiffuseParams({
          blending: 1,
          alphaTest: 0.0075,
          depthAlphaTest: 0.15,
          premultipliedAlpha: true,
          enableScatter: true,
          scatterTint: "#ffd999",
          scatterPower: 25,
          forwardScatterStrength: 0.25,
          backScatterStrength: 0.05,
          shadowSensitivity: 0.5,
        }),
        albedoNodes: [
          colorOverLifeNode([
            colorStop("#aaaaaa", 0),
            colorStop("#888888", 0.6),
            colorStop("#666666", 0.3),
            colorStop("#333333", 0),
          ]),
          sphericalClipNode(0.1),
        ],
        normalNodes: [sphericalNormalNode()],
        emissionNodes: [],
      },
    }),
  },
};

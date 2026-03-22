/**
 * registry.js
 *
 * Central registry of all sparcoon module types.
 * Each entry describes the module's UI params and how to build the live object.
 *
 * Param descriptor fields:
 *   key      - state key
 *   label    - display label
 *   type     - "number" | "range" | "vec3" | "boolean" | "select" | "color"
 *              | "colors" | "ranges" | "asset" | "slider"
 *   default  - default value
 *   min/max/step - optional constraints for number/range inputs
 *   options  - array of { value, label } for "select" type
 */

import * as FX from "https://esm.sh/sparcoon@0.5.0?deps=three@0.157,fast-simplex-noise@4,ferrsign@0.0.4";
import * as THREE from "https://esm.sh/three@0.157";
import { normalizeColor } from "./utils.js";

// Spawn Modules

export const SPAWN_MODULES = {
  FXSpawnOffset: {
    label: "Offset",
    params: [
      {
        key: "offset",
        label: "Offset",
        type: "vec3",
        default: { x: 0, y: 0, z: 0 },
        step: 0.1,
      },
    ],
    build: (params) => new FX.FXSpawnOffset(params.offset),
  },

  FXSpawnPoint: {
    label: "Position",
    params: [
      {
        key: "position",
        label: "Position",
        type: "vec3",
        default: { x: 0, y: 0, z: 0 },
        step: 0.1,
      },
    ],
    build: (params) => new FX.FXSpawnPoint(params.position),
  },

  FXSpawnBox: {
    label: "Box",
    params: [
      {
        key: "min",
        label: "Min",
        type: "vec3",
        default: { x: -1, y: -1, z: -1 },
        step: 0.1,
      },
      {
        key: "max",
        label: "Max",
        type: "vec3",
        default: { x: 1, y: 1, z: 1 },
        step: 0.1,
      },
    ],
    build: (params) => new FX.FXSpawnBox(params.min, params.max),
  },

  FXSpawnSphere: {
    label: "Sphere",
    params: [
      {
        key: "innerRadius",
        label: "Inner Radius",
        type: "number",
        default: 0.5,
        min: 0,
        step: 0.05,
      },
      {
        key: "outerRadius",
        label: "Outer Radius",
        type: "number",
        default: 1,
        min: 0,
        step: 0.01,
      },
      {
        key: "angle",
        label: "Angle",
        type: "number",
        default: 1.5708,
        min: 0,
        max: 3.14159,
        step: 0.01,
      },
    ],
    build: (params) => new FX.FXSpawnSphere(params.innerRadius, params.outerRadius, params.angle),
  },

  FXSpawnRandomLifetime: {
    label: "Random Lifetime",
    params: [
      {
        key: "lifetime",
        label: "Lifetime",
        type: "range",
        default: { min: 1, max: 3 },
        step: 0.1,
      },
    ],
    build: (params) => new FX.FXSpawnRandomLifetime(params.lifetime),
  },

  FXSpawnRandomRotation: {
    label: "Random Rotation",
    params: [
      {
        key: "rotation",
        label: "Rotation",
        type: "slider",
        default: 3.14159,
        min: 0,
        max: 6.28318,
        step: 0.01,
      },
    ],
    build: (params) =>
      new FX.FXSpawnRandomRotation({
        min: -params.rotation,
        max: params.rotation,
      }),
  },

  FXSpawnRandomScale: {
    label: "Random Scale",
    params: [
      {
        key: "scale",
        label: "Scale",
        type: "range",
        default: { min: 0.5, max: 1.5 },
        step: 0.01,
      },
      {
        key: "aspect",
        label: "Aspect",
        type: "slider",
        default: 1,
        min: 0,
        max: 5,
        step: 0.01,
      },
    ],
    build: (params) => new FX.FXSpawnRandomScale(params.scale, params.aspect),
  },

  FXSpawnRandomTorque: {
    label: "Random Torque",
    params: [
      {
        key: "base",
        label: "Base",
        type: "slider",
        default: 0,
        min: -Math.PI,
        max: Math.PI,
        step: 0.01,
      },
      {
        key: "spread",
        label: "Spread",
        type: "slider",
        default: Math.PI / 2,
        min: 0,
        max: Math.PI,
        step: 0.01,
      },
    ],
    build: (params) =>
      new FX.FXSpawnRandomTorque({
        min: (params.base ?? 0) - (params.spread ?? Math.PI / 2),
        max: (params.base ?? 0) + (params.spread ?? Math.PI / 2),
      }),
  },

  FXSpawnRandomVelocity: {
    label: "Random Velocity",
    params: [
      {
        key: "direction",
        label: "Direction",
        type: "vec3",
        default: { x: 0, y: 1, z: 0 },
        step: 0.01,
      },
      {
        key: "angleMid",
        label: "Cone Angle",
        type: "slider",
        default: 0.25,
        min: 0,
        max: Math.PI / 2,
        step: 0.01,
      },
      {
        key: "angleSpread",
        label: "Cone Spread",
        type: "slider",
        default: 0.25,
        min: 0,
        max: Math.PI / 4,
        step: 0.01,
      },
      {
        key: "magnitude",
        label: "Magnitude",
        type: "range",
        default: { min: 1, max: 3 },
        step: 0.1,
      },
    ],
    build: (params) => {
      const angleMid = params.angleMid ?? 0.25;
      const angleSpread = params.angleSpread ?? 0.25;
      return new FX.FXSpawnRandomVelocity(
        new THREE.Vector3(params.direction.x, params.direction.y, params.direction.z),
        {
          min: Math.max(0, angleMid - angleSpread),
          max: angleMid + angleSpread,
        },
        params.magnitude,
      );
    },
  },
};

// Behavior Modules

export const BEHAVIOR_MODULES = {
  FXBehaviorDirectionalGravity: {
    label: "Directional Gravity",
    params: [
      {
        key: "direction",
        label: "Direction",
        type: "vec3",
        default: { x: 0, y: -9.8, z: 0 },
        step: 0.1,
      },
    ],
    build: (params) => new FX.FXBehaviorDirectionalGravity(params.direction),
  },

  FXBehaviorPointGravity: {
    label: "Point Gravity",
    params: [
      {
        key: "center",
        label: "Center",
        type: "vec3",
        default: { x: 0, y: 0, z: 0 },
        step: 0.1,
      },
      {
        key: "strength",
        label: "Strength",
        type: "range",
        default: { min: 5, max: 10 },
        step: 0.1,
      },
      {
        key: "exponent",
        label: "Exponent",
        type: "range",
        default: { min: 2, max: 2 },
        step: 0.1,
      },
      {
        key: "threshold",
        label: "Threshold",
        type: "range",
        default: { min: 0.1, max: 0.1 },
        step: 0.01,
      },
    ],
    build: (params) =>
      new FX.FXBehaviorPointGravity(
        params.center,
        params.strength,
        params.exponent,
        params.threshold,
      ),
  },

  FXBehaviorScaleOverLife: {
    label: "Scale Over Life",
    params: [
      {
        key: "scales",
        label: "Scales",
        type: "ranges",
        default: [
          { min: 1, max: 1 },
          { min: 0, max: 0 },
        ],
      },
      {
        key: "aspect",
        label: "Aspect",
        type: "number",
        default: 1,
        min: 0.01,
        step: 0.01,
      },
    ],
    build: (params) => new FX.FXBehaviorScaleOverLife(params.scales, params.aspect),
  },

  FXBehaviorTorqueDamping: {
    label: "Torque Damping",
    params: [
      {
        key: "damping",
        label: "Damping",
        type: "number",
        default: 0.5,
        min: 0,
        max: 1,
        step: 0.01,
      },
    ],
    build: (params) => new FX.FXBehaviorTorqueDamping(params.damping),
  },

  FXBehaviorTorqueNoise: {
    label: "Torque Noise",
    params: [
      {
        key: "scale",
        label: "Scale",
        type: "number",
        default: 1,
        min: 0,
        step: 0.01,
      },
      {
        key: "strength",
        label: "Strength",
        type: "number",
        default: 1,
        min: 0,
        step: 0.01,
      },
    ],
    build: (params) => new FX.FXBehaviorTorqueNoise(params.scale, params.strength),
  },

  FXBehaviorVelocityDamping: {
    label: "Velocity Damping",
    params: [
      {
        key: "damping",
        label: "Damping",
        type: "range",
        default: { min: 0.5, max: 0.5 },
        step: 0.01,
      },
    ],
    build: (params) => new FX.FXBehaviorVelocityDamping(params.damping),
  },

  FXBehaviorVelocityNoise: {
    label: "Velocity Noise",
    params: [
      {
        key: "scale",
        label: "Scale",
        type: "number",
        default: 1,
        min: 0,
        step: 0.01,
      },
      {
        key: "strength",
        label: "Strength",
        type: "number",
        default: 1,
        min: 0,
        step: 0.01,
      },
    ],
    build: (params) => new FX.FXBehaviorVelocityNoise(params.scale, params.strength),
  },
};

// Color Nodes

export const COLOR_NODES = {
  FXColorOverLifeNode: {
    label: "Color Over Life",
    params: [
      {
        key: "colors",
        label: "Colors",
        type: "colors",
        default: [
          { hex: "#ffffff", alpha: 1 },
          { hex: "#ffffff", alpha: 0 },
        ],
      },
    ],
    build: (params) =>
      new FX.FXColorOverLifeNode(
        params.colors.map((colorValue) => {
          const normalized = normalizeColor(colorValue);
          return new FX.FXColor(parseInt(normalized.hex.replace("#", ""), 16), normalized.alpha);
        }),
      ),
  },
  FXSphericalClipNode: {
    label: "Spherical Clip",
    params: [
      {
        key: "innerRadius",
        label: "Inner Radius",
        type: "slider",
        default: 0,
        min: 0,
        max: 0.5,
        step: 0.01,
      },
    ],
    build: (params) => new FX.FXSphericalClipNode(params.innerRadius || undefined),
  },
};

// Texture Nodes

export const TEXTURE_NODES = {
  FXStaticTextureNode: {
    label: "Static Texture",
    params: [{ key: "asset", label: "Texture", type: "asset", default: null }],
    build: (params, assets) => {
      if (!params.asset || !assets[params.asset]) return null;
      return new FX.FXStaticTextureNode(assets[params.asset]);
    },
  },

  FXAnimatedTextureNode: {
    label: "Animated Texture",
    params: [
      { key: "asset", label: "Texture", type: "asset", default: null },
      {
        key: "columns",
        label: "Columns",
        type: "number",
        default: 4,
        min: 1,
        step: 1,
      },
      {
        key: "rows",
        label: "Rows",
        type: "number",
        default: 4,
        min: 1,
        step: 1,
      },
      {
        key: "interpolate",
        label: "Interpolate",
        type: "boolean",
        default: false,
      },
    ],
    build: (params, assets) => {
      if (!params.asset || !assets[params.asset]) return null;
      return new FX.FXAnimatedTextureNode({
        texture: assets[params.asset],
        columns: params.columns,
        rows: params.rows,
        interpolate: params.interpolate,
      });
    },
  },
};

// Normal Nodes

export const NORMAL_NODES = {
  FXFlatNormalNode: {
    label: "Flat Normal",
    params: [],
    build: () => new FX.FXFlatNormalNode(),
  },

  FXSphericalNormalNode: {
    label: "Spherical Normal",
    params: [],
    build: () => new FX.FXSphericalNormalNode(),
  },
};

// Node registries per material stack

export const NODE_REGISTRIES = {
  albedoNodes: { ...COLOR_NODES, ...TEXTURE_NODES },
  normalNodes: { ...NORMAL_NODES, ...TEXTURE_NODES },
  emissionNodes: { ...COLOR_NODES, ...TEXTURE_NODES },
};

// Material Params

const BLENDING_OPTIONS = [
  { value: 0, label: "None" },
  { value: 1, label: "Normal" },
  { value: 2, label: "Additive" },
  { value: 3, label: "Subtractive" },
  { value: 4, label: "Multiply" },
];

export const MATERIAL_BASE_PARAMS = [
  {
    key: "blending",
    label: "Blending",
    type: "select",
    default: 1,
    options: BLENDING_OPTIONS,
  },
  {
    key: "useAlphaHashing",
    label: "Alpha Hashing",
    type: "boolean",
    default: false,
  },
  {
    key: "alphaTest",
    label: "Alpha Test",
    type: "slider",
    default: 0.0075,
    min: 0.0075,
    max: 1,
    step: 0.0005,
  },
  {
    key: "depthAlphaTest",
    label: "Depth Alpha Test",
    type: "slider",
    default: 0.5,
    min: 0.0075,
    max: 1,
    step: 0.0025,
  },
  {
    key: "premultipliedAlpha",
    label: "Premult. Alpha",
    type: "boolean",
    default: true,
  },
];

export const DIFFUSE_EXTRA_PARAMS = [
  { key: "enableScatter", label: "Scatter", type: "boolean", default: false },
  {
    key: "scatterTint",
    label: "Scatter Tint",
    type: "color",
    default: "#ffd999",
    hasAlpha: false,
  },
  {
    key: "scatterPower",
    label: "Scatter Power",
    type: "number",
    default: 10,
    min: 0,
    step: 0.01,
  },
  {
    key: "forwardScatterStrength",
    label: "Forward Scatter",
    type: "number",
    default: 1,
    min: 0,
    step: 0.01,
  },
  {
    key: "backScatterStrength",
    label: "Back Scatter",
    type: "number",
    default: 0.25,
    min: 0,
    step: 0.01,
  },
  {
    key: "shadowSensitivity",
    label: "Shadow Sensitivity",
    type: "number",
    default: 0.5,
    min: 0,
    step: 0.01,
  },
];

// Emitter Options Params

export const EMITTER_OPTIONS_PARAMS = [
  {
    key: "expectedCapacity",
    label: "Expected Capacity",
    type: "number",
    default: 128,
    min: 1,
    step: 1,
  },
  {
    key: "capacityStep",
    label: "Capacity Step",
    type: "number",
    default: 64,
    min: 1,
    step: 1,
  },
  { key: "castShadow", label: "Cast Shadow", type: "boolean", default: false },
  {
    key: "receiveShadow",
    label: "Receive Shadow",
    type: "boolean",
    default: false,
  },
  {
    key: "useSortCamera",
    label: "Sort by Camera",
    type: "boolean",
    default: false,
  },
  {
    key: "sortFraction",
    label: "Sort Fraction",
    type: "slider",
    default: 0.1,
    min: 0,
    max: 1,
    step: 0.01,
  },
];

// Build helpers - construct live sparcoon objects from state

function buildNode(nodeState, registry, assets) {
  const descriptor = registry[nodeState.type];
  if (!descriptor) return null;
  try {
    return descriptor.build(nodeState.params, assets);
  } catch (error) {
    console.warn(`[registry] Failed to build node "${nodeState.type}":`, error);
    return null;
  }
}

export function buildMaterial(materialState, assets = {}) {
  const materialParams = { ...materialState.params };

  const albedoNodes = (materialState.albedoNodes || [])
    .map((nodeState) => buildNode(nodeState, NODE_REGISTRIES.albedoNodes, assets))
    .filter(Boolean);

  const options = { ...materialParams, albedoNodes };

  if (materialState.type === "FXDiffuseMaterial") {
    const normalNodes = (materialState.normalNodes || [])
      .map((nodeState) => buildNode(nodeState, NODE_REGISTRIES.normalNodes, assets))
      .filter(Boolean);

    const emissionNodes = (materialState.emissionNodes || [])
      .map((nodeState) => buildNode(nodeState, NODE_REGISTRIES.emissionNodes, assets))
      .filter(Boolean);

    // Convert CSS hex string to numeric color for Three.js
    if (options.scatterTint && typeof options.scatterTint === "string") {
      options.scatterTint = parseInt(options.scatterTint.replace("#", ""), 16);
    }

    return new FX.FXDiffuseMaterial({ ...options, normalNodes, emissionNodes });
  }

  return new FX.FXUnlitMaterial(options);
}

export function buildEmitter(emitterState, assets = {}, sceneCamera = null) {
  const spawnModules = emitterState.spawnModules
    .map((moduleState) => {
      const descriptor = SPAWN_MODULES[moduleState.type];
      if (!descriptor) return null;
      try {
        return descriptor.build(moduleState.params);
      } catch (error) {
        console.warn(`[registry] Failed to build spawn "${moduleState.type}":`, error);
        return null;
      }
    })
    .filter(Boolean);

  const behaviorModules = emitterState.behaviorModules
    .map((moduleState) => {
      const descriptor = BEHAVIOR_MODULES[moduleState.type];
      if (!descriptor) return null;
      try {
        return descriptor.build(moduleState.params);
      } catch (error) {
        console.warn(`[registry] Failed to build behavior "${moduleState.type}":`, error);
        return null;
      }
    })
    .filter(Boolean);

  const material = buildMaterial(emitterState.material, assets);

  // Strip UI-only fields; inject sortCamera if requested
  const { useSortCamera, ...emitterOptions } = emitterState.options ?? {};
  if (useSortCamera && sceneCamera) {
    emitterOptions.sortCamera = sceneCamera;
  }

  const emitter = new FX.FXEmitter(spawnModules, behaviorModules, material, emitterOptions);
  emitter.castShadow = !!emitterOptions.castShadow;
  emitter.receiveShadow = !!emitterOptions.receiveShadow;

  return emitter;
}

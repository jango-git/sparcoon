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

import * as FX from "https://esm.sh/sparcoon@0.6.1?deps=three@0.157,fast-simplex-noise@4,ferrsign@0.0.4";
import * as THREE from "https://esm.sh/three@0.157";
import { normalizeColor } from "./utils.js";

// Converts curve editor points { position, center, spread } to FXCurve1DConfig<FXRange>
function curveParamsToAnchors(points) {
  if (!Array.isArray(points) || points.length < 2) return [{ min: 0, max: 0 }];
  return points.map((p) => ({
    position: p.position,
    value: { min: p.center - p.spread, max: p.center + p.spread },
  }));
}

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
    update: (instance, params) => { instance.offset = params.offset; },
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
    update: (instance, params) => { instance.position = params.position; },
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
    update: (instance, params) => {
      instance.size = {
        x: params.max.x - params.min.x,
        y: params.max.y - params.min.y,
        z: params.max.z - params.min.z,
      };
    },
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
    update: (instance, params) => {
      instance.innerRadius = params.innerRadius;
      instance.outerRadius = params.outerRadius;
      instance.angle = params.angle;
    },
  },

  FXSpawnLifetime: {
    label: "Lifetime",
    params: [
      {
        key: "lifetime",
        label: "Lifetime",
        type: "range",
        default: { min: 1, max: 3 },
        step: 0.1,
      },
    ],
    build: (params) => new FX.FXSpawnLifetime(params.lifetime),
    update: (instance, params) => { instance.lifetime = params.lifetime; },
  },

  FXSpawnRotation: {
    label: "Rotation",
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
      new FX.FXSpawnRotation({
        min: -params.rotation,
        max: params.rotation,
      }),
    update: (instance, params) => {
      instance.rotation = { min: -params.rotation, max: params.rotation };
    },
  },

  FXSpawnScale: {
    label: "Scale",
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
    build: (params) => new FX.FXSpawnScale(params.scale, params.aspect),
    update: (instance, params) => {
      instance.scale = params.scale;
      instance.aspect = params.aspect;
    },
  },

  FXSpawnTorque: {
    label: "Torque",
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
      new FX.FXSpawnTorque({
        min: (params.base ?? 0) - (params.spread ?? Math.PI / 2),
        max: (params.base ?? 0) + (params.spread ?? Math.PI / 2),
      }),
    update: (instance, params) => {
      instance.torque = {
        min: (params.base ?? 0) - (params.spread ?? Math.PI / 2),
        max: (params.base ?? 0) + (params.spread ?? Math.PI / 2),
      };
    },
  },

  FXSpawnVelocity: {
    label: "Velocity",
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
      return new FX.FXSpawnVelocity(
        new THREE.Vector3(params.direction.x, params.direction.y, params.direction.z),
        {
          min: Math.max(0, angleMid - angleSpread),
          max: angleMid + angleSpread,
        },
        params.magnitude,
      );
    },
    update: (instance, params) => {
      const angleMid = params.angleMid ?? 0.25;
      const angleSpread = params.angleSpread ?? 0.25;
      instance.direction = new THREE.Vector3(
        params.direction.x, params.direction.y, params.direction.z,
      );
      instance.angle = { min: Math.max(0, angleMid - angleSpread), max: angleMid + angleSpread };
      instance.magnitude = params.magnitude;
    },
  },
};

// Behavior Modules

export const BEHAVIOR_MODULES = {
  FXBehaviorDirectionalForce: {
    label: "Directional Force",
    params: [
      {
        key: "direction",
        label: "Direction",
        type: "vec3",
        default: { x: 0, y: -1, z: 0 },
        step: 0.01,
      },
      {
        key: "magnitude",
        label: "Magnitude",
        type: "number",
        default: 9.8,
        min: 0,
        step: 0.1,
      },
    ],
    build: (params) => new FX.FXBehaviorDirectionalForce(params.direction, params.magnitude),
    update: (instance, params) => {
      instance.direction = params.direction;
      instance.magnitude = params.magnitude;
    },
  },

  FXBehaviorPointForce: {
    label: "Point Force",
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
      new FX.FXBehaviorPointForce(
        params.center,
        params.strength,
        params.exponent,
        params.threshold,
      ),
    update: (instance, params) => {
      instance.center = params.center;
      instance.strength = params.strength;
      instance.exponent = params.exponent;
      instance.threshold = params.threshold;
    },
  },

  FXBehaviorScaleOverLife: {
    label: "Scale Over Life",
    params: [
      {
        key: "curve",
        label: "Curve",
        type: "curve",
        default: [
          { position: 0, center: 1, spread: 0 },
          { position: 1, center: 0, spread: 0 },
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
    build: (params) => {
      const anchors = curveParamsToAnchors(params.curve);
      return new FX.FXBehaviorScaleOverLife(anchors, params.aspect);
    },
  },

  FXBehaviorTorqueOverLife: {
    label: "Torque Over Life",
    params: [
      {
        key: "curve",
        label: "Curve",
        type: "curve",
        default: [
          { position: 0, center: 0, spread: 0 },
          { position: 1, center: 0, spread: 0 },
        ],
      },
    ],
    build: (params) => new FX.FXBehaviorTorqueOverLife(curveParamsToAnchors(params.curve)),
  },

  FXBehaviorVelocityOverLife: {
    label: "Velocity Over Life",
    params: [
      {
        key: "curve",
        label: "Curve",
        type: "curve",
        default: [
          { position: 0, center: 1, spread: 0 },
          { position: 1, center: 0, spread: 0 },
        ],
      },
    ],
    build: (params) => new FX.FXBehaviorVelocityOverLife(curveParamsToAnchors(params.curve)),
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
    update: (instance, params) => { instance.damping = params.damping; },
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
    update: (instance, params) => {
      instance.scale = params.scale;
      instance.strength = params.strength;
    },
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
    update: (instance, params) => { instance.damping = params.damping; },
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
    update: (instance, params) => {
      instance.scale = params.scale;
      instance.strength = params.strength;
    },
  },
};

// Color Nodes

export const COLOR_NODES = {
  FXNodeColorOverLife: {
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
      new FX.FXNodeColorOverLife(
        params.colors.map((colorValue) => {
          const normalized = normalizeColor(colorValue);
          return new FX.FXColor(parseInt(normalized.hex.replace("#", ""), 16), normalized.alpha);
        }),
      ),
    update: (instance, params) => {
      instance.curve = params.colors.map((colorValue) => {
        const normalized = normalizeColor(colorValue);
        return new FX.FXColor(parseInt(normalized.hex.replace("#", ""), 16), normalized.alpha);
      });
    },
  },
  FXNodeSphericalClip: {
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
    build: (params) => new FX.FXNodeSphericalClip(params.innerRadius || undefined),
    update: (instance, params) => { instance.innerRadius = params.innerRadius || 0; },
  },
};

// Texture Nodes

export const TEXTURE_NODES = {
  FXNodeStaticTexture: {
    label: "Static Texture",
    params: [{ key: "asset", label: "Texture", type: "asset", default: null }],
    build: (params, assets) => {
      if (!params.asset || !assets[params.asset]) return null;
      return new FX.FXNodeStaticTexture(assets[params.asset]);
    },
    update: (instance, params, assets) => {
      if (params.asset && assets[params.asset]) instance.textureView = assets[params.asset];
    },
  },

  FXNodeAnimatedTexture: {
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
      return new FX.FXNodeAnimatedTexture({
        texture: assets[params.asset],
        columns: params.columns,
        rows: params.rows,
        interpolate: params.interpolate,
      });
    },
    update: (instance, params, assets) => {
      if (params.asset && assets[params.asset]) instance.textureView = assets[params.asset];
      instance.rows = params.rows;
      instance.columns = params.columns;
      // interpolate is not a live setter; changing it requires a full rebuild
    },
  },
};

// Normal Nodes

export const NORMAL_NODES = {
  FXNodeFlatNormal: {
    label: "Flat Normal",
    params: [],
    build: () => new FX.FXNodeFlatNormal(),
  },

  FXNodeSphericalNormal: {
    label: "Spherical Normal",
    params: [],
    build: () => new FX.FXNodeSphericalNormal(),
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

function buildNode(nodeState, registry, assets, instanceMap) {
  const descriptor = registry[nodeState.type];
  if (!descriptor) return null;
  try {
    const instance = descriptor.build(nodeState.params, assets);
    if (instance && instanceMap) instanceMap.set(nodeState.id, instance);
    return instance;
  } catch (error) {
    console.warn(`[registry] Failed to build node "${nodeState.type}":`, error);
    return null;
  }
}

export function buildMaterial(materialState, assets = {}, instanceMap = null) {
  const materialParams = { ...materialState.params };

  const albedoNodes = (materialState.albedoNodes || [])
    .map((nodeState) => buildNode(nodeState, NODE_REGISTRIES.albedoNodes, assets, instanceMap))
    .filter(Boolean);

  const options = { ...materialParams, albedoNodes };

  if (materialState.type === "FXDiffuseMaterial") {
    const normalNodes = (materialState.normalNodes || [])
      .map((nodeState) => buildNode(nodeState, NODE_REGISTRIES.normalNodes, assets, instanceMap))
      .filter(Boolean);

    const emissionNodes = (materialState.emissionNodes || [])
      .map((nodeState) => buildNode(nodeState, NODE_REGISTRIES.emissionNodes, assets, instanceMap))
      .filter(Boolean);

    // Convert CSS hex string to numeric color for Three.js
    if (options.scatterTint && typeof options.scatterTint === "string") {
      options.scatterTint = parseInt(options.scatterTint.replace("#", ""), 16);
    }

    return new FX.FXDiffuseMaterial({ ...options, normalNodes, emissionNodes });
  }

  return new FX.FXUnlitMaterial(options);
}

export function buildEmitter(emitterState, assets = {}, sceneCamera = null, instanceMap = null) {
  const spawnModules = emitterState.spawnModules
    .map((moduleState) => {
      const descriptor = SPAWN_MODULES[moduleState.type];
      if (!descriptor) return null;
      try {
        const instance = descriptor.build(moduleState.params);
        if (instance && instanceMap) instanceMap.set(moduleState.id, instance);
        return instance;
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
        const instance = descriptor.build(moduleState.params);
        if (instance && instanceMap) instanceMap.set(moduleState.id, instance);
        return instance;
      } catch (error) {
        console.warn(`[registry] Failed to build behavior "${moduleState.type}":`, error);
        return null;
      }
    })
    .filter(Boolean);

  const material = buildMaterial(emitterState.material, assets, instanceMap);

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

// Live parameter update — applies params to an existing instance without rebuild.
// Returns true if the update was applied, false if a full rebuild is needed.

const ALL_DESCRIPTORS = {
  ...SPAWN_MODULES,
  ...BEHAVIOR_MODULES,
  ...COLOR_NODES,
  ...TEXTURE_NODES,
  ...NORMAL_NODES,
};

export function liveUpdate(instanceMap, moduleId, type, params, assets = {}) {
  const instance = instanceMap.get(moduleId);
  if (!instance) return false;
  const descriptor = ALL_DESCRIPTORS[type];
  if (!descriptor?.update) return false;
  try {
    descriptor.update(instance, params, assets);
    return true;
  } catch (e) {
    console.warn(`[registry] Live update failed for "${type}":`, e);
    return false;
  }
}

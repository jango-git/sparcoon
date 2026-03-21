/**
 * export.js
 *
 * Save / load the emitter stack as a JSON file.
 * Export the emitter stack as a TypeScript class.
 *
 * setupExportTab({ onStructureChange }) - wires all export-tab buttons.
 */

import { state } from "./state.js";
import {
  getAssetsAsBase64,
  restoreAssetsFromJson,
  renderAssetsTab,
} from "./assets.js";

// JSON save / load

// --- Validation helpers ---

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateModule(module, context) {
  if (
    !isPlainObject(module) ||
    typeof module.id !== "string" ||
    typeof module.type !== "string" ||
    !isPlainObject(module.params)
  ) {
    console.warn(`[import] Dropping invalid module in ${context}:`, module);
    return false;
  }
  return true;
}

function validateEmitter(emitter) {
  if (
    !isPlainObject(emitter) ||
    typeof emitter.id !== "string" ||
    typeof emitter.name !== "string" ||
    typeof emitter.rate !== "number" ||
    !isFinite(emitter.rate) ||
    !Array.isArray(emitter.spawnModules) ||
    !Array.isArray(emitter.behaviorModules) ||
    !isPlainObject(emitter.material) ||
    !isPlainObject(emitter.options)
  ) {
    console.warn("[import] Dropping invalid emitter:", emitter);
    return false;
  }

  const material = emitter.material;
  if (
    typeof material.type !== "string" ||
    !isPlainObject(material.params) ||
    !Array.isArray(material.albedoNodes)
  ) {
    console.warn(
      `[import] Dropping emitter "${emitter.name}" - invalid material:`,
      material,
    );
    return false;
  }

  return true;
}

// --- Import pipeline ---

function filterNodeArray(nodes, emitterName, stackName) {
  if (!Array.isArray(nodes)) return [];
  return nodes.filter((node) =>
    validateModule(node, `emitter "${emitterName}" ${stackName}`),
  );
}

function parseEmitters(rawArray) {
  if (!Array.isArray(rawArray)) {
    console.warn(
      "[import] Expected a JSON array at the top level - got:",
      typeof rawArray,
    );
    return [];
  }

  const result = [];

  for (const rawEmitter of rawArray) {
    if (!validateEmitter(rawEmitter)) continue;

    const material = {
      ...rawEmitter.material,
      albedoNodes: filterNodeArray(
        rawEmitter.material.albedoNodes,
        rawEmitter.name,
        "albedoNodes",
      ),
      normalNodes: filterNodeArray(
        rawEmitter.material.normalNodes,
        rawEmitter.name,
        "normalNodes",
      ),
      emissionNodes: filterNodeArray(
        rawEmitter.material.emissionNodes,
        rawEmitter.name,
        "emissionNodes",
      ),
    };

    result.push({
      ...rawEmitter,
      spawnModules: rawEmitter.spawnModules.filter((module) =>
        validateModule(module, `emitter "${rawEmitter.name}" spawnModules`),
      ),
      behaviorModules: rawEmitter.behaviorModules.filter((module) =>
        validateModule(module, `emitter "${rawEmitter.name}" behaviorModules`),
      ),
      material,
    });
  }

  return result;
}

// TypeScript codegen

// --- Formatting helpers ---

function formatNumber(value) {
  if (typeof value !== "number" || !isFinite(value)) return "0";
  return parseFloat(value.toFixed(5)).toString();
}

function formatVec3(vector) {
  return `{ x: ${formatNumber(vector?.x ?? 0)}, y: ${formatNumber(vector?.y ?? 0)}, z: ${formatNumber(vector?.z ?? 0)} }`;
}

function formatRange(range) {
  return `{ min: ${formatNumber(range?.min ?? 0)}, max: ${formatNumber(range?.max ?? 0)} }`;
}

function addIndent(text, spaces) {
  const padding = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? padding + line : ""))
    .join("\n");
}

function toPascalCase(name) {
  return (name || "")
    .replace(/[^a-zA-Z0-9 _-]/g, "")
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
}

function toEmitterFieldName(name, usedNames) {
  const words = (name || "emitter")
    .replace(/[^a-zA-Z0-9_]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) words.push("emitter");

  const base =
    words
      .map((word, index) =>
        index === 0
          ? word.charAt(0).toLowerCase() + word.slice(1)
          : word.charAt(0).toUpperCase() + word.slice(1),
      )
      .join("") || "emitter";

  const safe = /^\d/.test(base) ? `_${base}` : base;

  if (!usedNames.has(safe)) {
    usedNames.add(safe);
    return safe;
  }

  let counter = 2;
  while (usedNames.has(`${safe}${counter}`)) counter++;
  const unique = `${safe}${counter}`;
  usedNames.add(unique);
  return unique;
}

// --- Spawn module codegen ---

const SPAWN_CODEGEN = {
  FXSpawnOffset: (params) => `new FXSpawnOffset(${formatVec3(params.offset)})`,

  FXSpawnBox: (params) =>
    `new FXSpawnBox(${formatVec3(params.min)}, ${formatVec3(params.max)})`,

  FXSpawnSphere: (params) =>
    `new FXSpawnSphere(${formatNumber(params.innerRadius)}, ${formatNumber(params.outerRadius)}, ${formatNumber(params.angle)})`,

  FXSpawnRandomLifetime: (params) =>
    `new FXSpawnRandomLifetime(${formatRange(params.lifetime)})`,

  FXSpawnRandomRotation: (params) => {
    const spread = params.rotation ?? 0;
    return `new FXSpawnRandomRotation(${formatRange({ min: -spread, max: spread })})`;
  },

  FXSpawnRandomScale: (params) =>
    `new FXSpawnRandomScale(${formatRange(params.scale)}, ${formatNumber(params.aspect)})`,

  FXSpawnRandomTorque: (params) => {
    const base = params.base ?? 0;
    const spread = params.spread ?? Math.PI / 2;
    return `new FXSpawnRandomTorque(${formatRange({ min: base - spread, max: base + spread })})`;
  },

  FXSpawnRandomVelocity: (params) => {
    const direction = params.direction ?? { x: 0, y: 1, z: 0 };
    const angleMid = params.angleMid ?? 0.25;
    const angleSpread = params.angleSpread ?? 0.25;
    const angleMin = Math.max(0, angleMid - angleSpread);
    const angleMax = angleMid + angleSpread;
    return [
      "new FXSpawnRandomVelocity(",
      `  new Vector3(${formatNumber(direction.x)}, ${formatNumber(direction.y)}, ${formatNumber(direction.z)}),`,
      `  { min: ${formatNumber(angleMin)}, max: ${formatNumber(angleMax)} },`,
      `  ${formatRange(params.magnitude)},`,
      ")",
    ].join("\n");
  },
};

// --- Behavior module codegen ---

const BEHAVIOR_CODEGEN = {
  FXBehaviorDirectionalGravity: (params) =>
    `new FXBehaviorDirectionalGravity(${formatVec3(params.direction)})`,

  FXBehaviorPointGravity: (params) =>
    `new FXBehaviorPointGravity(${formatVec3(params.center)}, ${formatRange(params.strength)}, ${formatRange(params.exponent)}, ${formatRange(params.threshold)})`,

  FXBehaviorScaleOverLife: (params) => {
    const scalesString = (params.scales || []).map(formatRange).join(", ");
    return `new FXBehaviorScaleOverLife([${scalesString}], ${formatNumber(params.aspect)})`;
  },

  FXBehaviorTorqueDamping: (params) =>
    `new FXBehaviorTorqueDamping(${formatNumber(params.damping)})`,
  FXBehaviorTorqueNoise: (params) =>
    `new FXBehaviorTorqueNoise(${formatNumber(params.scale)}, ${formatNumber(params.strength)})`,
  FXBehaviorVelocityDamping: (params) =>
    `new FXBehaviorVelocityDamping(${formatRange(params.damping)})`,
  FXBehaviorVelocityNoise: (params) =>
    `new FXBehaviorVelocityNoise(${formatNumber(params.scale)}, ${formatNumber(params.strength)})`,
};

// --- Node codegen ---

const NODE_CODEGEN = {
  FXColorOverLifeNode: (params) => {
    const colorsString = (params.colors || [])
      .map((colorValue) => {
        const hex =
          typeof colorValue === "string"
            ? colorValue.slice(0, 7)
            : (colorValue?.hex ?? "#ffffff");
        const alpha =
          typeof colorValue === "string"
            ? parseInt(colorValue.slice(7, 9) || "ff", 16) / 255
            : (colorValue?.alpha ?? 1);
        const hexNumber = `0x${hex.replace("#", "").toUpperCase()}`;
        return `new FXColor(${hexNumber}, ${formatNumber(alpha)})`;
      })
      .join(", ");
    return `new FXColorOverLifeNode([${colorsString}])`;
  },

  FXStaticTextureNode: (params, textureVariables) => {
    const variableName =
      textureVariables.get(params.asset) ?? "null /* unknown asset */";
    return `new FXStaticTextureNode(${variableName})`;
  },

  FXAnimatedTextureNode: (params, textureVariables) => {
    const variableName =
      textureVariables.get(params.asset) ?? "null /* unknown asset */";
    return [
      "new FXAnimatedTextureNode({",
      `  texture: ${variableName},`,
      `  columns: ${params.columns ?? 4},`,
      `  rows: ${params.rows ?? 4},`,
      `  interpolate: ${!!params.interpolate},`,
      "})",
    ].join("\n");
  },

  FXFlatNormalNode: () => "new FXFlatNormalNode()",
  FXSphericalNormalNode: () => "new FXSphericalNormalNode()",
};

// --- Per-emitter block ---

function buildNodeListCode(nodes, textureVariables) {
  return (nodes || []).map((node) => {
    const codegenFunction = NODE_CODEGEN[node.type];
    return codegenFunction
      ? codegenFunction(node.params, textureVariables)
      : `/* Unknown node: ${node.type} */`;
  });
}

function buildEmitterCode(emitter, fieldName, textureVariables) {
  const materialType = emitter.material?.type ?? "FXUnlitMaterial";
  const materialParams = emitter.material?.params ?? {};
  const isDiffuse = materialType === "FXDiffuseMaterial";
  const emitterOptions = emitter.options ?? {};
  const lines = [];

  // Spawn modules
  lines.push("  [");
  for (const module of emitter.spawnModules ?? []) {
    const codegenFunction = SPAWN_CODEGEN[module.type];
    const code = codegenFunction
      ? codegenFunction(module.params)
      : `/* Unknown spawn: ${module.type} */`;
    lines.push(addIndent(code + ",", 4));
  }
  lines.push("  ],");

  // Behavior modules
  lines.push("  [");
  for (const module of emitter.behaviorModules ?? []) {
    const codegenFunction = BEHAVIOR_CODEGEN[module.type];
    const code = codegenFunction
      ? codegenFunction(module.params)
      : `/* Unknown behavior: ${module.type} */`;
    lines.push(addIndent(code + ",", 4));
  }
  lines.push("  ],");

  // Material
  lines.push(`  new ${materialType}({`);
  lines.push(`    blending: ${materialParams.blending ?? 1},`);
  if (materialParams.useAlphaHashing) lines.push(`    useAlphaHashing: true,`);
  lines.push(
    `    alphaTest: ${formatNumber(materialParams.alphaTest ?? 0.0075)},`,
  );
  lines.push(
    `    premultipliedAlpha: ${!!(materialParams.premultipliedAlpha ?? true)},`,
  );

  if (isDiffuse) {
    if (materialParams.enableScatter) lines.push(`    enableScatter: true,`);
    if (materialParams.scatterTint) {
      const hex = parseInt(materialParams.scatterTint.replace("#", ""), 16);
      lines.push(`    scatterTint: 0x${hex.toString(16).padStart(6, "0")},`);
    }
    if (materialParams.scatterPower != null)
      lines.push(
        `    scatterPower: ${formatNumber(materialParams.scatterPower)},`,
      );
    if (materialParams.forwardScatterStrength != null)
      lines.push(
        `    forwardScatterStrength: ${formatNumber(materialParams.forwardScatterStrength)},`,
      );
    if (materialParams.backScatterStrength != null)
      lines.push(
        `    backScatterStrength: ${formatNumber(materialParams.backScatterStrength)},`,
      );
    if (materialParams.shadowSensitivity != null)
      lines.push(
        `    shadowSensitivity: ${formatNumber(materialParams.shadowSensitivity)},`,
      );
  }

  lines.push("    albedoNodes: [");
  for (const code of buildNodeListCode(
    emitter.material?.albedoNodes,
    textureVariables,
  )) {
    lines.push(addIndent(code + ",", 6));
  }
  lines.push("    ],");

  if (isDiffuse) {
    lines.push("    normalNodes: [");
    for (const code of buildNodeListCode(
      emitter.material?.normalNodes,
      textureVariables,
    )) {
      lines.push(addIndent(code + ",", 6));
    }
    lines.push("    ],");

    lines.push("    emissionNodes: [");
    for (const code of buildNodeListCode(
      emitter.material?.emissionNodes,
      textureVariables,
    )) {
      lines.push(addIndent(code + ",", 6));
    }
    lines.push("    ],");
  }

  lines.push("  }),");

  // Options
  lines.push("  {");
  lines.push(
    `    expectedCapacity: ${emitterOptions.expectedCapacity ?? 128},`,
  );
  lines.push(`    capacityStep: ${emitterOptions.capacityStep ?? 64},`);
  lines.push(`    castShadow: ${!!emitterOptions.castShadow},`);
  lines.push(`    receiveShadow: ${!!emitterOptions.receiveShadow},`);
  if (emitterOptions.useSortCamera) {
    lines.push(`    sortCamera: camera, // pass your render camera`);
    lines.push(
      `    sortFraction: ${formatNumber(emitterOptions.sortFraction ?? 0.1)},`,
    );
  }
  lines.push("  },");

  return [
    `this.${fieldName} = new FXEmitter(`,
    ...lines,
    ");",
    `this.add(this.${fieldName});`,
  ].join("\n");
}

// --- Main generator ---

function generateTypeScript(emitters, className) {
  if (!emitters.length) return "// No emitters to export.\n";

  const safeName = toPascalCase(className) || "MyEffect";

  // Collect texture asset references
  const textureVariables = new Map();
  for (const emitter of emitters) {
    for (const stackKey of ["albedoNodes", "normalNodes", "emissionNodes"]) {
      for (const node of emitter.material?.[stackKey] ?? []) {
        const asset = node.params?.asset;
        if (asset && !textureVariables.has(asset)) {
          const safeSuffix = asset
            .replace(/\.[^.]+$/, "")
            .replace(/[^a-zA-Z0-9]/g, "_")
            .replace(/^(\d)/, "_$1");
          textureVariables.set(asset, `texture${safeSuffix}`);
        }
      }
    }
  }

  // Collect used FX type names
  const usedFxTypes = new Set(["FXEmitter"]);
  const usedThreeTypes = new Set(["Object3D"]);

  for (const emitter of emitters) {
    if (emitter.material?.type) usedFxTypes.add(emitter.material.type);

    for (const module of emitter.spawnModules ?? []) {
      if (SPAWN_CODEGEN[module.type]) {
        usedFxTypes.add(module.type);
        if (module.type === "FXSpawnRandomVelocity")
          usedThreeTypes.add("Vector3");
      }
    }

    for (const module of emitter.behaviorModules ?? []) {
      if (BEHAVIOR_CODEGEN[module.type]) usedFxTypes.add(module.type);
    }

    for (const stackKey of ["albedoNodes", "normalNodes", "emissionNodes"]) {
      for (const node of emitter.material?.[stackKey] ?? []) {
        if (NODE_CODEGEN[node.type]) {
          usedFxTypes.add(node.type);
          if (node.type === "FXColorOverLifeNode") usedFxTypes.add("FXColor");
          if (
            node.type === "FXStaticTextureNode" ||
            node.type === "FXAnimatedTextureNode"
          ) {
            usedThreeTypes.add("Texture");
          }
        }
      }
    }
  }

  // Collect per-emitter field names
  const usedFieldNames = new Set();
  const fieldNames = emitters.map((emitter) =>
    toEmitterFieldName(emitter.name, usedFieldNames),
  );

  const threeImportList = [...usedThreeTypes].sort().join(", ");
  const fxImportList = [...usedFxTypes].sort().join(",\n  ");

  const lines = [
    `import { ${threeImportList} } from "three";`,
    `import {`,
    `  ${fxImportList},`,
    `} from "sparcoon";`,
    "",
    `export class VFX${safeName} extends Object3D {`,
  ];

  for (const fieldName of fieldNames) {
    lines.push(`  private readonly ${fieldName}: FXEmitter;`);
  }

  lines.push("");
  lines.push(`  public constructor() {`);
  lines.push(`    super();`);

  if (textureVariables.size > 0) {
    lines.push("");
    lines.push("    // Textures - replace with loaded Texture instances");
    for (const [assetKey, variableName] of textureVariables) {
      lines.push(
        `    // const ${variableName} = null as unknown as Texture; // ${assetKey}`,
      );
    }
  }

  for (let index = 0; index < emitters.length; index++) {
    lines.push("");
    lines.push(`    // Emitter: "${emitters[index].name}"`);
    lines.push(
      addIndent(
        buildEmitterCode(emitters[index], fieldNames[index], textureVariables),
        4,
      ),
    );
  }

  lines.push(`  }`);
  lines.push("");
  lines.push(`  public play(rate?: number): void {`);
  for (const fieldName of fieldNames) {
    lines.push(`    this.${fieldName}.play(rate);`);
  }
  lines.push(`  }`);
  lines.push("");
  lines.push(`  public stop(): void {`);
  for (const fieldName of fieldNames) {
    lines.push(`    this.${fieldName}.stop();`);
  }
  lines.push(`  }`);
  lines.push(`}`);
  lines.push("");

  return lines.join("\n");
}

// --- Save helper (shared by JSON and TS) ---

async function saveFile(content, suggestedName, mimeType) {
  if (typeof window.showSaveFilePicker === "function") {
    const extension = suggestedName.split(".").pop();
    try {
      const fileHandle = await window.showSaveFilePicker({
        suggestedName,
        types: [
          { description: mimeType, accept: { [mimeType]: [`.${extension}`] } },
        ],
      });
      const writable = await fileHandle.createWritable();
      await writable.write(content);
      await writable.close();
      return;
    } catch (error) {
      if (error.name === "AbortError") return;
      // Fall through to blob download on other errors
    }
  }

  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = suggestedName;
  anchor.click();
  URL.revokeObjectURL(url);
}

// Public API

export function setupExportTab({ onStructureChange }) {
  // Save JSON (includes assets as base64)
  document
    .getElementById("button-export-save")
    .addEventListener("click", async () => {
      const assetsData = await getAssetsAsBase64();
      const payload = { emitters: state.emitters, assets: assetsData };
      saveFile(
        JSON.stringify(payload, null, 2),
        "sparcoon-scene.json",
        "application/json",
      );
    });

  // Load JSON
  const fileInput = document.getElementById("input-export-file");

  document
    .getElementById("button-export-load")
    .addEventListener("click", () => {
      fileInput.click();
    });

  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.addEventListener("load", async () => {
      let parsed;
      try {
        parsed = JSON.parse(reader.result);
      } catch (error) {
        console.warn("[import] Failed to parse JSON:", error);
        return;
      }

      // Support both old format (plain array) and new format ({ emitters, assets })
      const rawEmitters = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.emitters)
          ? parsed.emitters
          : [];

      state.emitters = parseEmitters(rawEmitters);

      if (
        parsed?.assets &&
        typeof parsed.assets === "object" &&
        !Array.isArray(parsed.assets)
      ) {
        await restoreAssetsFromJson(parsed.assets);
        renderAssetsTab();
      }

      onStructureChange();
    });
    reader.readAsText(file);

    // Reset so loading the same file again triggers "change"
    fileInput.value = "";
  });

  // Export TypeScript
  document.getElementById("button-export-ts").addEventListener("click", () => {
    const className =
      document.getElementById("input-classname").value.trim() || "MyEffect";
    const code = generateTypeScript(state.emitters, className);
    const safeName = toPascalCase(className) || "MyEffect";
    saveFile(code, `VFX${safeName}.ts`, "text/plain");
  });
}

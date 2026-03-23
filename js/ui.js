/**
 * ui.js
 *
 * Editor UI orchestration.
 *
 * Public API:
 *   renderEditor()          - full re-render of #emitter-list from state
 *   setupEvents(callbacks)  - attaches top-level event listeners
 *
 * Callbacks (provided by main.js):
 *   onParamChange()     - rebuild the Three.js scene without DOM re-render
 *   onStructureChange() - re-render DOM, then rebuild scene
 */

import {
  state,
  createEmitterState,
  createModuleState,
  createNodeState,
  defaultParams,
} from "./state.js";
import {
  SPAWN_MODULES,
  BEHAVIOR_MODULES,
  NODE_REGISTRIES,
  MATERIAL_BASE_PARAMS,
  DIFFUSE_EXTRA_PARAMS,
  EMITTER_OPTIONS_PARAMS,
} from "./registry.js";
import { makeSortable } from "./draggable.js";
import { PRESETS } from "./presets.js";
import { buildParamsGrid } from "./ui-fields.js";
import { showDropdown } from "./ui-dropdown.js";
import { makeElement } from "./utils.js";

// Callback references (set by setupEvents)

let onParamChangeCallback = () => {};
let onStructureChangeCallback = () => {};

// Accordion state - only one emitter expanded at a time

let expandedEmitterId = null;

function setExpandedEmitter(emitterId) {
  expandedEmitterId = emitterId;
  const cards = document.querySelectorAll(".emitter-card");
  cards.forEach((card) => {
    const isExpanded = card.dataset.emitterId === emitterId;
    card.classList.toggle("emitter-card--collapsed", !isExpanded);
  });
}

// Public: full re-render

export function renderEditor() {
  const list = document.getElementById("emitter-list");
  list.innerHTML = "";

  // If the currently expanded emitter no longer exists, expand the first one
  const emitterIds = state.emitters.map((emitter) => emitter.id);
  if (!emitterIds.includes(expandedEmitterId)) {
    expandedEmitterId = emitterIds[0] ?? null;
  }

  for (const emitter of state.emitters) {
    list.appendChild(buildEmitterCard(emitter));
  }

  makeSortable(list, state.emitters, onStructureChangeCallback, ".emitter-header");
}

// Public: wire top-level event listeners

export function setupEvents({ onParamChange, onStructureChange }) {
  onParamChangeCallback = onParamChange;
  onStructureChangeCallback = onStructureChange;

  // Tab switching
  document.getElementById("tabs").addEventListener("click", (event) => {
    const tabButton = event.target.closest(".tab-button");
    if (!tabButton) return;
    const tabName = tabButton.dataset.tab;
    document.querySelectorAll(".tab-button").forEach((button) => {
      button.classList.toggle("active", button.dataset.tab === tabName);
    });
    document.querySelectorAll(".tab-panel").forEach((panel) => {
      panel.classList.toggle("active", panel.id === `tab-${tabName}`);
    });
  });

  // Add emitter from preset
  document.getElementById("add-emitter-button").addEventListener("click", () => {
    const presetKey = document.getElementById("preset-select").value;
    const preset = PRESETS[presetKey];
    const created = preset ? preset.create() : createEmitterState("Emitter");

    if (Array.isArray(created)) {
      state.emitters.push(...created);
      // Expand the first emitter of the batch
      expandedEmitterId = created[0]?.id ?? expandedEmitterId;
    } else {
      state.emitters.push(created);
      expandedEmitterId = created.id;
    }

    onStructureChangeCallback();
  });
}

// Emitter card

function buildEmitterCard(emitter) {
  const isCollapsed = emitter.id !== expandedEmitterId;
  const card = makeElement("div", `emitter-card${isCollapsed ? " emitter-card--collapsed" : ""}`);
  card.dataset.emitterId = emitter.id;

  // --- Header ---
  const header = buildEmitterHeader(emitter);
  card.appendChild(header);

  // --- Body (collapsible) ---
  const body = makeElement("div", "emitter-body");

  body.appendChild(buildOptionsSection(emitter));
  body.appendChild(
    buildStackSection("Spawn Modules", SPAWN_MODULES, emitter.spawnModules, "card-section--spawn"),
  );
  body.appendChild(
    buildStackSection(
      "Behavior Modules",
      BEHAVIOR_MODULES,
      emitter.behaviorModules,
      "card-section--behavior",
    ),
  );
  body.appendChild(buildMaterialSection(emitter));

  card.appendChild(body);
  return card;
}

function buildEmitterHeader(emitter) {
  const header = makeElement("div", "emitter-header");

  // Collapse toggle arrow
  const collapseToggle = makeElement("button", "emitter-collapse-toggle");
  collapseToggle.textContent = emitter.id === expandedEmitterId ? "▾" : "▸";
  collapseToggle.addEventListener("click", (event) => {
    event.stopPropagation();
    const newId = expandedEmitterId === emitter.id ? null : emitter.id;
    setExpandedEmitter(newId);
    // Update all toggle arrows
    document.querySelectorAll(".emitter-collapse-toggle").forEach((toggle) => {
      const cardElement = toggle.closest(".emitter-card");
      toggle.textContent = cardElement?.dataset.emitterId === expandedEmitterId ? "▾" : "▸";
    });
  });
  header.appendChild(collapseToggle);

  // Name input
  const nameInput = makeElement("input", "emitter-name");
  nameInput.type = "text";
  nameInput.value = emitter.name;

  nameInput.addEventListener("input", () => {
    const sanitized = nameInput.value.replace(/[^a-zA-Z0-9_ ]/g, "");
    if (sanitized !== nameInput.value) {
      const cursorPosition = nameInput.selectionStart - (nameInput.value.length - sanitized.length);
      nameInput.value = sanitized;
      nameInput.setSelectionRange(cursorPosition, cursorPosition);
    }
  });
  nameInput.addEventListener("change", () => {
    emitter.name = nameInput.value;
  });
  header.appendChild(nameInput);

  // Remove emitter
  const removeButton = makeElement("button", "button-danger-plain");
  removeButton.textContent = "✕";
  removeButton.addEventListener("click", () => {
    state.emitters = state.emitters.filter((item) => item.id !== emitter.id);
    onStructureChangeCallback();
  });
  header.appendChild(removeButton);

  return header;
}

// Options section (capacity, shadows, sorting)

function buildOptionsSection(emitter) {
  const section = makeElement("div", "card-section");

  const header = makeElement("div", "section-header");
  const titleSpan = makeElement("span", "section-title");
  titleSpan.textContent = "Options";
  header.appendChild(titleSpan);
  section.appendChild(header);

  section.appendChild(
    buildParamsGrid(EMITTER_OPTIONS_PARAMS, emitter.options, onParamChangeCallback),
  );
  return section;
}

// Stack section (spawn modules / behavior modules)

function buildStackSection(title, registry, moduleList, sectionClass) {
  const section = makeElement(
    "div",
    sectionClass ? `card-section ${sectionClass}` : "card-section",
  );

  const header = makeElement("div", "section-header");
  const titleSpan = makeElement("span", "section-title");
  titleSpan.textContent = title;
  header.appendChild(titleSpan);

  const addButton = makeElement("button", "button-add");
  addButton.textContent = "+ ADD";
  addButton.addEventListener("click", (event) => {
    showDropdown(event.target, registry, (type) => {
      moduleList.push(createModuleState(type, registry));
      onStructureChangeCallback();
    });
  });
  header.appendChild(addButton);
  section.appendChild(header);

  const listContainer = makeElement("div", "sortable-list");
  for (const moduleState of moduleList) {
    listContainer.appendChild(buildModuleCard(moduleState, registry, moduleList));
  }
  section.appendChild(listContainer);
  makeSortable(listContainer, moduleList, onStructureChangeCallback, ".module-card-header");

  return section;
}

function buildModuleCard(moduleState, registry, moduleList) {
  const descriptor = registry[moduleState.type];
  const card = makeElement("div", "module-card");

  const header = makeElement("div", "module-card-header");
  const titleSpan = makeElement("span", "module-title");
  titleSpan.textContent = descriptor ? descriptor.label : moduleState.type;
  header.appendChild(titleSpan);

  const removeButton = makeElement("button", "button-icon button-danger");
  removeButton.textContent = "✕";
  removeButton.addEventListener("click", () => {
    const index = moduleList.findIndex((item) => item.id === moduleState.id);
    if (index !== -1) {
      moduleList.splice(index, 1);
      onStructureChangeCallback();
    }
  });
  header.appendChild(removeButton);
  card.appendChild(header);

  if (descriptor && descriptor.params.length > 0) {
    card.appendChild(buildParamsGrid(descriptor.params, moduleState.params, onParamChangeCallback));
  }

  return card;
}

// Material section

function buildMaterialSection(emitter) {
  const section = makeElement("div", "card-section card-section--material");

  // Header with material type selector
  const header = makeElement("div", "section-header");
  const titleSpan = makeElement("span", "section-title");
  titleSpan.textContent = "Material";
  header.appendChild(titleSpan);

  const typeSelect = makeElement("select", "material-type-select");
  for (const materialType of ["FXUnlitMaterial", "FXDiffuseMaterial"]) {
    const option = makeElement("option");
    option.value = materialType;
    option.textContent = materialType === "FXUnlitMaterial" ? "Unlit" : "Diffuse";
    if (materialType === emitter.material.type) option.selected = true;
    typeSelect.appendChild(option);
  }
  typeSelect.addEventListener("change", () => {
    emitter.material.type = typeSelect.value;

    if (emitter.material.type === "FXDiffuseMaterial") {
      // Ensure diffuse-specific params exist
      for (const descriptor of DIFFUSE_EXTRA_PARAMS) {
        if (!(descriptor.key in emitter.material.params)) {
          emitter.material.params[descriptor.key] = JSON.parse(JSON.stringify(descriptor.default));
        }
      }
      // Ensure at least one normal node
      if (emitter.material.normalNodes.length === 0) {
        emitter.material.normalNodes.push(
          createNodeState("FXNodeSphericalNormal", NODE_REGISTRIES.normalNodes),
        );
      }
    }

    onStructureChangeCallback();
  });
  header.appendChild(typeSelect);
  section.appendChild(header);

  // Base material params
  section.appendChild(
    buildParamsGrid(MATERIAL_BASE_PARAMS, emitter.material.params, onParamChangeCallback),
  );

  // Diffuse-specific extra params
  if (emitter.material.type === "FXDiffuseMaterial") {
    section.appendChild(
      buildParamsGrid(DIFFUSE_EXTRA_PARAMS, emitter.material.params, onParamChangeCallback),
    );
  }

  // Node stacks
  section.appendChild(buildNodeStack("Albedo Nodes", "albedoNodes", emitter));

  if (emitter.material.type === "FXDiffuseMaterial") {
    section.appendChild(buildNodeStack("Normal Nodes", "normalNodes", emitter));
    section.appendChild(buildNodeStack("Emission Nodes", "emissionNodes", emitter));
  }

  return section;
}

// Node stack (albedo / normal / emission)

function buildNodeStack(title, stackKey, emitter) {
  const nodeRegistry = NODE_REGISTRIES[stackKey];
  const nodes = emitter.material[stackKey];

  const section = makeElement("div", "node-section");
  const header = makeElement("div", "section-header");
  const titleSpan = makeElement("span", "section-title section-title--small");
  titleSpan.textContent = title;
  header.appendChild(titleSpan);

  const addButton = makeElement("button", "button-add button-add");
  addButton.textContent = "+ ADD";
  addButton.addEventListener("click", (event) => {
    showDropdown(event.target, nodeRegistry, (type) => {
      nodes.push(createNodeState(type, nodeRegistry));
      onStructureChangeCallback();
    });
  });
  header.appendChild(addButton);
  section.appendChild(header);

  const nodeList = makeElement("div", "sortable-list");
  for (const node of nodes) {
    nodeList.appendChild(buildNodeCard(node, nodeRegistry, nodes));
  }
  section.appendChild(nodeList);
  makeSortable(nodeList, nodes, onStructureChangeCallback, ".module-card-header");

  return section;
}

function buildNodeCard(nodeState, nodeRegistry, nodeList) {
  const descriptor = nodeRegistry[nodeState.type];
  const card = makeElement("div", "node-card");

  const header = makeElement("div", "module-card-header");
  const titleSpan = makeElement("span", "module-title");
  titleSpan.textContent = descriptor ? descriptor.label : nodeState.type;
  header.appendChild(titleSpan);

  const removeButton = makeElement("button", "button-icon button-danger");
  removeButton.textContent = "✕";
  removeButton.addEventListener("click", () => {
    const index = nodeList.findIndex((item) => item.id === nodeState.id);
    if (index !== -1) {
      nodeList.splice(index, 1);
      onStructureChangeCallback();
    }
  });
  header.appendChild(removeButton);
  card.appendChild(header);

  if (descriptor && descriptor.params.length > 0) {
    card.appendChild(buildParamsGrid(descriptor.params, nodeState.params, onParamChangeCallback));
  }

  return card;
}

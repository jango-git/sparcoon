/**
 * main.js
 *
 * Entry point. Wires scene, state, and UI together.
 */

import {
  initScene,
  syncEmitters,
  setEmitterPlaying,
  toggleSun,
  toggleHemisphere,
  toggleBackground,
  toggleHuman,
  setSunAngle,
  setBackgroundColor,
  togglePlane,
  resetScene,
} from "./scene.js";
import { renderEditor, setupEvents } from "./ui.js";
import { setupExportTab } from "./export.js";
import { loadAssetsIntoState, setupAssetsTab, renderAssetsTab } from "./assets.js";
import { state } from "./state.js";

// Scene initialization

const canvas = document.getElementById("canvas");
initScene(canvas);

// Load persisted assets, then render the initial scene
loadAssetsIntoState().then(() => {
  renderAssetsTab();
  syncEmitters(state.emitters, state.assets);
});

// Initial UI render (empty emitter list)
renderEditor();

// Debounced rebuild for param changes
// Avoids particle resets while dragging sliders

let paramChangeTimer = null;

function scheduleSyncEmitters() {
  clearTimeout(paramChangeTimer);
  paramChangeTimer = setTimeout(() => syncEmitters(state.emitters, state.assets), 300);
}

// Callbacks: wire UI → scene

const callbacks = {
  onParamChange() {
    scheduleSyncEmitters();
  },

  onStructureChange() {
    clearTimeout(paramChangeTimer);
    renderEditor();
    syncEmitters(state.emitters, state.assets);
  },

  onPlayToggle(emitterId, playing, rate) {
    setEmitterPlaying(emitterId, playing, rate);
  },
};

setupEvents(callbacks);

setupExportTab({ onStructureChange: callbacks.onStructureChange });

setupAssetsTab({
  onAssetsChange() {
    renderEditor();
    syncEmitters(state.emitters, state.assets);
  },
});

// Viewport toggle buttons

function bindToggle(buttonId, toggleFunction) {
  const button = document.getElementById(buttonId);
  button.addEventListener("click", () => {
    const isOn = toggleFunction();
    button.classList.toggle("active", isOn);
  });
}

bindToggle("button-sun", toggleSun);
bindToggle("button-hemisphere", toggleHemisphere);
bindToggle("button-background", toggleBackground);
bindToggle("button-human", toggleHuman);
bindToggle("button-plane", togglePlane);

// Background color picker
document.getElementById("input-bg-color").addEventListener("input", (event) => {
  setBackgroundColor(event.target.value);
});

// Reset button

const SUN_ELEVATION_DEFAULT = 10;
const SUN_AZIMUTH_DEFAULT = 190;

document.getElementById("button-reset").addEventListener("click", () => {
  resetScene();

  // Sync toggle button states
  const toggleButtonIds = [
    "button-sun",
    "button-hemisphere",
    "button-background",
    "button-human",
    "button-plane",
  ];
  for (const buttonId of toggleButtonIds) {
    document.getElementById(buttonId).classList.add("active");
  }

  // Reset background color picker
  document.getElementById("input-bg-color").value = "#9abfd4";

  // Reset sun sliders
  sunElevation = SUN_ELEVATION_DEFAULT;
  sunAzimuth = SUN_AZIMUTH_DEFAULT;
  setSunAngle(sunElevation, sunAzimuth);

  const elevationSlider = document.getElementById("slider-sun-elevation");
  const azimuthSlider = document.getElementById("slider-sun-azimuth");
  elevationSlider.value = sunElevation;
  azimuthSlider.value = sunAzimuth;
  document.getElementById("value-sun-elevation").textContent = `${sunElevation}°`;
  document.getElementById("value-sun-azimuth").textContent = `${sunAzimuth}°`;
});

// Sun angle sliders

let sunElevation = SUN_ELEVATION_DEFAULT;
let sunAzimuth = SUN_AZIMUTH_DEFAULT;

setSunAngle(sunElevation, sunAzimuth);

function bindSunSlider(sliderId, valueId, onInput) {
  const slider = document.getElementById(sliderId);
  const valueDisplay = document.getElementById(valueId);
  slider.addEventListener("input", () => {
    valueDisplay.textContent = `${slider.value}°`;
    onInput(parseInt(slider.value, 10));
  });
}

bindSunSlider("slider-sun-elevation", "value-sun-elevation", (value) => {
  sunElevation = value;
  setSunAngle(sunElevation, sunAzimuth);
});

bindSunSlider("slider-sun-azimuth", "value-sun-azimuth", (value) => {
  sunAzimuth = value;
  setSunAngle(sunElevation, sunAzimuth);
});

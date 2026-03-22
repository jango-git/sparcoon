/**
 * ui-fields.js
 *
 * Field renderer functions for the param editor grid.
 * Each builder returns a DOM element that reads/writes a value in the
 * provided `values` object and calls `onParamChange` on mutation.
 */

import { state } from "./state.js";
import { openAssetPicker } from "./assets.js";
import { makeElement, normalizeColor } from "./utils.js";

// Params grid (container for a list of param rows)

/**
 * Build a param grid - a vertical list of label + field rows.
 * @param {Array}    descriptors   - param descriptors from the registry
 * @param {Object}   values        - live state object to read/write
 * @param {Function} onParamChange - called after any value mutation
 * @returns {HTMLElement}
 */
export function buildParamsGrid(descriptors, values, onParamChange) {
  const grid = makeElement("div", "params-grid");
  for (const descriptor of descriptors) {
    grid.appendChild(buildParamRow(descriptor, values, onParamChange));
  }
  return grid;
}

function buildParamRow(descriptor, values, onParamChange) {
  const row = makeElement("div", "param-row");

  const label = makeElement("label", "param-label");
  label.textContent = descriptor.label;
  row.appendChild(label);

  row.appendChild(buildField(descriptor, values, onParamChange));
  return row;
}

// Field dispatcher

function buildField(descriptor, values, onParamChange) {
  // Seed the default value if missing
  if (values[descriptor.key] === undefined) {
    values[descriptor.key] = JSON.parse(JSON.stringify(descriptor.default));
  }

  switch (descriptor.type) {
    case "number":
      return buildNumberField(descriptor, values, onParamChange);
    case "slider":
      return buildSliderField(descriptor, values, onParamChange);
    case "range":
      return buildRangeField(descriptor, values, onParamChange);
    case "vec3":
      return buildVec3Field(descriptor, values, onParamChange);
    case "boolean":
      return buildBooleanField(descriptor, values, onParamChange);
    case "select":
      return buildSelectField(descriptor, values, onParamChange);
    case "color":
      return buildColorField(descriptor, values, onParamChange);
    case "colors":
      return buildColorsField(descriptor.key, values, onParamChange);
    case "ranges":
      return buildRangesField(descriptor.key, values, onParamChange);
    case "asset":
      return buildAssetField(descriptor, values, onParamChange);
    default:
      return makeElement("span");
  }
}

// Individual field builders

function buildNumberField(descriptor, values, onParamChange) {
  const input = makeElement("input", "param-input");
  input.type = "number";
  input.value = values[descriptor.key];
  if (descriptor.min !== undefined) input.min = descriptor.min;
  if (descriptor.max !== undefined) input.max = descriptor.max;
  if (descriptor.step !== undefined) input.step = descriptor.step;

  input.addEventListener("change", () => {
    values[descriptor.key] = parseFloat(input.value);
    onParamChange();
  });
  return input;
}

function buildSliderField(descriptor, values, onParamChange) {
  const wrapper = makeElement("div", "slider-wrap");

  const slider = makeElement("input");
  slider.type = "range";
  slider.min = descriptor.min ?? 0;
  slider.max = descriptor.max ?? 1;
  slider.step = descriptor.step ?? 0.001;
  slider.value = values[descriptor.key] ?? descriptor.default ?? 0;

  const numberInput = makeElement("input", "param-input slider-number");
  numberInput.type = "number";
  numberInput.min = descriptor.min ?? 0;
  numberInput.max = descriptor.max ?? 1;
  numberInput.step = descriptor.step ?? 0.001;
  numberInput.value = values[descriptor.key] ?? descriptor.default ?? 0;

  slider.addEventListener("input", () => {
    const parsed = parseFloat(slider.value);
    numberInput.value = parsed;
    values[descriptor.key] = parsed;
    onParamChange();
  });

  numberInput.addEventListener("change", () => {
    const parsed = parseFloat(numberInput.value);
    slider.value = parsed;
    values[descriptor.key] = parsed;
    onParamChange();
  });

  wrapper.appendChild(slider);
  wrapper.appendChild(numberInput);
  return wrapper;
}

function buildRangeField(descriptor, values, onParamChange) {
  const wrapper = makeElement("div", "range-wrap");
  const currentValue = values[descriptor.key] || { min: 0, max: 1 };

  const minInput = makeElement("input", "param-input param-input--half");
  minInput.type = "number";
  minInput.placeholder = "min";
  minInput.value = currentValue.min;
  if (descriptor.step) minInput.step = descriptor.step;

  const maxInput = makeElement("input", "param-input param-input--half");
  maxInput.type = "number";
  maxInput.placeholder = "max";
  maxInput.value = currentValue.max;
  if (descriptor.step) maxInput.step = descriptor.step;

  const update = () => {
    values[descriptor.key] = {
      min: parseFloat(minInput.value),
      max: parseFloat(maxInput.value),
    };
    onParamChange();
  };

  minInput.addEventListener("change", update);
  maxInput.addEventListener("change", update);

  wrapper.appendChild(minInput);
  wrapper.appendChild(maxInput);
  return wrapper;
}

function buildVec3Field(descriptor, values, onParamChange) {
  const wrapper = makeElement("div", "vec3-wrap");
  const currentVector = values[descriptor.key] || { x: 0, y: 0, z: 0 };
  const axisInputs = {};

  for (const axis of ["x", "y", "z"]) {
    const input = makeElement("input", "param-input param-input--third");
    input.type = "number";
    input.placeholder = axis;
    input.value = currentVector[axis] ?? 0;
    if (descriptor.step) input.step = descriptor.step;

    input.addEventListener("change", () => {
      values[descriptor.key] = {
        x: parseFloat(axisInputs.x.value),
        y: parseFloat(axisInputs.y.value),
        z: parseFloat(axisInputs.z.value),
      };
      onParamChange();
    });

    axisInputs[axis] = input;
    wrapper.appendChild(input);
  }

  return wrapper;
}

function buildBooleanField(descriptor, values, onParamChange) {
  const wrapper = makeElement("div", "bool-wrap");

  const input = makeElement("input");
  input.type = "checkbox";
  input.checked = values[descriptor.key] ?? false;

  input.addEventListener("change", () => {
    values[descriptor.key] = input.checked;
    onParamChange();
  });

  wrapper.appendChild(input);
  return wrapper;
}

function buildSelectField(descriptor, values, onParamChange) {
  const select = makeElement("select", "param-select");

  for (const option of descriptor.options) {
    const optionElement = makeElement("option");
    optionElement.value = option.value;
    optionElement.textContent = option.label;
    // eslint-disable-next-line eqeqeq
    if (option.value == values[descriptor.key]) optionElement.selected = true;
    select.appendChild(optionElement);
  }

  select.addEventListener("change", () => {
    const raw = select.value;
    values[descriptor.key] = isNaN(Number(raw)) ? raw : Number(raw);
    onParamChange();
  });

  return select;
}

function buildColorField(descriptor, values, onParamChange) {
  const wrapper = makeElement("div", "color-wrap");
  const currentHex = values[descriptor.key] || "#ffffff";
  const rgbPart = currentHex.slice(0, 7);
  const hexAlpha = currentHex.length >= 9 ? currentHex.slice(7, 9) : "ff";
  const alphaValue = parseInt(hexAlpha, 16) / 255;

  const colorInput = makeElement("input");
  colorInput.type = "color";
  colorInput.value = rgbPart;

  let alphaInput = null;

  const update = () => {
    if (descriptor.hasAlpha === false) {
      values[descriptor.key] = colorInput.value;
    } else {
      const alphaHex = Math.round(Math.min(1, Math.max(0, parseFloat(alphaInput.value))) * 255)
        .toString(16)
        .padStart(2, "0");
      values[descriptor.key] = colorInput.value + alphaHex;
    }
    onParamChange();
  };

  colorInput.addEventListener("input", update);
  wrapper.appendChild(colorInput);

  if (descriptor.hasAlpha !== false) {
    alphaInput = makeElement("input", "param-input param-input--alpha");
    alphaInput.type = "number";
    alphaInput.min = 0;
    alphaInput.max = 1;
    alphaInput.step = 0.01;
    alphaInput.value = alphaValue.toFixed(2);
    alphaInput.addEventListener("change", update);
    wrapper.appendChild(alphaInput);
  }

  return wrapper;
}

// Colors field - array of { hex, alpha } color stops

function buildColorsField(key, values, onParamChange) {
  if (!Array.isArray(values[key])) values[key] = [];

  // Normalize any legacy string-format entries in-place
  values[key] = values[key].map(normalizeColor);
  const colorsArray = values[key];

  const wrapper = makeElement("div", "colors-list");

  const rerenderColorsList = () => {
    wrapper.innerHTML = "";

    colorsArray.forEach((colorObject, index) => {
      const row = makeElement("div", "color-row");
      const colorWrap = makeElement("div", "color-wrap");

      const colorInput = makeElement("input");
      colorInput.type = "color";
      colorInput.value = colorObject.hex;

      const alphaSlider = makeElement("input", "color-alpha-slider");
      alphaSlider.type = "range";
      alphaSlider.min = 0;
      alphaSlider.max = 1;
      alphaSlider.step = 0.01;
      alphaSlider.value = colorObject.alpha;

      const updateColor = () => {
        colorsArray[index] = {
          hex: colorInput.value,
          alpha: parseFloat(alphaSlider.value),
        };
        onParamChange();
      };

      colorInput.addEventListener("input", updateColor);
      alphaSlider.addEventListener("input", updateColor);

      colorWrap.appendChild(colorInput);
      colorWrap.appendChild(alphaSlider);
      row.appendChild(colorWrap);

      const removeButton = makeElement("button", "button-icon button-danger");
      removeButton.textContent = "✕";
      removeButton.addEventListener("click", (event) => {
        event.stopPropagation();
        colorsArray.splice(index, 1);
        rerenderColorsList();
        onParamChange();
      });
      row.appendChild(removeButton);

      wrapper.appendChild(row);
    });

    const addButton = makeElement("button", "button-add button-add--small");
    addButton.textContent = "+ Color";
    addButton.addEventListener("click", (event) => {
      event.stopPropagation();
      colorsArray.push({ hex: "#ffffff", alpha: 1 });
      rerenderColorsList();
      onParamChange();
    });
    wrapper.appendChild(addButton);
  };

  rerenderColorsList();
  return wrapper;
}

// Ranges field - array of { min, max } range stops

function buildRangesField(key, values, onParamChange) {
  if (!Array.isArray(values[key])) values[key] = [];
  const rangesArray = values[key];

  const wrapper = makeElement("div", "ranges-list");

  const rerenderRangesList = () => {
    wrapper.innerHTML = "";

    rangesArray.forEach((rangeValue, index) => {
      const row = makeElement("div", "range-row");
      const rangeWrap = makeElement("div", "range-wrap");

      const minInput = makeElement("input", "param-input param-input--half");
      minInput.type = "number";
      minInput.placeholder = "min";
      minInput.value = rangeValue?.min ?? 0;
      minInput.step = "0.01";

      const maxInput = makeElement("input", "param-input param-input--half");
      maxInput.type = "number";
      maxInput.placeholder = "max";
      maxInput.value = rangeValue?.max ?? 1;
      maxInput.step = "0.01";

      const updateRange = () => {
        rangesArray[index] = {
          min: parseFloat(minInput.value),
          max: parseFloat(maxInput.value),
        };
        onParamChange();
      };

      minInput.addEventListener("change", updateRange);
      maxInput.addEventListener("change", updateRange);

      rangeWrap.appendChild(minInput);
      rangeWrap.appendChild(maxInput);
      row.appendChild(rangeWrap);

      const removeButton = makeElement("button", "button-icon button-danger");
      removeButton.textContent = "✕";
      removeButton.addEventListener("click", (event) => {
        event.stopPropagation();
        rangesArray.splice(index, 1);
        rerenderRangesList();
        onParamChange();
      });
      row.appendChild(removeButton);

      wrapper.appendChild(row);
    });

    const addButton = makeElement("button", "button-add button-add--small");
    addButton.textContent = "+ Range";
    addButton.addEventListener("click", (event) => {
      event.stopPropagation();
      rangesArray.push({ min: 0, max: 1 });
      rerenderRangesList();
      onParamChange();
    });
    wrapper.appendChild(addButton);
  };

  rerenderRangesList();
  return wrapper;
}

// Asset picker trigger

function buildAssetField(descriptor, values, onParamChange) {
  const trigger = makeElement("div", "asset-trigger");

  function refreshTriggerContent(currentAssetId) {
    trigger.innerHTML = "";

    if (currentAssetId && state.assetMeta[currentAssetId]) {
      const thumbnail = makeElement("img", "asset-trigger-thumb");
      thumbnail.src = state.assetMeta[currentAssetId].url;

      const label = makeElement("span", "asset-trigger-label");
      label.textContent = currentAssetId;

      trigger.appendChild(thumbnail);
      trigger.appendChild(label);
    } else {
      trigger.textContent = "(none)";
    }
  }

  refreshTriggerContent(values[descriptor.key]);

  trigger.addEventListener("click", () => {
    openAssetPicker(trigger, values[descriptor.key], (selectedAssetId) => {
      values[descriptor.key] = selectedAssetId;
      refreshTriggerContent(selectedAssetId);
      onParamChange();
    });
  });

  return trigger;
}

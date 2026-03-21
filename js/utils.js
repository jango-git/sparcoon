/**
 * utils.js
 *
 * Shared utility functions used across the editor UI.
 */

/**
 * Create a DOM element with an optional class name.
 * @param {string} tag        - HTML tag name
 * @param {string} [className] - CSS class(es) to assign
 * @returns {HTMLElement}
 */
export function makeElement(tag, className) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
}

/**
 * Normalize a color value to the canonical { hex, alpha } object format.
 * Handles both the legacy "#rrggbbaa" string representation and the
 * current { hex: string, alpha: number } object format.
 *
 * @param {string|object} color
 * @returns {{ hex: string, alpha: number }}
 */
export function normalizeColor(color) {
  if (typeof color === "string") {
    return {
      hex: color.slice(0, 7),
      alpha: parseInt(color.slice(7, 9) || "ff", 16) / 255,
    };
  }
  return {
    hex: color?.hex ?? "#ffffff",
    alpha: color?.alpha ?? 1,
  };
}

/**
 * Deep-clone a JSON-safe value.
 * @param {*} value
 * @returns {*}
 */
export function deepClone(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

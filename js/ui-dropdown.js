/**
 * ui-dropdown.js
 *
 * Floating dropdown menu used for "Add module" / "Add node" buttons.
 */

import { makeElement } from "./utils.js";

/**
 * Show a dropdown menu anchored below the given element.
 *
 * @param {HTMLElement} anchor    - button that triggered the dropdown
 * @param {Object}      registry - registry object whose keys are type names
 * @param {Function}    onSelect - called with the chosen type key
 */
export function showDropdown(anchor, registry, onSelect) {
  // Remove any previously open dropdown
  document
    .querySelectorAll(".dropdown-menu")
    .forEach((openMenu) => openMenu.remove());

  const menu = makeElement("div", "dropdown-menu");

  for (const [type, descriptor] of Object.entries(registry)) {
    const item = makeElement("button", "dropdown-item");
    item.textContent = descriptor.label;
    item.addEventListener("click", () => {
      onSelect(type);
      menu.remove();
    });
    menu.appendChild(item);
  }

  // Position the menu below the anchor
  const anchorRect = anchor.getBoundingClientRect();
  menu.style.position = "fixed";
  menu.style.top = `${anchorRect.bottom + 4}px`;
  menu.style.left = `${anchorRect.left}px`;
  menu.style.zIndex = "1000";
  document.body.appendChild(menu);

  // Clamp to viewport right edge (needs a frame for offsetWidth to be available)
  const menuRect = menu.getBoundingClientRect();
  if (menuRect.right > window.innerWidth - 4) {
    menu.style.left = `${window.innerWidth - menuRect.width - 4}px`;
  }

  // Close on outside click (deferred to avoid catching the opening click)
  setTimeout(() => {
    const handleOutsideClick = (event) => {
      if (!menu.contains(event.target)) {
        menu.remove();
        document.removeEventListener("mousedown", handleOutsideClick);
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
  }, 0);
}

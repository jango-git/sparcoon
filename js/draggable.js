/**
 * draggable.js
 *
 * Provides makeSortable() - attaches HTML5 drag-and-drop reordering
 * to a container element whose direct children are sortable items.
 */

/**
 * @param {HTMLElement} container      - parent whose direct children are the sortable items
 * @param {Array}       array          - state array to mutate in-place on reorder
 * @param {Function}    onReorder      - called after the array is mutated
 * @param {string}      handleSelector - CSS selector for the drag handle within each item
 */
export function makeSortable(container, array, onReorder, handleSelector) {
  let draggedIndex = -1;

  function getItems() {
    return Array.from(container.children);
  }

  function clearIndicators() {
    for (const item of getItems()) {
      item.classList.remove("drag-indicator-top", "drag-indicator-bottom");
    }
  }

  function getDropPosition(item, clientY) {
    const rect = item.getBoundingClientRect();
    return clientY < rect.top + rect.height / 2 ? "before" : "after";
  }

  getItems().forEach((item, index) => {
    const handle = handleSelector ? item.querySelector(handleSelector) : item;
    if (!handle) return;

    handle.addEventListener("mousedown", (event) => {
      // Let buttons, inputs, and selects keep their default behaviour
      if (event.target.closest("button, input, select")) return;
      item.draggable = true;
      // Reset draggable if the user just clicks (no drag started)
      document.addEventListener(
        "mouseup",
        () => {
          item.draggable = false;
        },
        { once: true },
      );
    });

    item.addEventListener("dragstart", (event) => {
      draggedIndex = index;
      event.dataTransfer.effectAllowed = "move";
      // Delay so the browser captures the pre-fade snapshot for the drag image
      setTimeout(() => item.classList.add("dragging"), 0);
    });

    item.addEventListener("dragend", () => {
      item.draggable = false;
      item.classList.remove("dragging");
      clearIndicators();
      draggedIndex = -1;
    });

    item.addEventListener("dragover", (event) => {
      if (draggedIndex === -1) return;
      event.preventDefault();
      clearIndicators();
      if (draggedIndex === index) return;
      const position = getDropPosition(item, event.clientY);
      item.classList.add(
        position === "before" ? "drag-indicator-top" : "drag-indicator-bottom",
      );
    });

    item.addEventListener("dragleave", (event) => {
      // Only clear when the pointer truly leaves this item (not just enters a child)
      if (!item.contains(event.relatedTarget)) {
        item.classList.remove("drag-indicator-top", "drag-indicator-bottom");
      }
    });

    item.addEventListener("drop", (event) => {
      event.preventDefault();
      clearIndicators();
      if (draggedIndex === -1 || draggedIndex === index) return;

      const position = getDropPosition(item, event.clientY);
      let targetIndex = position === "before" ? index : index + 1;
      // Compensate for the removed element shifting subsequent indices
      if (draggedIndex < targetIndex) targetIndex -= 1;

      const [movedItem] = array.splice(draggedIndex, 1);
      array.splice(targetIndex, 0, movedItem);
      onReorder();
    });
  });
}

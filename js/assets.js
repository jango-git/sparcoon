/**
 * assets.js
 *
 * Asset management: IndexedDB persistence, THREE.Texture creation,
 * Assets tab UI, and the floating asset picker used by the emitter editor.
 */

import * as THREE from "https://esm.sh/three@0.157";
import { state } from "./state.js";

// IndexedDB helpers

const DB_NAME = "sparcoon-assets";
const DB_VERSION = 1;
const STORE_NAME = "textures";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const database = event.target.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function databasePut(record) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const request = transaction.objectStore(STORE_NAME).put(record);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function databaseGetAll() {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function databaseDelete(id) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const request = transaction.objectStore(STORE_NAME).delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// THREE.Texture from Blob

function blobToTexture(blob) {
  const objectUrl = URL.createObjectURL(blob);
  const texture = new THREE.TextureLoader().load(objectUrl);
  return { texture, url: objectUrl };
}

// State helpers

function registerAsset(id, name, blob) {
  if (state.assetMeta[id]?.url) {
    URL.revokeObjectURL(state.assetMeta[id].url);
  }
  const { texture, url } = blobToTexture(blob);
  state.assets[id] = texture;
  state.assetMeta[id] = { name, url };
}

function unregisterAsset(id) {
  if (state.assetMeta[id]?.url) {
    URL.revokeObjectURL(state.assetMeta[id].url);
  }
  delete state.assets[id];
  delete state.assetMeta[id];
}

// Public: load all persisted assets into state on startup

export async function loadAssetsIntoState() {
  try {
    const records = await databaseGetAll();
    for (const { id, name, blob } of records) {
      registerAsset(id, name, blob);
    }
  } catch (error) {
    console.warn("[assets] Failed to load from IndexedDB:", error);
  }
}

// Public: JSON export / import helpers

export async function getAssetsAsBase64() {
  const records = await databaseGetAll();
  const result = {};
  for (const { id, name, blob } of records) {
    result[id] = { name, data: await blobToBase64(blob) };
  }
  return result;
}

export async function restoreAssetsFromJson(assetsObject) {
  if (typeof assetsObject !== "object" || assetsObject === null) return;

  for (const [id, value] of Object.entries(assetsObject)) {
    if (
      typeof value?.name !== "string" ||
      typeof value?.data !== "string" ||
      !value.data.startsWith("data:")
    ) {
      console.warn(`[import] Skipping invalid asset "${id}"`);
      continue;
    }
    try {
      const blob = base64ToBlob(value.data);
      await databasePut({ id, name: value.name, blob });
      registerAsset(id, value.name, blob);
    } catch (error) {
      console.warn(`[import] Failed to restore asset "${id}":`, error);
    }
  }
}

// Base64 helpers

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(dataUrl) {
  const [header, base64] = dataUrl.split(",");
  const mimeType = header.match(/:(.*?);/)?.[1] ?? "image/png";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
}

// Assets tab UI

let onAssetsChangeCallback = () => {};
let assetsTabGrid = null;

export function setupAssetsTab({ onAssetsChange }) {
  onAssetsChangeCallback = onAssetsChange;
  assetsTabGrid = document.getElementById("assets-grid");

  document.getElementById("button-add-asset").addEventListener("click", () => {
    document.getElementById("input-asset-file").click();
  });

  document
    .getElementById("input-asset-file")
    .addEventListener("change", async (event) => {
      const files = Array.from(event.target.files);
      event.target.value = "";
      for (const file of files) {
        await addAssetFromFile(file);
      }
      renderAssetsTab();
      onAssetsChangeCallback();
    });

  renderAssetsTab();
}

async function addAssetFromFile(file, overrideId) {
  const defaultId = file.name
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]/g, "_");
  const assetId = overrideId ?? defaultId;
  try {
    await databasePut({ id: assetId, name: file.name, blob: file });
    registerAsset(assetId, file.name, file);
  } catch (error) {
    console.warn(`[assets] Failed to add asset "${assetId}":`, error);
  }
}

export function renderAssetsTab() {
  if (!assetsTabGrid) return;
  assetsTabGrid.innerHTML = "";

  const entries = Object.entries(state.assetMeta);
  if (entries.length === 0) {
    const emptyMessage = document.createElement("p");
    emptyMessage.className = "placeholder-text";
    emptyMessage.textContent =
      "No assets. Click + Add Texture to import images.";
    assetsTabGrid.appendChild(emptyMessage);
    return;
  }

  for (const [id, meta] of entries) {
    assetsTabGrid.appendChild(buildAssetCard(id, meta));
  }
}

function buildAssetCard(id, meta) {
  const card = document.createElement("div");
  card.className = "asset-card";

  const thumbnail = document.createElement("img");
  thumbnail.src = meta.url;
  thumbnail.className = "asset-card-thumb";
  thumbnail.title = "Click to replace";

  thumbnail.addEventListener("click", () => {
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files[0];
      if (!file) return;
      await addAssetFromFile(file, id);
      renderAssetsTab();
      onAssetsChangeCallback();
    });
    fileInput.click();
  });

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.value = id;
  nameInput.className = "asset-card-name";
  nameInput.title = "Asset ID";

  nameInput.addEventListener("change", async () => {
    const newId = nameInput.value.trim();
    if (!newId || newId === id) {
      nameInput.value = id;
      return;
    }
    await renameAsset(id, newId);
    renderAssetsTab();
    onAssetsChangeCallback();
  });

  const deleteButton = document.createElement("button");
  deleteButton.className = "button-icon button-danger asset-card-delete";
  deleteButton.textContent = "✕";
  deleteButton.addEventListener("click", async () => {
    await databaseDelete(id);
    unregisterAsset(id);
    renderAssetsTab();
    onAssetsChangeCallback();
  });

  card.appendChild(thumbnail);
  card.appendChild(nameInput);
  card.appendChild(deleteButton);
  return card;
}

async function renameAsset(oldId, newId) {
  const records = await databaseGetAll();
  const record = records.find((entry) => entry.id === oldId);
  if (!record) return;
  await databasePut({ ...record, id: newId });
  await databaseDelete(oldId);
  state.assets[newId] = state.assets[oldId];
  state.assetMeta[newId] = { ...state.assetMeta[oldId] };
  delete state.assets[oldId];
  delete state.assetMeta[oldId];
}

// Asset Picker (used by ui-fields.js for "asset" type params)

export function openAssetPicker(anchor, currentId, onSelect) {
  document.querySelector(".asset-picker-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.className = "asset-picker-overlay";

  const panel = document.createElement("div");
  panel.className = "asset-picker-panel";

  const searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.className = "asset-picker-search";
  searchInput.placeholder = "Search…";

  const grid = document.createElement("div");
  grid.className = "asset-picker-grid";

  function renderPickerGrid(filter) {
    grid.innerHTML = "";

    // "None" option
    const noneCard = document.createElement("div");
    noneCard.className =
      "asset-picker-card asset-picker-card--none" +
      (currentId == null ? " selected" : "");
    noneCard.textContent = "none";
    noneCard.addEventListener("click", () => {
      onSelect(null);
      overlay.remove();
    });
    grid.appendChild(noneCard);

    const lowerCaseFilter = filter.toLowerCase();

    for (const [assetId, meta] of Object.entries(state.assetMeta)) {
      if (
        lowerCaseFilter &&
        !assetId.toLowerCase().includes(lowerCaseFilter) &&
        !meta.name.toLowerCase().includes(lowerCaseFilter)
      ) {
        continue;
      }

      const card = document.createElement("div");
      card.className =
        "asset-picker-card" + (assetId === currentId ? " selected" : "");

      const thumbnail = document.createElement("img");
      thumbnail.src = meta.url;
      thumbnail.className = "asset-picker-thumb";

      const label = document.createElement("div");
      label.className = "asset-picker-label";
      label.textContent = assetId;

      card.appendChild(thumbnail);
      card.appendChild(label);
      card.addEventListener("click", () => {
        onSelect(assetId);
        overlay.remove();
      });
      grid.appendChild(card);
    }
  }

  renderPickerGrid("");
  searchInput.addEventListener("input", () =>
    renderPickerGrid(searchInput.value),
  );

  panel.appendChild(searchInput);
  panel.appendChild(grid);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  // Position below anchor
  const anchorRect = anchor.getBoundingClientRect();
  panel.style.position = "fixed";
  panel.style.zIndex = "2000";
  panel.style.top = `${anchorRect.bottom + 4}px`;
  panel.style.left = `${anchorRect.left}px`;

  // Clamp to viewport
  requestAnimationFrame(() => {
    const panelRect = panel.getBoundingClientRect();
    if (panelRect.right > window.innerWidth - 4) {
      panel.style.left = `${window.innerWidth - panelRect.width - 4}px`;
    }
    if (panelRect.bottom > window.innerHeight - 4) {
      panel.style.top = `${anchorRect.top - panelRect.height - 4}px`;
    }
  });

  // Close on outside click
  setTimeout(() => {
    document.addEventListener("mousedown", function closeOnOutsideClick(event) {
      if (!panel.contains(event.target)) {
        overlay.remove();
        document.removeEventListener("mousedown", closeOnOutsideClick);
      }
    });
  }, 0);
}

/**
 * timeline.js
 *
 * Timeline panel: per-emitter command rows, playback controls, command editor.
 *
 * Public API:
 *   setupTimeline({ onTimelineChange })
 *   renderTimeline()
 *   restartTimeline()
 *   startTimeline()
 */

import { state, nextId } from "./state.js";
import { resetAllEmitters, setTimelinePaused, scheduleEmitterCommand } from "./scene.js";
import { makeElement } from "./utils.js";

const MIN_DISPLAY_DURATION = 1; // seconds

// Playback state
let playing = false;
let paused = false;
let autoplay = false;
let elapsed = 0;
let lastTimestamp = null;
let rafId = null;

// Selection
let selectedEmitterId = null;
let selectedCommandId = null;

// Callbacks
let onTimelineChangeCb = () => {};

// --- Public API ---

export function setupTimeline({ onTimelineChange }) {
  onTimelineChangeCb = onTimelineChange ?? (() => {});
  renderTimeline();
  document.getElementById("tl-btn-play").addEventListener("click", startPlayback);
  document.getElementById("tl-btn-pause").addEventListener("click", pausePlayback);
  document.getElementById("tl-btn-stop").addEventListener("click", stopPlayback);

  const autoplayEl = document.getElementById("tl-autoplay");
  autoplayEl.addEventListener("change", () => {
    autoplay = autoplayEl.checked;
  });
}

export function renderTimeline() {
  renderRuler();
  renderRows();
  renderSidebar();
  updatePlayhead();
}

export function restartTimeline() {
  if (playing || paused) {
    startPlayback();
  }
}

export function startTimeline() {
  const hasCommands = state.emitters.some((e) => (e.timeline ?? []).length > 0);
  if (hasCommands) {
    startPlayback();
  }
}

// --- Playback ---

function startPlayback() {
  elapsed = 0;
  paused = false;
  playing = true;
  lastTimestamp = null;

  setTimelinePaused(false);
  resetAllEmitters();

  for (const emitter of state.emitters) {
    for (const cmd of emitter.timeline ?? []) {
      scheduleEmitterCommand(emitter.id, cmd);
    }
  }

  if (rafId) cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(tick);
  updateControlButtons();
  updatePlayhead();
}

function pausePlayback() {
  if (!playing) return;
  if (paused) {
    paused = false;
    lastTimestamp = null;
    setTimelinePaused(false);
    rafId = requestAnimationFrame(tick);
  } else {
    paused = true;
    setTimelinePaused(true);
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
  }
  updateControlButtons();
}

function stopPlayback() {
  playing = false;
  paused = false;
  elapsed = 0;
  setTimelinePaused(true);
  resetAllEmitters();
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  updatePlayhead();
  updateControlButtons();
}

function tick(timestamp) {
  if (!playing || paused) return;

  if (lastTimestamp !== null) {
    elapsed += (timestamp - lastTimestamp) / 1000;
  }
  lastTimestamp = timestamp;

  const info = calcTimelineInfo();
  updatePlayhead(info);

  if (info.length > 0 && elapsed >= info.length && !info.hasInfPlay) {
    if (autoplay) {
      startPlayback();
    } else {
      stopPlayback();
    }
    return;
  }

  rafId = requestAnimationFrame(tick);
}

// --- Helpers ---

function roundDelay(v) {
  return Math.round(v * 100) / 100;
}

// --- Timeline math ---

function calcTimelineInfo() {
  let maxEnd = 0;
  let hasInfPlay = false;

  for (const emitter of state.emitters) {
    const maxLife = getMaxLifetime(emitter);
    for (const cmd of emitter.timeline ?? []) {
      if (cmd.type === "play" && cmd.duration == null) {
        hasInfPlay = true;
      } else if (cmd.type === "play" && cmd.duration != null) {
        maxEnd = Math.max(maxEnd, (cmd.delay ?? 0) + cmd.duration + maxLife);
      } else if (cmd.type === "burst") {
        maxEnd = Math.max(maxEnd, (cmd.delay ?? 0) + maxLife);
      }
    }
  }

  return { length: maxEnd, hasInfPlay };
}

function getDisplayDuration() {
  if (frozenDuration != null) return frozenDuration;
  const { length } = calcTimelineInfo();
  return Math.max(MIN_DISPLAY_DURATION, length);
}

function getMaxLifetime(emitter) {
  for (const module of emitter.spawnModules ?? []) {
    if (module.type === "FXSpawnLifetime") {
      return module.params?.lifetime?.max ?? 1;
    }
  }
  return 1;
}

function calcRulerStep(duration) {
  const niceSteps = [0.25, 0.5, 1, 2, 5, 10, 20, 30, 60];
  const rawStep = duration / 8;
  for (const s of niceSteps) {
    if (s >= rawStep) return s;
  }
  return Math.ceil(rawStep);
}

// --- Rendering ---

function renderRuler() {
  const rulerEl = document.getElementById("tl-ruler");
  if (!rulerEl) return;
  rulerEl.innerHTML = "";

  const dur = getDisplayDuration();
  const step = calcRulerStep(dur);

  for (let t = 0; t <= dur + step * 0.01; t += step) {
    const mark = makeElement("div", "tl-ruler-mark");
    mark.style.left = `${(t / dur) * 100}%`;
    const label = makeElement("span", "tl-ruler-label");
    label.textContent = `${parseFloat(t.toFixed(2))}s`;
    mark.appendChild(label);
    rulerEl.appendChild(mark);
  }
}

function renderRows() {
  const rowsEl = document.getElementById("tl-rows");
  if (!rowsEl) return;
  rowsEl.innerHTML = "";

  const dur = getDisplayDuration();

  for (const emitter of state.emitters) {
    const row = makeElement("div", "tl-row");
    row.dataset.emitterId = emitter.id;

    // Label
    const label = makeElement("div", "tl-row-label");
    const nameSpan = makeElement("span", "tl-row-name");
    nameSpan.textContent = emitter.name;
    label.appendChild(nameSpan);

    const addBtn = makeElement("button", "tl-add-btn");
    addBtn.textContent = "+";
    addBtn.title = "Add command";
    addBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      addCommandToEmitter(emitter.id);
    });
    label.appendChild(addBtn);

    // Track
    const track = makeElement("div", "tl-track");

    for (const cmd of emitter.timeline ?? []) {
      track.appendChild(buildCommandBlock(cmd, emitter, dur));
    }

    row.appendChild(label);
    row.appendChild(track);
    rowsEl.appendChild(row);
  }
}

function buildCommandBlock(cmd, emitter, dur) {
  const emitterId = emitter.id;
  const isSelected = cmd.id === selectedCommandId && emitterId === selectedEmitterId;
  const isInfinite = cmd.type === "play" && cmd.duration == null;

  const classes = [
    "tl-cmd-block",
    `tl-cmd-block--${cmd.type}`,
    isInfinite ? "tl-cmd-block--infinite" : "",
    isSelected ? "tl-cmd-block--selected" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const block = makeElement("div", classes);
  const delay = cmd.delay ?? 0;
  block.style.left = `${(delay / dur) * 100}%`;

  if (cmd.type === "burst") {
    const maxLife = getMaxLifetime(emitter);
    const lifePct = (maxLife / dur) * 100;
    block.style.minWidth = "8px";
    block.style.width = `${lifePct}%`;
  } else if (isInfinite) {
    block.style.right = "0";
  } else {
    block.style.width = `${((cmd.duration ?? 1) / dur) * 100}%`;
  }

  block.addEventListener("mousedown", (e) => startDrag(e, block, cmd, emitterId));

  return block;
}

// --- Drag-and-drop ---

let dragState = null;
let frozenDuration = null;

function startDrag(e, block, cmd, emitterId) {
  e.preventDefault();

  // Freeze the display duration so the scale stays constant while dragging
  frozenDuration = getDisplayDuration();

  dragState = {
    cmd,
    emitterId,
    startX: e.clientX,
    startDelay: cmd.delay ?? 0,
    moved: false,
  };
  block.classList.add("tl-cmd-block--dragging");

  const onMouseMove = (e) => {
    if (!dragState) return;

    const track = getTrackForEmitter(dragState.emitterId);
    if (!track) return;

    const trackRect = track.getBoundingClientRect();
    const deltaTime = ((e.clientX - dragState.startX) / trackRect.width) * frozenDuration;

    if (Math.abs(e.clientX - dragState.startX) > 3) dragState.moved = true;

    dragState.cmd.delay = roundDelay(Math.max(0, dragState.startDelay + deltaTime));

    // Check if hovering a different emitter row
    const targetEmitterId = getEmitterIdAtY(e.clientY);
    if (targetEmitterId && targetEmitterId !== dragState.emitterId) {
      moveCommandToEmitter(dragState.cmd, dragState.emitterId, targetEmitterId);
      dragState.emitterId = targetEmitterId;
      dragState.startX = e.clientX;
      dragState.startDelay = dragState.cmd.delay;
    }

    renderRows();
    updatePlayhead();
  };

  const onMouseUp = () => {
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);

    if (!dragState) return;

    const wasMoved = dragState.moved;
    const finalEmitterId = dragState.emitterId;
    dragState = null;
    frozenDuration = null;

    if (wasMoved) {
      // Recalculate ruler + rows with the new actual duration
      renderRuler();
      renderRows();
      renderSidebar();
      onTimelineChangeCb();
    } else {
      // Treat as click → select
      selectedEmitterId = finalEmitterId;
      selectedCommandId = cmd.id;
      renderRows();
      renderSidebar();
    }
  };

  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
}

function getTrackForEmitter(emitterId) {
  return document.querySelector(`.tl-row[data-emitter-id="${emitterId}"] .tl-track`);
}

function getEmitterIdAtY(clientY) {
  for (const row of document.querySelectorAll(".tl-row")) {
    const rect = row.getBoundingClientRect();
    if (clientY >= rect.top && clientY <= rect.bottom) {
      return row.dataset.emitterId ?? null;
    }
  }
  return null;
}

function moveCommandToEmitter(cmd, fromId, toId) {
  const from = state.emitters.find((e) => e.id === fromId);
  const to = state.emitters.find((e) => e.id === toId);
  if (!from || !to) return;

  const fromTimeline = from.timeline ?? [];
  const idx = fromTimeline.findIndex((c) => c.id === cmd.id);
  if (idx === -1) return;

  fromTimeline.splice(idx, 1);
  from.timeline = fromTimeline;

  to.timeline = to.timeline ?? [];
  to.timeline.push(cmd);

  if (selectedEmitterId === fromId && selectedCommandId === cmd.id) {
    selectedEmitterId = toId;
  }
}

function renderSidebar() {
  const panel = document.getElementById("tl-cmd-panel");
  if (!panel) return;
  panel.innerHTML = "";

  let selectedCmd = null;
  let selectedEmitter = null;

  if (selectedEmitterId && selectedCommandId) {
    selectedEmitter = state.emitters.find((e) => e.id === selectedEmitterId);
    selectedCmd = selectedEmitter?.timeline?.find((c) => c.id === selectedCommandId);
  }

  if (selectedCmd && selectedEmitter) {
    renderCommandEditor(panel, selectedEmitter, selectedCmd);
  } else {
    const hint = makeElement("p", "tl-hint");
    hint.textContent = "Click a command to edit";
    panel.appendChild(hint);
  }
}

function renderCommandEditor(panel, emitter, cmd) {
  // Type selector
  const typeRow = makeElement("div", "tl-field-row");
  const typeLabel = makeElement("label", "tl-field-label");
  typeLabel.textContent = "Type";
  const typeSelect = makeElement("select", "param-select tl-field-select");
  for (const t of ["play", "burst"]) {
    const opt = makeElement("option");
    opt.value = t;
    opt.textContent = t;
    if (t === cmd.type) opt.selected = true;
    typeSelect.appendChild(opt);
  }
  typeSelect.addEventListener("change", () => {
    cmd.type = typeSelect.value;
    if (cmd.type === "burst") {
      cmd.count = cmd.count ?? 10;
      delete cmd.rate;
      delete cmd.duration;
    } else {
      cmd.rate = cmd.rate ?? 10;
      delete cmd.count;
    }
    renderRows();
    renderRuler();
    renderSidebar();
    onTimelineChangeCb();
  });
  typeRow.appendChild(typeLabel);
  typeRow.appendChild(typeSelect);
  panel.appendChild(typeRow);

  // Delay
  appendNumField(panel, "Delay", roundDelay(cmd.delay ?? 0), 0, 0.01, (v) => {
    cmd.delay = roundDelay(v);
    renderRows();
    renderRuler();
    onTimelineChangeCb();
  });

  if (cmd.type === "play") {
    // Rate
    appendNumField(panel, "Rate", cmd.rate ?? 10, 0, 1, (v) => {
      cmd.rate = v;
      onTimelineChangeCb();
    });

    // Duration (empty = infinite)
    const durRow = makeElement("div", "tl-field-row");
    const durLabel = makeElement("label", "tl-field-label");
    durLabel.textContent = "Duration";
    const durInput = makeElement("input", "param-input tl-field-input");
    durInput.type = "number";
    durInput.min = "0";
    durInput.step = "0.1";
    durInput.placeholder = "∞";
    durInput.value = cmd.duration != null ? cmd.duration : "";
    durInput.addEventListener("change", () => {
      const raw = durInput.value.trim();
      const v = raw === "" ? null : parseFloat(raw);
      cmd.duration = v != null && isFinite(v) && v > 0 ? v : null;
      renderRows();
      renderRuler();
      onTimelineChangeCb();
    });
    durRow.appendChild(durLabel);
    durRow.appendChild(durInput);
    panel.appendChild(durRow);
  } else {
    // Count
    appendNumField(panel, "Count", cmd.count ?? 10, 1, 1, (v) => {
      cmd.count = Math.max(1, Math.round(v));
      onTimelineChangeCb();
    });
  }

  // Delete
  const deleteBtn = makeElement("button", "tl-delete-btn button-danger-plain");
  deleteBtn.textContent = "✕ Remove";
  deleteBtn.addEventListener("click", () => {
    const timeline = emitter.timeline ?? [];
    const idx = timeline.findIndex((c) => c.id === cmd.id);
    if (idx !== -1) timeline.splice(idx, 1);
    selectedCommandId = null;
    selectedEmitterId = null;
    renderRows();
    renderRuler();
    renderSidebar();
    onTimelineChangeCb();
  });
  panel.appendChild(deleteBtn);
}

function appendNumField(parent, labelText, value, min, step, onChange) {
  const row = makeElement("div", "tl-field-row");
  const label = makeElement("label", "tl-field-label");
  label.textContent = labelText;
  const input = makeElement("input", "param-input tl-field-input");
  input.type = "number";
  input.min = String(min);
  input.step = String(step);
  input.value = String(value);
  input.addEventListener("change", () => {
    const v = parseFloat(input.value);
    if (!isNaN(v)) onChange(v);
  });
  row.appendChild(label);
  row.appendChild(input);
  parent.appendChild(row);
}

function addCommandToEmitter(emitterId) {
  const emitter = state.emitters.find((e) => e.id === emitterId);
  if (!emitter) return;

  const cmd = { id: nextId(), type: "play", rate: 10, delay: 0 };
  emitter.timeline = emitter.timeline ?? [];
  emitter.timeline.push(cmd);

  selectedEmitterId = emitterId;
  selectedCommandId = cmd.id;

  renderRows();
  renderRuler();
  renderSidebar();
  onTimelineChangeCb();
}

// --- Playhead ---

function updatePlayhead(info) {
  const playheadEl = document.getElementById("tl-playhead");
  if (!playheadEl) return;

  if (!info) info = calcTimelineInfo();

  const hasCommands = info.length > 0 || info.hasInfPlay;

  if (!playing || !hasCommands) {
    playheadEl.style.display = "none";
    return;
  }

  const dur = getDisplayDuration();
  const fraction = Math.min(1, elapsed / dur);
  playheadEl.style.display = "block";
  playheadEl.style.setProperty("--tl-ph-pos", fraction.toString());
}

// --- Button state ---

function updateControlButtons() {
  const playBtn = document.getElementById("tl-btn-play");
  const pauseBtn = document.getElementById("tl-btn-pause");
  const stopBtn = document.getElementById("tl-btn-stop");

  if (playBtn) playBtn.disabled = playing && !paused;
  if (pauseBtn) {
    pauseBtn.disabled = !playing;
    pauseBtn.textContent = paused ? "▶ Resume" : "⏸ Pause";
  }
  if (stopBtn) stopBtn.disabled = !playing;
}

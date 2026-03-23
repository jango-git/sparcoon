/**
 * curve-editor.js
 *
 * Reusable canvas-based curve editor for FXCurve1DConfig<FXRange>.
 *
 * Each anchor: { position: 0..1, center: number, spread: number }
 * - First point is locked at position 0, last at position 1
 * - center = midpoint value, spread = ± half-width of the range band
 *
 * Exports:
 *   createCurveEditor(points, getMagnitude, onPointsChange, onSelect) → { canvas, redraw }
 *   sortCurvePoints(points) — sort middle points by position, keep first/last locked
 */

const W = 240;
const H = 100;
const PAD = 12;
const HIT_R = 7;

const C_BG = "#1a1a1a";
const C_GRID = "rgba(255,255,255,0.05)";
const C_SPREAD = "rgba(77,159,255,0.13)";
const C_LINE = "#4d9fff";
const C_POINT = "#4d9fff";
const C_POINT_LOCKED = "#666666";
const C_POINT_SELECTED = "#ffffff";

function toX(position) {
  return PAD + position * (W - PAD * 2);
}

function toY(center, magnitude) {
  return PAD + (1 - center / magnitude) * (H - PAD * 2);
}

function fromX(px) {
  return Math.max(0, Math.min(1, (px - PAD) / (W - PAD * 2)));
}

function fromY(py, magnitude) {
  return Math.max(0, magnitude * (1 - (py - PAD) / (H - PAD * 2)));
}

function hitTest(mx, my, points, magnitude) {
  for (let i = 0; i < points.length; i++) {
    const dx = mx - toX(points[i].position);
    const dy = my - toY(points[i].center, magnitude);
    if (dx * dx + dy * dy <= HIT_R * HIT_R) return i;
  }
  return -1;
}

export function sortCurvePoints(points) {
  if (points.length <= 2) return;
  const middle = points.slice(1, -1).sort((a, b) => a.position - b.position);
  points.splice(1, middle.length, ...middle);
}

function draw(canvas, ctx, points, magnitude, hoveredIndex, selectedPoint) {
  ctx.clearRect(0, 0, W, H);

  ctx.fillStyle = C_BG;
  ctx.fillRect(0, 0, W, H);

  // Grid
  ctx.strokeStyle = C_GRID;
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const x = PAD + (i / 4) * (W - PAD * 2);
    ctx.beginPath();
    ctx.moveTo(x, PAD);
    ctx.lineTo(x, H - PAD);
    ctx.stroke();
    const y = PAD + (i / 4) * (H - PAD * 2);
    ctx.beginPath();
    ctx.moveTo(PAD, y);
    ctx.lineTo(W - PAD, y);
    ctx.stroke();
  }

  if (points.length < 2) return;

  // Spread band
  ctx.beginPath();
  for (let i = 0; i < points.length; i++) {
    const x = toX(points[i].position);
    const y = toY(points[i].center + points[i].spread, magnitude);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  for (let i = points.length - 1; i >= 0; i--) {
    const x = toX(points[i].position);
    const y = toY(Math.max(0, points[i].center - points[i].spread), magnitude);
    ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = C_SPREAD;
  ctx.fill();

  // Center line
  ctx.beginPath();
  for (let i = 0; i < points.length; i++) {
    const x = toX(points[i].position);
    const y = toY(points[i].center, magnitude);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.strokeStyle = C_LINE;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Points
  for (let i = 0; i < points.length; i++) {
    const x = toX(points[i].position);
    const y = toY(points[i].center, magnitude);
    const locked = i === 0 || i === points.length - 1;
    const selected = points[i] === selectedPoint;
    const hovered = i === hoveredIndex;

    const radius = selected || hovered ? 5 : 4;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);

    if (selected) {
      ctx.fillStyle = C_POINT_SELECTED;
    } else if (locked) {
      ctx.fillStyle = C_POINT_LOCKED;
    } else {
      ctx.fillStyle = C_POINT;
    }
    ctx.fill();

    if (selected) {
      ctx.strokeStyle = C_LINE;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else if (hovered) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}

export function createCurveEditor(points, getMagnitude, onPointsChange, onSelect) {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  canvas.className = "curve-canvas";
  canvas.style.cursor = "crosshair";
  const ctx = canvas.getContext("2d");

  let dragPoint = null;
  let hoveredIndex = -1;
  let selectedPoint = null;

  const redraw = () => draw(canvas, ctx, points, getMagnitude(), hoveredIndex, selectedPoint);
  redraw();

  function coords(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      mx: (e.clientX - rect.left) * (W / rect.width),
      my: (e.clientY - rect.top) * (H / rect.height),
    };
  }

  canvas.addEventListener("mousemove", (e) => {
    const { mx, my } = coords(e);
    const magnitude = getMagnitude();

    if (dragPoint !== null) {
      const index = points.indexOf(dragPoint);
      const locked = index === 0 || index === points.length - 1;

      if (!locked) {
        dragPoint.position = fromX(mx);
        sortCurvePoints(points);
      }
      dragPoint.center = fromY(my, magnitude);

      hoveredIndex = points.indexOf(dragPoint);
      onPointsChange();
    } else {
      const hit = hitTest(mx, my, points, magnitude);
      if (hit !== hoveredIndex) {
        hoveredIndex = hit;
        canvas.style.cursor = hit !== -1 ? "grab" : "crosshair";
      }
    }

    redraw();
  });

  canvas.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const { mx, my } = coords(e);
    const magnitude = getMagnitude();

    const hit = hitTest(mx, my, points, magnitude);
    if (hit !== -1) {
      dragPoint = points[hit];
      canvas.style.cursor = "grabbing";
      if (selectedPoint !== points[hit]) {
        selectedPoint = points[hit];
        onSelect(selectedPoint);
      }
    } else {
      // Insert new point before the last locked point
      const newPoint = { position: fromX(mx), center: fromY(my, magnitude), spread: 0 };
      points.splice(points.length - 1, 0, newPoint);
      sortCurvePoints(points);
      dragPoint = newPoint;
      selectedPoint = newPoint;
      hoveredIndex = points.indexOf(newPoint);
      onSelect(selectedPoint);
      onPointsChange();
    }

    redraw();
  });

  canvas.addEventListener("mouseup", () => {
    if (dragPoint !== null) {
      dragPoint = null;
      canvas.style.cursor = hoveredIndex !== -1 ? "grab" : "crosshair";
    }
  });

  canvas.addEventListener("mouseleave", () => {
    dragPoint = null;
    hoveredIndex = -1;
    canvas.style.cursor = "crosshair";
    redraw();
  });

  // Right-click removes selected non-locked point
  canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const { mx, my } = coords(e);
    const hit = hitTest(mx, my, points, getMagnitude());
    if (hit > 0 && hit < points.length - 1) {
      const wasSelected = points[hit] === selectedPoint;
      points.splice(hit, 1);
      hoveredIndex = -1;
      if (wasSelected) {
        selectedPoint = null;
        onSelect(null);
      }
      onPointsChange();
      redraw();
    }
  });

  return { canvas, redraw };
}

/**
 * scene.js
 *
 * Three.js preview scene: WebGL renderer, camera, OrbitControls,
 * ground plane, directional light, hemisphere light.
 * Manages FXEmitter lifecycle.
 */

import * as THREE from "https://esm.sh/three@0.157";
import { OrbitControls } from "https://esm.sh/three@0.157/examples/jsm/controls/OrbitControls.js";
import { FXEmitter } from "https://esm.sh/sparcoon@0.4.5?deps=three@0.157,fast-simplex-noise@4,ferrsign@0.0.4";
import { buildEmitter } from "./registry.js";

let renderer, scene, camera, controls, clock;
let directionalLight, hemisphereLight, humanReference, groundPlane, groundGrid;
let customBackgroundColor = new THREE.Color(0x9abfd4);

const emitterMap = new Map(); // emitter state id → FXEmitter instance

let timelinePaused = false;

export function setTimelinePaused(v) {
  timelinePaused = v;
}

export function resetAllEmitters() {
  for (const e of emitterMap.values()) {
    try { e.reset(); } catch (_) {}
  }
}

export function scheduleEmitterCommand(emitterId, cmd) {
  const emitter = emitterMap.get(emitterId);
  if (!emitter) return;
  if (cmd.type === 'play') {
    const opts = {};
    if (cmd.delay != null && cmd.delay !== 0) opts.delay = cmd.delay;
    if (cmd.duration != null) opts.duration = cmd.duration;
    emitter.play(cmd.rate ?? 10, Object.keys(opts).length > 0 ? opts : undefined);
  } else if (cmd.type === 'burst') {
    const opts = {};
    if (cmd.delay != null && cmd.delay !== 0) opts.delay = cmd.delay;
    emitter.burst(cmd.count ?? 10, Object.keys(opts).length > 0 ? opts : undefined);
  }
}

const SKY_COLOR = new THREE.Color(0x9abfd4);
const BLACK_COLOR = new THREE.Color(0x111111);

const SUN_DISTANCE = 15;

// Scene options (toggled by viewport buttons)

export const sceneOptions = {
  sun: true,
  hemisphere: true,
  background: true,
  human: true,
};

export function toggleSun() {
  sceneOptions.sun = !sceneOptions.sun;
  directionalLight.visible = sceneOptions.sun;
  return sceneOptions.sun;
}

export function toggleHemisphere() {
  sceneOptions.hemisphere = !sceneOptions.hemisphere;
  hemisphereLight.visible = sceneOptions.hemisphere;
  return sceneOptions.hemisphere;
}

export function toggleBackground() {
  sceneOptions.background = !sceneOptions.background;
  scene.background = sceneOptions.background ? customBackgroundColor.clone() : BLACK_COLOR;
  return sceneOptions.background;
}

export function setBackgroundColor(hex) {
  customBackgroundColor = new THREE.Color(hex);
  if (sceneOptions.background) {
    scene.background = customBackgroundColor.clone();
  }
}

export function togglePlane() {
  const visible = !groundPlane.visible;
  groundPlane.visible = visible;
  groundGrid.visible = visible;
  return visible;
}

export function toggleHuman() {
  sceneOptions.human = !sceneOptions.human;
  humanReference.visible = sceneOptions.human;
  return sceneOptions.human;
}

// Initialization

export function initScene(canvas) {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  scene = new THREE.Scene();
  scene.background = SKY_COLOR.clone();

  camera = new THREE.PerspectiveCamera(60, 1, 0.1, 200);
  camera.position.set(0, 3, 8);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 1, 0);

  // Ground plane
  groundPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(30, 30),
    new THREE.MeshStandardMaterial({ color: 0xc8bfb0, roughness: 0.9 }),
  );
  groundPlane.rotation.x = -Math.PI / 2;
  groundPlane.receiveShadow = true;
  scene.add(groundPlane);

  // Grid
  groundGrid = new THREE.GridHelper(30, 30, 0xa09080, 0xb0a898);
  groundGrid.position.y = 0.01;
  scene.add(groundGrid);

  // Human reference box (1×2×1, wireframe)
  humanReference = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(0.5, 2, 0.8)),
    new THREE.LineBasicMaterial({
      color: 0xffffff,
      opacity: 0.25,
      transparent: true,
    }),
  );
  humanReference.position.set(1.2, 1, 0);
  scene.add(humanReference);

  // Hemisphere light (sky / ground fill)
  hemisphereLight = new THREE.HemisphereLight(0xb8d8f0, 0x6a5030, 0.9);
  scene.add(hemisphereLight);

  // Directional light (sun)
  directionalLight = new THREE.DirectionalLight(0xfffbe8, 1.4);
  directionalLight.position.set(5, 10, 5);
  directionalLight.castShadow = true;
  directionalLight.shadow.mapSize.set(1024, 1024);
  directionalLight.shadow.camera.near = 0.5;
  directionalLight.shadow.camera.far = 40;
  directionalLight.shadow.camera.left = -15;
  directionalLight.shadow.camera.right = 15;
  directionalLight.shadow.camera.top = 15;
  directionalLight.shadow.camera.bottom = -15;
  scene.add(directionalLight);

  clock = new THREE.Clock();

  handleResize(canvas);
  window.addEventListener("resize", () => handleResize(canvas));

  requestAnimationFrame(animate);
}

function handleResize(canvas) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width === 0 || height === 0) return;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function animate() {
  requestAnimationFrame(animate);
  const deltaTime = clock.getDelta();
  controls.update();
  FXEmitter.onWillRender(timelinePaused ? 0 : deltaTime);
  renderer.render(scene, camera);
}

// Reset

export function resetScene() {
  camera.position.set(0, 3, 8);
  controls.target.set(0, 1, 0);
  controls.update();

  sceneOptions.sun = true;
  sceneOptions.hemisphere = true;
  sceneOptions.background = true;
  sceneOptions.human = true;

  customBackgroundColor = new THREE.Color(0x9abfd4);
  directionalLight.visible = true;
  hemisphereLight.visible = true;
  scene.background = customBackgroundColor.clone();
  humanReference.visible = true;
  groundPlane.visible = true;
  groundGrid.visible = true;
}

// Sun angle

export function setSunAngle(elevationDegrees, azimuthDegrees) {
  const elevationRadians = (elevationDegrees * Math.PI) / 180;
  const azimuthRadians = (azimuthDegrees * Math.PI) / 180;
  directionalLight.position.set(
    SUN_DISTANCE * Math.cos(elevationRadians) * Math.sin(azimuthRadians),
    SUN_DISTANCE * Math.sin(elevationRadians),
    SUN_DISTANCE * Math.cos(elevationRadians) * Math.cos(azimuthRadians),
  );
}

// Emitter sync - rebuild all emitters from state

export function syncEmitters(emittersState, assets = {}) {
  // Phase 1: destroy ALL old emitters first.
  // This prevents shared GPU resource invalidation (shaders, uniforms)
  // that can occur when destroying one emitter while another still renders.
  for (const [emitterId, emitter] of emitterMap) {
    scene.remove(emitter);
    try {
      emitter.destroy();
    } catch (_) {
      /* ignore */
    }
  }
  emitterMap.clear();

  // Phase 2: build all emitters from current state
  for (const emitterState of emittersState) {
    try {
      const emitter = buildEmitter(emitterState, assets, camera);
      scene.add(emitter);
      emitterMap.set(emitterState.id, emitter);
    } catch (error) {
      console.error(`[scene] Failed to build emitter "${emitterState.id}":`, error);
    }
  }
}

import { Group, PCFShadowMap, PerspectiveCamera, REVISION, Vector2, WebGLRenderer } from "three";
import { FX_RUNTIME_VERSION, FXWorld } from "sparcoon";

import "./style.css";
import { EXAMPLES } from "./catalog";
import { DepthPass } from "./depthPass";
import { GpuTimer } from "./gpuTimer";
import { EffectList } from "./effectList";
import { Media } from "./media";
import { Showcase } from "./showcase";
import { Studio } from "./studio";
import { ViewRig } from "./viewRig";

const canvas = document.querySelector<HTMLCanvasElement>("#stage")!;

const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFShadowMap;
// Drawn once a frame, in the ground's pass, and used by the effects' pass after it.
renderer.shadowMap.autoUpdate = false;
renderer.debug.checkShaderErrors = false;
const timer = new GpuTimer(renderer);

const camera = new PerspectiveCamera(45, 1, 0.1, 200);
const studio = new Studio();
const effects = new Group();
studio.scene.add(effects);
const depthPass = new DepthPass(camera);
const rig = new ViewRig(camera, canvas);

function frameShown(): void {
  const shown = showcase.shown;
  if (shown !== undefined) {
    studio.setGround(shown.example.ground, rig.frame(shown.example.view, shown.effect.position));
  }
}

const showcase = new Showcase(
  new Media(`${import.meta.env.BASE_URL}media/`),
  { renderer, camera, scene: studio.scene, effects },
  frameShown,
);

const list = new EffectList(document.querySelector("#effects")!, EXAMPLES);
const tier = renderer.capabilities.isWebGL2 ? "WebGL2" : "WebGL1";
document.querySelector("#status")!.textContent =
  `sparcoon ${FX_RUNTIME_VERSION} - three r${REVISION} - ${tier}`;

function openHash(): void {
  const example = EXAMPLES.find(({ id }) => id === location.hash.slice(1)) ?? EXAMPLES[0]!;
  list.mark(example.id);
  document.title = `${example.title} - Sparcoon examples`;
  void showcase.open(example);
}
window.addEventListener("hashchange", openHash);
openHash();

const drawingBuffer = new Vector2();
let width = 0;
new ResizeObserver(() => {
  const { clientWidth, clientHeight } = canvas;
  renderer.setSize(clientWidth, clientHeight, false);
  camera.aspect = clientWidth / clientHeight;
  camera.updateProjectionMatrix();
  renderer.getDrawingBufferSize(drawingBuffer);
  depthPass.setSize(drawingBuffer.x, drawingBuffer.y);
  // A phone's address bar changes only the height. Reframing then would undo the visitor's orbit.
  if (clientWidth !== width) {
    width = clientWidth;
    frameShown();
  }
}).observe(canvas);

const fps = document.querySelector("#fps")!;
// Frames counted over each half second, shown as frames per second, with each pass's GPU time
// where the browser can measure it.
const FPS_WINDOW_MS = 500;
const PASSES = ["simulation", "depth", "scene", "effects"];
let fpsWindowStart: number | undefined;
let fpsFrames = 0;

function countFrame(now: number): void {
  if (fpsWindowStart === undefined || now - fpsWindowStart > 4 * FPS_WINDOW_MS) {
    fpsWindowStart = now;
    fpsFrames = 0;
    return;
  }
  fpsFrames += 1;
  const elapsed = now - fpsWindowStart;
  if (elapsed >= FPS_WINDOW_MS) {
    const times = timer.take();
    const passes = PASSES.filter((pass) => times.has(pass)).map(
      (pass) => `${pass} ${times.get(pass)!.toFixed(1)} ms`,
    );
    fps.textContent = [
      `${Math.round((fpsFrames * 1000) / elapsed).toString()} FPS`,
      ...passes,
    ].join("\n");
    fpsWindowStart = now;
    fpsFrames = 0;
  }
}

let previous: number | undefined;
renderer.setAnimationLoop((now: number) => {
  // A tab in the background stops the loop. Its first frame back is not a long step.
  const deltaSeconds = previous === undefined ? 0 : Math.min((now - previous) / 1000, 0.1);
  previous = now;
  countFrame(now);

  const moved = showcase.advance(deltaSeconds);
  if (moved !== undefined) {
    rig.follow(moved);
  }
  rig.update();
  timer.collect();
  timer.measure("simulation", () => FXWorld.update(deltaSeconds));
  if (showcase.shown?.example.depth === true) {
    timer.measure("depth", () => depthPass.render(renderer, studio.scene, camera, effects));
  }
  renderPasses();
});

/** The layers the scene's pass and the effects' pass draw. Every object keeps layer 0 too, which the
 *  sun's shadow camera and the depth pass see. Lights are on both, to light both. */
const SCENE_LAYER = 1;
const EFFECT_LAYER = 2;

/** The scene with the shadows of all, then the effects over it, each timed on its own. */
function renderPasses(): void {
  for (const child of studio.scene.children) {
    if (child !== effects) {
      child.traverse((object) => {
        object.layers.enable(SCENE_LAYER);
        if ("isLight" in object) {
          object.layers.enable(EFFECT_LAYER);
        }
      });
    }
  }
  effects.traverse((object) => object.layers.enable(EFFECT_LAYER));

  renderer.shadowMap.needsUpdate = true;
  camera.layers.set(SCENE_LAYER);
  timer.measure("scene", () => renderer.render(studio.scene, camera));
  // Three clears for a colour background even with autoClear off, so the effects' pass has none.
  const background = studio.scene.background;
  studio.scene.background = null;
  camera.layers.set(EFFECT_LAYER);
  renderer.autoClear = false;
  timer.measure("effects", () => renderer.render(studio.scene, camera));
  renderer.autoClear = true;
  studio.scene.background = background;
  camera.layers.set(0);
}

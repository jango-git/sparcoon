# Sparcoon

Three.js runtime for VFX authored in the Sparcoon Editor.

`sparcoon` plays back particle effects designed in the Sparcoon Editor: the
editor compiles a node graph into a plain ES module of precompiled artifacts,
and this thin runtime loads and runs it -- instanced-particle rendering in one
draw call plus a small timeline player. No graph, compiler, or live protocol
ships to your app.

> Editor: link coming soon.

## Features

- Instanced billboard and 3D-mesh particles in a single draw call.
- Per-particle simulation from a precompiled kernel, on the CPU or -- on a
  WebGL2 renderer -- the GPU (transform feedback); no `eval`, no codegen either way.
- Whole-project playback: an editor module subclasses `FXEffect`.
- One `FXWorld.update` per frame drives every effect.
- Optional depth sorting, shadows, and custom-geometry particles.
- Tree-shakeable ESM with full TypeScript types.

## Install

```sh
npm install sparcoon three
```

`three` (>= 0.157) is a peer dependency.

## Quick start

An editor project exports an `FXEffect` subclass plus a typed map of the
textures it needs. Construct it (it joins the default world automatically), add
it to your scene, and call `FXWorld.update(deltaTime)` once per frame.

```ts
import { TextureLoader } from "three";
import { FXWorld } from "sparcoon";
import { VFXDemo0 } from "./effects/VFXDemo_0"; // emitted by the editor

const loader = new TextureLoader();
const assets = {
  heart: loader.load("heart.png"),
  fire: loader.load("fire.png"),
};
const effect = new VFXDemo0(assets);

scene.add(effect); // FXEffect is a THREE.Group
effect.play();

function frame(deltaTime: number): void {
  FXWorld.update(deltaTime); // advances every effect's timeline and its particles
  renderer.render(scene, camera);
}
```

The effect is an `Object3D` -- position, rotate, and scale it like any other.
Call `effect.dispose()` to remove it, free its GPU resources, and unsubscribe it
from the world.

### Live parameters

Channels the editor marked "live" are driven from your code, not the timeline:

```ts
effect.setEmitterParam("Hearts", "spawnRate", 64);
effect.setMeshParam("Mesh", "glow", [1, 0.4, 0.1]);

effect.getEmitter("Hearts"); // the underlying emitter (Object3D)
effect.getMesh("Mesh"); // the underlying THREE.Mesh
```

### Many effects, and separate worlds

Every effect joins the default world on construction, so any number of them are
driven by the same single `FXWorld.update(deltaTime)` -- there is nothing extra
to wire up per effect.

A world is a tick and clock domain (not a scene graph). Create your own
`FXWorld` when you want an independent clock -- an isolated time scale, or a
group you pause on its own -- and pass it to the effect:

```ts
import { FXWorld } from "sparcoon";

const slowmo = new FXWorld();
const boss = new VFXDemo0(assets, { world: slowmo });
scene.add(boss); // still added to your scene yourself

function frame(deltaTime: number): void {
  FXWorld.update(deltaTime); // the default world
  slowmo.update(deltaTime * 0.3); // its own, slower clock
  renderer.render(scene, camera);
}
```

Within one world every effect shares the clock and one delta per frame, so
`effect.stop()` clears rather than freezes -- to freeze one effect on its own,
give it its own world. `world.dispose()` disposes every effect in it.

## How it works

The **Sparcoon Editor** compiles a node graph into a plain ES module exporting
a render artifact (GLSL, uniforms, textures) and a behavior artifact (authored
spawn/update functions), plus -- when the graph opts into GPU simulation -- a
fused WebGL2 transform-feedback kernel. This runtime executes them: your bundler
compiles the authored functions like any other source and the behavior runs on
the CPU, or, when you pass a WebGL2 `renderer` in the effect options, the
precompiled kernel runs the simulation on the GPU instead (falling back to the
CPU behavior if GPU setup fails). Nothing is evaluated at runtime either way.
The editor/runtime boundary is a frozen ABI: two core per-particle buffers,
`position` and `lifecycle` (`[age, lifetime, id]`).

## Requirements

- **A bundler** (Vite, webpack, Rollup, esbuild). `sparcoon` ships as
  unbundled, unminified ES2020 modules plus types; your bundler tree-shakes and
  minifies them, the same way three.js is consumed. Not a drop-in `<script>`.
- **`three` >= 0.157**, as a peer dependency.
- **Old devices.** Output targets ES2020; to run on pre-2015 hardware (for
  example a first-generation iPad Pro), downlevel it in your own build
  (Babel / SWC / your bundler's `target`). `sparcoon` leaves that final step
  to you.

## API overview

- `FXEffect` -- whole-project timeline player (a `Group`); emitted modules
  subclass it. `play` / `stop`, `setEmitterParam` / `setMeshParam`,
  `getEmitter` / `getMesh`, `dispose`.
- `FXWorld` -- the tick domain. `FXWorld.update(deltaTime)` per frame drives the
  default world; `new FXWorld()` is an isolated clock and pool.
- Artifact contract types, the `FX_*` core-layout constants, CPU math helpers
  (`fxMix`, `fxNoise3`, ...), and `fxDataTexture`.

## License

MIT (c) jango

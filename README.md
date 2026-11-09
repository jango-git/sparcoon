# <img src="https://raw.githubusercontent.com/jango-git/sparcoon/main/assets/logo.svg" width="30" height="30" alt="" align="top" /> Sparcoon

A three.js runtime that plays visual effects authored in the
[Sparcoon Editor](https://github.com/jango-git/sparcoon-editor). The editor compiles a node graph
into a plain ES module of precompiled artifacts, and this package executes them: instanced particle
rendering in one draw call plus a small timeline player. No graph, no compiler and no `eval` in your
build.

**[Open the editor](https://jango-git.github.io/sparcoon-editor/)** -
[Editor source](https://github.com/jango-git/sparcoon-editor) -
[npm](https://www.npmjs.com/package/sparcoon/v/0.12.0)

> **0.x.** The artifact format is not frozen yet - a minor release may still break it, so play an
> effect with the runtime version the editor that exported it names.

## Who this is for

Someone sent you a `.ts` file exported from the editor and you need to play it in your three.js
scene. This package is everything you have to add for that.

What is worth knowing before you install:

- **No code generation.** The exported module is ready GLSL plus ordinary JavaScript functions that
  your bundler compiles like any other source. Neither `eval` nor `new Function` is called anywhere,
  so the effect passes where runtime code generation is forbidden by policy.
- **No dependencies.** The only peer dependency is `three`.
- **One draw call per emitter.** Billboards and mesh particles are drawn instanced.
- **Two GLSL tiers in every artifact.** Standard (WebGL2) and Baseline (WebGL1-compatible); the
  runtime picks by the capabilities of the renderer you pass in.
- **Optional GPU simulation** through transform feedback, with an automatic fallback to the
  JavaScript kernel.
- **Tree-shakeable ESM with full types**, unbundled and unminified: your bundler processes the
  package like any other source, exactly the way three.js is consumed.

## Install

```sh
npm install sparcoon three
```

`three` is a peer dependency; the supported range is `>=0.157 <0.180`.

## Quick start

A module from the editor exports a named `FXEffect` subclass and a typed interface for its assets.
The runtime does not load assets: you prepare the textures and geometries and pass them to the
constructor.

```ts
import { TextureLoader } from "three";
import { FXWorld } from "sparcoon";
import { MyEffect, type MyEffectAssets } from "./effects/MyEffect"; // emitted by the editor

const loader = new TextureLoader();
const assets: MyEffectAssets = {
  spark: loader.load("spark.png"),
};

// renderer picks the artifact tier (WebGL2 -> Standard) and enables GPU simulation.
// camera is needed by emitters that were given a sort interval in the editor.
const effect = new MyEffect(assets, { renderer, camera });

scene.add(effect); // FXEffect is a THREE.Group
effect.play();

function frame(deltaSeconds: number): void {
  FXWorld.update(deltaSeconds); // advances the timeline and particles of every effect
  renderer.render(scene, camera);
}
```

Straight after the constructor the effect sits on frame zero, in the state the artist authored.
`play()` restarts the timeline from the top; `stop()` halts playback, clears live particles and
returns the effect to frame zero. The timeline loops, and seamlessly: particles still alive at the
end of a lap finish their lives in the next one.

An effect authored to play once - or played with `effect.play({ loop: false })` - instead holds its
last frame at the end and dispatches `"finished"`. What is alive keeps flying out its lifetime, so
hide or dispose the effect once that is done:

```ts
effect.addEventListener("finished", () => setTimeout(() => effect.dispose(), 1000));
effect.play({ loop: false });
```

Without `renderer` the effect takes the Baseline tier unconditionally and runs on the JavaScript
kernel. That is a working mode if you have no renderer at the point of construction.

`effect.dispose()` unsubscribes the effect from its world, destroys its emitters and frees mesh
resources. The textures and geometries you passed in are left alone: you own their lifecycle.

## Where the module comes from

Effects are built in the [Sparcoon Editor](https://jango-git.github.io/sparcoon-editor/): a
browser-based node editor with a timeline and a three.js viewport. Each emitter there owns two
graphs - behavior (per-particle simulation) and render (its material) - plus an optional trail graph,
and exporting a project puts everything into one self-contained TypeScript module. You drop it into your source tree and import
it, as in the example above.

Transform channels and timeline values can be marked by the artist as excluded from the export: the
timeline does not drive those, your code supplies the values.

## Driving it from code

```ts
effect.setEmitterParam("Sparks", "intensity", 0.7);
effect.setMeshParam("Shockwave", "glow", [1, 0.4, 0.1]);

effect.getEmitter("Sparks")?.position.set(0, 1, 0);
effect.getMesh("Shockwave")?.rotateY(Math.PI);
```

In the module the editor emitted, both setters and both getters are typed against the names the
project actually declares, so a typo is caught at compile time. An unknown parameter name is always a
safe no-op: a name drift never corrupts the runtime's data.

`getEmitter` returns a live `FXEmitter` (an `Object3D`), which gives you direct control over emission
outside the timeline:

```ts
const sparks = effect.getEmitter("Sparks");
if (sparks) {
  sparks.burst(64); // one-off release, optionally delayed; returns a handle for stop()
  sparks.burst(16, { origin: { position: [2, 1, 0] } }); // as if the emitter stood there
  sparks.play(120); // continuous emission in particles per second; also returns a handle
  sparks.stop(); // with no argument, cancels everything scheduled on this emitter
  sparks.prewarm(2); // simulate 2 seconds forward so playback does not start from an empty screen

  sparks.sortCamera = camera; // depth sorting; undefined turns it off
  sparks.sortFraction = 0.1; // fraction of frames that re-sort (the default)
}
```

Every birth lands in the emitter's next tick, after its update, on both paths: a newborn is seeded
in the frame it is born in and moves from the next one. An undelayed `burst()` keeps the emitter's
pose at the moment of the call - so moving the emitter between two bursts of one frame still spawns
them in two places - and takes the parameter values of that tick. With `origin`, a burst or a play
spawns as if the emitter stood at that point, keeping its own rotation and scale, and moving at the
given velocity - what its spawn graph reads through `world-matrix` and `object-velocity`.

An emitter simulated on the CPU reports its particles' deaths. The editor wires them up as death
reactions (a burst or a play on another emitter where each particle died, one frame later, built in
the export), and the host can listen too - a sound on every firework burst:

```ts
const shells = effect.getEmitter("Shells");
const stopListening = shells?.onParticleDeath((death) => {
  playBang(death.position); // the same object is reused for every death: copy what you keep
});
```

Deaths reach their listeners after every emitter of the world has ticked. A GPU-driven emitter has
no CPU-visible ages (`reportsParticleDeaths` is false) and refuses a listener; the editor builds an
emitter some reaction listens to on the CPU.

An emitter holds a fixed number of particles - the capacity set in the editor - on both the GPU and
the JavaScript path: a ring that never grows. Each birth takes the next slot in turn and overwrites
whatever is there, live or not, so the capacity has to cover the spawn rate times the longest
lifetime, bursts included - otherwise particles die early, replaced by newer ones.

An emitter authored with a trail draws a ribbon behind every particle, from a recorded history of
each particle's path - on the GPU path too, where the history is copied inside video memory. A
parameter name drives the particle and trail materials alike. Depth sorting would scramble that
history, so `sortCamera` has no effect on an emitter with a trail (it warns once). Given a `renderer`, a
trail that needs more vertex attributes or varying vectors than its GPU offers - a heavy trail on
a WebGL1 device - is skipped with a warning, and the particles draw without it.

For diagnostics there are `particleCount`, `particleCapacity` and `particleOverflowCount` (particles
lost so far to a birth overwriting them, or to a burst larger than the capacity - nonzero means the
capacity is too small; a development build also warns once, on the first). A GPU-driven emitter has
no exact live count, so `particleCount` reports an honest upper bound - its capacity - and
`particleOverflowCount` is `undefined`.

## Migrating from 0.10

- **Capacity is a fixed ring now, on the JavaScript path too.** In 0.10 a JavaScript-driven emitter
  started at `expectedCapacity` and grew by `capacityStep` whenever it filled up; now it never grows,
  and a birth into a full emitter overwrites a live particle. `capacityStep` is gone from the options
  (a stale value is ignored).
- **The default capacity is 256** (it was 32, growing by 32).
- **Re-check the capacity of effects exported for 0.10.** One authored with a small capacity that
  only worked because the emitter grew now loses particles: raise the capacity in the editor to
  cover the spawn rate times the longest lifetime, and watch `particleOverflowCount` (or the
  development-build warning) while testing.

## Multiple effects and worlds

A world is a tick and clock domain, not a scene graph. Every effect subscribes to a world on
construction, so a single `FXWorld.update(deltaSeconds)` per frame drives them all.

```ts
import { FXWorld } from "sparcoon";

const slowmo = new FXWorld();
const boss = new MyEffect(assets, { renderer, world: slowmo });
scene.add(boss); // you still add the object to your scene yourself

function frame(deltaSeconds: number): void {
  FXWorld.update(deltaSeconds); // the default world
  slowmo.update(deltaSeconds * 0.3); // its own, slower clock
  renderer.render(scene, camera);
}
```

Within one world every effect shares the clock and one delta per frame, so `effect.stop()` clears the
effect rather than freezing it. To freeze one effect on its own, give it its own world.
`world.dispose()` disposes every effect in that world.

## How it works

The editor compiles a graph into artifacts and bakes them into a module together with the project's
timeline:

- **Render artifact** - GLSL, uniforms, texture references.
- **Trail artifact** - an emitter's trail: GLSL of the same shape, plus how many points of each
  particle's path it keeps and how often it records one. Absent when the emitter has no trail.
- **Behavior artifact** - the authored spawn/update functions, bindings and buffer layout.
- **GPU kernel** - a fused transform-feedback program, present only when the graph opted into GPU
  simulation and compiled.

The runtime executes those artifacts and compiles nothing. The editor/runtime boundary is frozen:
each particle carries two core buffers, `position` (vec3) and `lifecycle` (vec3 `[age, lifetime,
id]`), a particle counts as dead once `age >= lifetime`, and everything else lives in ordinary
`a_fx_<name>` attributes. The package exports the constants of that layout (`FX_AGE`, `FX_LIFETIME`,
`FX_ID`, `FX_CORE_POSITION` and the rest).

Vertex attributes are the scarce resource (WebGL1 guarantees only 8), so the runtime packs
particle fields that lie side by side in one buffer into a single attribute - a vec3 color and a
float alpha travel as one vec4 - and splits them back apart in the shader, so the generated code
reads the same `p_fx_<name>` values either way. This covers trail histories and the GPU kernel's
particle slot; a JS-driven emitter's own particle attributes stay one per field. It is internal: no
API changes, and nothing to opt into. An attribute the render reads but nothing writes has no
buffer and no attribute slot at all - it is always zero, so the shader declares it as that
constant.

The math the generated code calls comes from here too (`fxMix`, `fxSmoothstep`, `fxNoise1` /
`fxNoise2` / `fxNoise3`, `fxFbm`, `fxFbm3`, `fxFract`, `fxMod`, `fxSampleLut`), along with
`fxDataTexture` for baked curves and gradients. There is no reason to import them by hand: the effect
module does it itself.

## Development-build checks

Arguments to public methods are sanity-checked (finite numbers, positive durations, integer
counts) and throw with the parameter's name when violated. The checks live behind
`process.env.NODE_ENV !== "production"`, so they drop out of a production build entirely. The access
to `process` is guarded by a `typeof` check, which keeps the package safe without a bundler - under
import maps or from a CDN.

A few values that are read once, when an emitter is built, are checked in every build instead,
since a bad one would break the emitter outright rather than draw it wrong: the capacity (an integer
of at least 1) and a trail's number of points and sampling interval. They throw a `RangeError`.

## Requirements

|          |                                                                                    |
| -------- | ---------------------------------------------------------------------------------- |
| three.js | `>=0.157 <0.180`, a peer dependency                                                |
| Bundler  | Vite, webpack, Rollup, esbuild - the package ships unminified ESM plus types       |
| JS level | ES2020; for devices older than 2015, transpile it on your side                     |
| WebGL    | WebGL1 is enough for the Baseline tier; WebGL2 unlocks Standard and the GPU kernel |

Dropping the package in through a `<script>` tag is not supported: these are unminified ES modules
that expect your bundler. The ES2020 target is deliberate, so that you can downlevel it with your own
Babel or SWC as far as you need, down to first-generation iPad Pro hardware.

## What the runtime does not do

- **It does not load assets.** You prepare the textures and geometries and pass them to the effect's
  constructor. Freeing them is yours as well: the runtime never disposes resources it does not own.
- **It contains no compiler, graph or validator.** All of that stays in the
  [editor](https://github.com/jango-git/sparcoon-editor); only the result arrives here.
- **It brings no lighting.** A lit graph reads the lights of your scene, so a lit effect needs a
  light probe and a directional light nearby. The preview's own lighting rig is not exported.
- **It does not decide your scene's draw order.** Depth sorting of particles is enabled per emitter
  and costs frame time.

## The `sparcoon/editor` entry point

A separate, unstable entry for tools that build objects from artifacts directly:
`FXEmitter.fromArtifacts` and `FXMesh.fromArtifact`, targeted value updates, swapping the render half
without resetting the simulation, the keyframe-sampling functions shared with the editor, the
render budgets, and the attribute-packing functions (`packingOrder`, `packConsecutive`,
`floatGLSLType`) the editor lays a GPU kernel's buffers out with. The
editor's live preview uses it. An application that simply plays a finished effect has no reason to go
there: the whole path it needs runs through `FXEffect`.

## Local development

```sh
npm ci
npm run build   # tsc -> dist/, unminified ESM plus .d.ts
npm test        # vitest run
npm run lint
```

## Status

Pre-release, under active development. If you hit a bug, the most useful thing is a minimal
reproduction plus the editor project `.json` it shows up on.

## License

MIT - use it in commercial work, client projects and ads that ship; keep the copyright notice. See
[LICENSE](LICENSE).

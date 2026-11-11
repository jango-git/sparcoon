# <img src="https://raw.githubusercontent.com/jango-git/sparcoon/main/assets/logo.svg" width="30" height="30" alt="" align="top" /> Sparcoon

A three.js runtime that plays visual effects authored in the
[Sparcoon Editor](https://github.com/jango-git/sparcoon-editor). The editor compiles a node graph
into a plain ES module of precompiled artifacts, and this package executes them: instanced particle
rendering in one draw call plus a small timeline player. No graph, no compiler and no `eval` in your
build.

**[Open the editor](https://jango-git.github.io/sparcoon-editor/)** -
[Editor source](https://github.com/jango-git/sparcoon-editor) -
[npm](https://www.npmjs.com/package/sparcoon)

<table>
  <tr>
    <td align="center"><img src="https://raw.githubusercontent.com/jango-git/sparcoon-editor/main/assets/gallery/campfire.webp" width="400" alt="Campfire" /><br /><b>Campfire</b></td>
    <td align="center"><img src="https://raw.githubusercontent.com/jango-git/sparcoon-editor/main/assets/gallery/lightning-crack.webp" width="400" alt="Lightning Crack" /><br /><b>Lightning Crack</b></td>
  </tr>
  <tr>
    <td align="center"><img src="https://raw.githubusercontent.com/jango-git/sparcoon-editor/main/assets/gallery/portal.webp" width="400" alt="Portal" /><br /><b>Portal</b></td>
    <td align="center"><img src="https://raw.githubusercontent.com/jango-git/sparcoon-editor/main/assets/gallery/shield.webp" width="400" alt="Energy Shield" /><br /><b>Energy Shield</b></td>
  </tr>
  <tr>
    <td align="center"><img src="https://raw.githubusercontent.com/jango-git/sparcoon-editor/main/assets/gallery/fireworks.webp" width="400" alt="Fireworks" /><br /><b>Fireworks</b></td>
    <td align="center"><img src="https://raw.githubusercontent.com/jango-git/sparcoon-editor/main/assets/gallery/destruction.webp" width="400" alt="Destruction" /><br /><b>Destruction</b></td>
  </tr>
  <tr>
    <td align="center"><img src="https://raw.githubusercontent.com/jango-git/sparcoon-editor/main/assets/gallery/fireflies.webp" width="400" alt="Fireflies" /><br /><b>Fireflies</b></td>
    <td align="center"><img src="https://raw.githubusercontent.com/jango-git/sparcoon-editor/main/assets/gallery/sparks.webp" width="400" alt="Sparks" /><br /><b>Sparks</b></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><img src="https://raw.githubusercontent.com/jango-git/sparcoon-editor/main/assets/editor.webp" width="100%" alt="The Portal preset being built in the editor" /><br /><b>Portal, built node by node in the editor</b></td>
  </tr>
</table>

Every effect above is a bundled preset of the
[editor](https://jango-git.github.io/sparcoon-editor/), built from its own nodes: press
`Ctrl+Space`, pick it on the **Content** screen and hit **Load**.

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
- **One draw call per emitter**, plus one for its trail. Billboards and mesh particles are drawn
  instanced.
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

## Quick start

A module from the editor exports a named `FXEffect` subclass and a typed interface for its assets.
You prepare the textures and geometries yourself and pass them to the constructor.

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

### Sprites from an atlas

A texture asset can also be one sprite of a packed atlas. `fxAtlasRegion` turns a frame entry, as
TexturePacker or free-tex-packer write it (rotation and trim included), into a region of the atlas
texture. Parsing the atlas file stays with you:

```ts
import { fxAtlasRegion } from "sparcoon";

const atlas = loader.load("atlas.png");
const { frames, meta } = atlasJson; // the packer's JSON, loaded by you

const assets: MyEffectAssets = {
  // meta.size lets the region be built before the image has loaded
  spark: fxAtlasRegion(atlas, frames["spark.png"], meta.size),
};
```

The slot's UV square maps onto the sprite's untrimmed source. Trimmed margins come out transparent,
and the graph's wrap mode tiles the sprite, not the whole atlas. A plain `Texture` costs nothing
extra. A region adds a few ALU ops and gets its own shader program. That program is chosen when the
emitter is built, so a later `applyValues` can switch between regions only if the slot was built
with a region. Pack with some extrusion (TexturePacker's `extrude`) so that bilinear filtering at a
sprite's edge does not pick up its neighbours.

### Soft particles: camera depth

A graph with a Depth Fade node (soft particles, or a glow where a shield meets the ground) fades
against the depth of the opaque scene. That depth belongs to the camera, not to the effect: the same
effect is drawn by every camera that sees it. So you give it to the camera, once and for all:

```ts
import { DepthTexture, Group, WebGLRenderTarget } from "three";
import { fxSetCameraDepth } from "sparcoon";

const depthPass = new WebGLRenderTarget(width, height, {
  depthTexture: new DepthTexture(width, height),
});
fxSetCameraDepth(camera, depthPass.depthTexture);

const effects = new Group(); // holds your effects; they fade against the rest of the scene
scene.add(effects);
effects.add(effect);

// each frame
effects.visible = false;
renderer.setRenderTarget(depthPass);
renderer.render(scene, camera);
effects.visible = true;
renderer.setRenderTarget(null);
renderer.render(scene, camera);
```

The depth is the window depth in a texture's red channel, rendered through the same viewport as the
frame the camera draws into (at any resolution): a depth pre-pass like this one, a resolved copy of
the depth buffer after your opaque pass, or the depth your post-processing already has. Keep it
current yourself, across a resize too; effects never need rebinding.

A camera without depth draws these graphs hard - the fade is 1 - so leave it unset where depth is
unsupported (WebGL1 without `WEBGL_depth_texture`) or not wanted. Beyond that:

- While a camera draws into the target that owns its depth, it draws hard too, so leaving the
  effects in the pre-pass is safe, only wasted work.
- The runtime checks only the drawing camera's own depth: never give one camera the depth texture of
  a target another camera draws the effects into - that feedback loop it cannot see.
- Depth Fade renders only in `blending` mode, since a depth-writing particle would read its own
  depth.
- Not supported: a logarithmic or reversed depth buffer, and one camera drawing two different views
  in a frame - give each view its own camera.

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
  sparks.play(8, { over: "distance" }); // per world unit the emitter travels: a trail of particles
  sparks.stop(); // with no argument, cancels everything scheduled on this emitter
  sparks.prewarm(2); // simulate 2 seconds forward so playback does not start from an empty screen

  sparks.sortCamera = camera; // depth sorting, CPU-simulated emitters only; undefined turns it off
  sparks.sortFraction = 0.1; // fraction of frames that re-sort (the default)
}
```

Every birth lands in the emitter's next tick, after its update, on both paths: a newborn is seeded
in the frame it is born in and moves from the next one. An undelayed `burst()` keeps the emitter's
pose at the moment of the call - so moving the emitter between two bursts of one frame still spawns
them in two places - and takes the parameter values of that tick. With `origin`, a burst or a play
spawns as if the emitter stood at that point, keeping its own rotation and scale, and moving at the
given velocity - what its spawn graph reads through `world-matrix` and `object-velocity`. A play
`over: "distance"` counts its rate per world unit the emitter's position travels, so it spawns
nothing while the emitter stands still; it takes no `origin`, which does not move.

An emitter simulated on the CPU reports its particles' deaths - of age, or killed by its update
graph (the update sink's `kill`, e.g. wired from a collider's `contact`). The editor wires them up as death
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
history, so `sortCamera` has no effect on an emitter with a trail (it warns once) - nor on a
GPU-driven one, whose particles have no CPU-visible positions to sort. Given a `renderer`, a
trail that needs more vertex attributes or varying vectors than its GPU offers - a heavy trail on
a WebGL1 device - is skipped with a warning, and the particles draw without it.

For diagnostics there are `particleCount`, `particleCapacity` and `particleOverflowCount` (particles
lost so far to a birth overwriting them, or to a burst larger than the capacity - nonzero means the
capacity is too small; a development build also warns once, on the first). A GPU-driven emitter has
no exact live count, so `particleCount` reports an honest upper bound - its capacity - and
`particleOverflowCount` is `undefined`.

## Migrating from 0.10

- **A JavaScript-driven emitter no longer grows.** In 0.10 it started at `expectedCapacity` and grew
  by `capacityStep`; now its capacity is the fixed ring described above. `capacityStep` is gone from
  the options (a stale value is ignored).
- **The default capacity is 256** (it was 32, growing by 32).
- **Re-check the capacity of effects exported for 0.10.** One that only worked because the emitter
  grew now loses particles: raise its capacity in the editor and watch `particleOverflowCount`.

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

## Compiling shaders ahead

The GPU compiles an effect's shaders on the first frame it is drawn in, which can stall that frame.
`effect.compile()` does it ahead of time, typically behind a loading screen:

```ts
const effect = new MyEffect(assets, { renderer, camera });
await effect.compile(renderer, camera, scene); // `scene` lights a lit effect
scene.add(effect);
```

- **Render target.** It is part of every compiled program. If the effect is drawn into a
  post-processing buffer, set that target on the renderer before compiling, or the first frame
  compiles again.
- **Three r157** has no asynchronous compile: `compile()` compiles the whole `scene`
  synchronously and resolves at once, so add the effect to the scene first.
- **Not covered:** shadow depth programs (compiled by the first shadow pass), and GPU simulation
  kernels, which the constructor already links.

Three deletes a program together with the last material using it, and an effect's GPU simulation
kernels go with its last emitter too: an effect built after every earlier one was disposed compiles
again. Reuse effects instead - see below.

## Reusing effects

An effect is built to be played many times: `stop()` kills every live particle at once, on both
backends, and a stopped emitter skips its simulation until it spawns again. Keeping finished
effects in a pool instead of disposing them saves the compile, the buffer allocations and the GPU
kernel link of a new instance:

```ts
class Pool {
  private readonly idle: MyEffect[] = [];
  private readonly finishing: { effect: MyEffect; left: number }[] = [];

  constructor(
    private readonly build: () => MyEffect,
    private readonly tail: number,
  ) {}

  play(scene: Scene, position: Vector3): void {
    const effect = this.idle.pop() ?? this.build();
    effect.position.copy(position);
    scene.add(effect);
    effect.addEventListener("finished", () => this.finishing.push({ effect, left: this.tail }), {
      once: true,
    });
    effect.play({ loop: false });
  }

  // The timeline is over, its particles are not: they get `tail` more seconds of world time.
  update(deltaSeconds: number): void {
    for (let i = this.finishing.length - 1; i >= 0; i--) {
      const entry = this.finishing[i];
      entry.left -= deltaSeconds;
      if (entry.left <= 0) {
        this.finishing.splice(i, 1);
        entry.effect.stop();
        entry.effect.removeFromParent();
        this.idle.push(entry.effect);
      }
    }
  }
}

const explosions = new Pool(() => new MyEffect(assets, { renderer, camera }), 1.5);

function frame(deltaSeconds: number): void {
  FXWorld.update(deltaSeconds);
  explosions.update(deltaSeconds); // the same delta: a paused or slowed world waits too
  renderer.render(scene, camera);
}
```

- **Tail.** `"finished"` marks the end of the timeline, not of the particles. A GPU-driven
  emitter's particles never leave the GPU, so the runtime cannot tell when the last one died: the
  tail is the longest particle lifetime, which the effect's author knows. Count it in the world's
  time, not with a timer: particles age only while their world is updated.
- **What a replay resets:** the timeline, live particles, everything scheduled and the motion
  baseline. **What it keeps:** the root's transform, parameters set with `setEmitterParam` /
  `setMeshParam`, and event listeners - hence `{ once: true }`.
- **Warm-up.** Build and `compile()` the pool's first instances behind the loading screen.
- **Waiting instances** stay registered in their world but simulate nothing and draw no particles
  or trails. Their VFX meshes are still drawn, so take them out of the scene.

## How it works

An exported module carries the project's timeline and, per emitter or mesh, the artifacts
below:

- **Render artifact** - GLSL, uniforms, texture references.
- **Trail artifact** - an emitter's trail: GLSL of the same shape, plus how many points of each
  particle's path it keeps and how often it records one. Absent when the emitter has no trail.
- **Behavior artifact** - the authored spawn/update functions, bindings and buffer layout.
- **GPU kernel** - a fused transform-feedback program, present only when the graph opted into GPU
  simulation and compiled.

The editor/runtime boundary is frozen:
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

The same goes for the version check. Every exported module records the sparcoon version the editor
compiled it against (`runtime` in its spec, and in the file header). When this runtime is of another
minor version (below 1.0; from 1.0 on, another major or an older minor), the first effect built from
the module logs a warning naming both versions. Patch versions never warn: a patch is a fix, so a
module built on 0.12.3 plays on 0.12.1 and the other way round. `FX_RUNTIME_VERSION` is this runtime's
version.

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

- **It does not load or free assets.** The runtime never disposes resources it does not own.
- **It brings no lighting.** A lit graph shades with the lights of your scene - Lambert and Half-Lit
  with all of three's lights, ambient shading with the ambient, hemisphere and light-probe ones - so
  in a scene without them it comes out dark. The preview's own lighting rig is not exported.
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

## Reporting bugs

The most useful thing is a minimal reproduction plus the editor project `.json` it shows up on.

## License

MIT - use it in commercial work, client projects and ads that ship; keep the copyright notice. See
[LICENSE](LICENSE).

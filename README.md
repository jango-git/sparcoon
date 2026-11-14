# <img src="https://raw.githubusercontent.com/jango-git/sparcoon/main/assets/logo.svg" width="30" height="30" alt="" align="top" /> Sparcoon

A three.js runtime that plays effects exported from the
[Sparcoon Editor](https://github.com/jango-git/sparcoon-editor). The editor compiles node graphs into
an ES module with ready shaders and simulation code, and the runtime draws the particles and plays
the timeline.

**[Editor](https://jango-git.github.io/sparcoon-editor/)** -
[Editor source](https://github.com/jango-git/sparcoon-editor) -
[npm](https://www.npmjs.com/package/sparcoon)

<table>
  <tr>
    <td align="center"><img src="https://raw.githubusercontent.com/jango-git/sparcoon-editor/main/assets/gallery/campfire.webp" width="400" alt="Campfire" /><br /><b>Campfire</b><br /><sub>flipbook, Half-Lit, ground collision</sub></td>
    <td align="center"><img src="https://raw.githubusercontent.com/jango-git/sparcoon-editor/main/assets/gallery/lightning-crack.webp" width="400" alt="Lightning Crack" /><br /><b>Lightning Crack</b><br /><sub>mesh particles, shadows, soft particles</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="https://raw.githubusercontent.com/jango-git/sparcoon-editor/main/assets/gallery/portal.webp" width="400" alt="Portal" /><br /><b>Portal</b><br /><sub>vortex, soft particles</sub></td>
    <td align="center"><img src="https://raw.githubusercontent.com/jango-git/sparcoon-editor/main/assets/gallery/shield.webp" width="400" alt="Energy Shield" /><br /><b>Energy Shield</b><br /><sub>sphere collision, death reactions, trails</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="https://raw.githubusercontent.com/jango-git/sparcoon-editor/main/assets/gallery/fireworks.webp" width="400" alt="Fireworks" /><br /><b>Fireworks</b><br /><sub>chained reactions, inherited color, trails</sub></td>
    <td align="center"><img src="https://raw.githubusercontent.com/jango-git/sparcoon-editor/main/assets/gallery/destruction.webp" width="400" alt="Destruction" /><br /><b>Destruction</b><br /><sub>mesh particles, shadows, lighting, collisions</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="https://raw.githubusercontent.com/jango-git/sparcoon-editor/main/assets/gallery/fireflies.webp" width="400" alt="Fireflies" /><br /><b>Fireflies</b><br /><sub>curl noise</sub></td>
    <td align="center"><img src="https://raw.githubusercontent.com/jango-git/sparcoon-editor/main/assets/gallery/sparks.webp" width="400" alt="Sparks" /><br /><b>Sparks</b><br /><sub>GPU simulation, collision, shadows</sub></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><img src="https://raw.githubusercontent.com/jango-git/sparcoon-editor/main/assets/editor.webp" width="100%" alt="The Portal preset in the editor" /><br /><b>Portal in the editor</b></td>
  </tr>
</table>

Every effect above is an editor preset. To open one, press `Ctrl+Space`, pick it on the **Content**
screen and press **Load**.

> **0.x.** The export format still changes, so an effect plays only on the runtime minor version it
> was exported for. After updating the runtime, export your effects again.

## Features

- Effects made of particle emitters and meshes under a shared timeline.
- Billboard and mesh particles, particle trails.
- Collisions with planes, boxes, spheres and cones.
- Particle death events for reactions between emitters and for listeners in your code, with
  attribute inheritance.
- Soft particles, scene lighting and shadows.
- GPU simulation.

## Requirements

|          |                                            |
| -------- | ------------------------------------------ |
| three.js | `>=0.157 <0.188`, the only peer dependency |
| Renderer | `WebGLRenderer`                            |
| WebGL    | WebGL2, or WebGL1 with three 0.157-0.162   |
| Bundler  | Vite, webpack, Rollup, esbuild             |
| JS level | ES2020                                     |

- Every effect carries shaders for two tiers, Standard (WebGL2) and Baseline (WebGL1). The runtime
  picks the tier by the renderer. An emitter simulates on the GPU if the device supports it, and on
  the CPU otherwise. three dropped WebGL1 in 0.163, so a WebGL1 device needs three 0.157-0.162.
- `WebGPURenderer` is not supported. An effect given one, or drawn by one, throws an error. If the
  bundler maps `three` to `three/webgpu`, the import of sparcoon fails, because that build has no
  `UniformsLib`.
- Neither the runtime nor the export calls `eval` or `new Function`, so effects run under a CSP that
  forbids code generation.
- The package is unbundled, unminified ESM with types. Loading it through a `<script>` tag is not
  supported. For older devices, transpile it together with your own code.

## Quick start

```sh
npm install sparcoon three
```

A module from the editor exports the effect class and the interface of its assets. You load the
textures and geometries yourself:

```ts
import { TextureLoader } from "three";
import { FXWorld } from "sparcoon";
import { MyEffect, type MyEffectAssets } from "./effects/MyEffect"; // emitted by the editor

const loader = new TextureLoader();
const assets: MyEffectAssets = {
  spark: loader.load("spark.png"),
};

const effect = new MyEffect(assets, { renderer, camera });
scene.add(effect); // an effect is a THREE.Group
effect.play();

function frame(deltaSeconds: number): void {
  FXWorld.update(deltaSeconds); // advances every effect
  renderer.render(scene, camera);
}
```

`renderer` is needed to select the shader tier and for GPU simulation. Without it the effect runs on
Baseline and the CPU. `camera` is needed by emitters with depth sorting.

## Lifecycle

- `play()` starts the timeline from the beginning.
- `stop()` halts it, removes the particles and returns the effect to frame zero.
- A looping effect starts each new lap without removing live particles.
- A one-shot effect (set so in the editor, or started with `play({ loop: false })`) holds its
  last frame and dispatches `"finished"`, then `"drained"` once the last particle and the last trail
  are gone.
- `dispose()` frees the effect's emitters and meshes. The runtime does not free your textures and
  geometries.

```ts
effect.addEventListener("drained", () => effect.dispose());
effect.play({ loop: false });
```

`"drained"` arrives only if the longest particle lifetime is known - in the editor, a Lifetime node
with its min and max typed in. If the lifetime comes from a graph or a parameter, the editor warns
about it, and you stop such an effect yourself, waiting out the particle lifetime after
`"finished"`.

### Pool

A one-shot effect can go back to a pool on `"drained"` and play again:

```ts
class Pool {
  private readonly idle: MyEffect[] = [];

  constructor(private readonly build: () => MyEffect) {}

  play(scene: Scene, position: Vector3): void {
    const effect = this.idle.pop() ?? this.build();
    effect.position.copy(position);
    scene.add(effect);
    effect.addEventListener(
      "drained",
      () => {
        effect.stop();
        effect.removeFromParent();
        this.idle.push(effect);
      },
      { once: true },
    );
    effect.play({ loop: false });
  }
}
```

- A replay resets the timeline, the particles and scheduled emission. The transform, parameters and
  event listeners are kept.
- A pooled effect simulates no particles, but its meshes are still drawn - take it out of the scene.

### Compiling ahead

Shaders compile on the first frame the effect is visible in, and that frame can stall. `compile()`
does it ahead of time, for example behind a loading screen:

```ts
const effect = new MyEffect(assets, { renderer, camera });
await effect.compile(renderer, camera, scene);
scene.add(effect);
```

- If the effect draws into a post-processing buffer, set that render target on the renderer before
  `compile()`.
- On three r157 `compile()` compiles the whole `scene` synchronously, so add the effect to the scene
  before the call.
- Shadow pass shaders are not compiled ahead.
- Three deletes a shader together with the last material using it, so an effect built after every
  earlier one was disposed compiles again.

## Driving it from code

### Parameters and objects

```ts
effect.setEmitterParam("Sparks", "intensity", 0.7);
effect.setMeshParam("Shockwave", "glow", [1, 0.4, 0.1]);

effect.getEmitter("Sparks")?.position.set(0, 1, 0);
effect.getMesh("Shockwave")?.rotateY(Math.PI);
```

- Emitter, mesh and parameter names are typed in the exported module, and an unknown parameter name
  is ignored.
- Channels excluded from the export in the editor are left alone by the timeline - your code sets
  their values.

### Emission

```ts
const sparks = effect.getEmitter("Sparks");
if (sparks) {
  sparks.burst(64); // a burst, returns a handle for stop()
  sparks.burst(16, { origin: { position: [2, 1, 0] } }); // a burst from another point
  sparks.play(120); // particles per second
  sparks.play(8, { over: "distance" }); // particles per unit the emitter travels
  sparks.stop(); // with no argument, cancels all of the emitter's emission
  sparks.prewarm(2); // simulate 2 seconds ahead
}
```

- `origin` sets the birth point and velocity, and rotation and scale come from the emitter.

### Particle deaths

```ts
const shells = effect.getEmitter("Shells");
const stopListening = shells?.onParticleDeath((death) => {
  playBang(death.position); // the object is reused, so copy what you keep
});
```

- Only a CPU emitter reports deaths (`reportsParticleDeaths`). The editor moves reaction sources to
  the CPU itself.
- Listeners run after every emitter of the world has ticked.
- `death.slot` holds every attribute of the dead particle. To let the particles of your own burst
  inherit values, pass them in `origin.inherited`. Without it the particles get the default values.

### Sorting and capacity

```ts
sparks.sortCamera = camera; // depth sorting, undefined turns it off
sparks.sortFraction = 0.1; // share of frames that re-sort
```

- Sorting works only on the CPU and not on an emitter with a trail.
- An emitter's capacity is set in the editor and does not grow. A new particle takes the next slot
  even if a live one is there, so the capacity has to cover the emission rate times the lifetime.
- `particleCount`, `particleCapacity` and `particleOverflowCount` show the occupancy. A nonzero
  `particleOverflowCount` means the capacity is too small. The GPU has no exact count, so
  `particleCount` equals the capacity and `particleOverflowCount` is `undefined`.

## Worlds

A world sets the clock for its effects. By default every effect is in one world, and `FXWorld.update`
advances them by one delta. A separate world is needed to slow down or pause some of the effects:

```ts
const slowmo = new FXWorld();
const boss = new MyEffect(assets, { renderer, world: slowmo });
scene.add(boss);

function frame(deltaSeconds: number): void {
  FXWorld.update(deltaSeconds);
  slowmo.update(deltaSeconds * 0.3);
  renderer.render(scene, camera);
}
```

`world.dispose()` disposes every effect of the world.

## Scene

### Lighting and shadows

- Lit effects use the lights of your scene. Lambert and Half-Lit take all of three's lights, ambient
  takes only the ambient, hemisphere and light probe ones. The editor's preview lighting is not
  exported.
- Which objects of an effect cast and receive shadows is set in the editor.

### Soft particles

Effects with a Depth Fade node fade out near the surfaces of the scene. For that the camera needs a
depth texture of the opaque scene:

```ts
import { DepthTexture, Group, WebGLRenderTarget } from "three";
import { fxSetCameraDepth } from "sparcoon";

const depthPass = new WebGLRenderTarget(width, height, {
  depthTexture: new DepthTexture(width, height),
});
fxSetCameraDepth(camera, depthPass.depthTexture);

const effects = new Group();
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

- Any depth texture of the same viewport at any resolution works, for example from a separate pass,
  a copy of the depth buffer or post-processing. Keeping it current, resizes included, is up to you.
- Without depth, effects draw with hard edges. They draw the same way into the target that owns the
  camera's depth.
- Do not give a camera the depth of a target another camera draws the effects into.
- Depth Fade works only in blending mode (`blending`).
- Logarithmic and reversed depth buffers are not supported.

### Atlases

A texture slot accepts a sprite from an atlas. `fxAtlasRegion` builds it from a TexturePacker or
free-tex-packer frame entry:

```ts
import { fxAtlasRegion } from "sparcoon";

const atlas = loader.load("atlas.png");
const { frames, meta } = atlasJson; // the packer's JSON

const assets: MyEffectAssets = {
  spark: fxAtlasRegion(atlas, frames["spark.png"], meta.size),
};
```

- Texture wrapping repeats the sprite, not the atlas.
- An atlas sprite costs a few shader operations and a shader of its own.

## Checks

- Argument checks run only in a development build and are removed with `NODE_ENV=production`.
- An effect exported for another minor version logs a warning naming both versions. The runtime's
  version is `FX_RUNTIME_VERSION`.
- Given a `renderer`, a trail that needs more vertex attributes, varyings, uniforms or textures than
  the GPU offers (a heavy trail on WebGL1) is skipped with a warning, and its particles draw without
  it.

## The `sparcoon/editor` entry point

An unstable API for tools that build emitters and meshes from artifacts directly. The editor's
preview uses it, and it is not needed for playing effects.

## Development

```sh
npm ci
npm run build
npm test
npm run lint
```

When reporting a bug, attach a minimal reproduction and the editor project `.json`.

## License

MIT. See [LICENSE](LICENSE).

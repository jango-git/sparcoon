# <img src="https://raw.githubusercontent.com/jango-git/sparcoon/main/assets/logo.svg" width="30" height="30" alt="" align="top" /> Sparcoon

A three.js runtime that plays effects exported from the
[Sparcoon Editor](https://github.com/jango-git/sparcoon-editor). The editor compiles node graphs into
an ES module with ready shaders and simulation code, and the runtime draws the particles and plays
the timeline.

**[Editor](https://jango-git.github.io/sparcoon-editor/)** -
**[Examples](https://jango-git.github.io/sparcoon/)** -
[Editor source](https://github.com/jango-git/sparcoon-editor) -
[npm](https://www.npmjs.com/package/sparcoon)

<table>
  <tr>
    <td align="center"><img src="https://raw.githubusercontent.com/jango-git/sparcoon-editor/main/assets/gallery/campfire.webp" width="400" alt="Campfire" /><br /><b>Campfire</b><br /><sub>flipbook, Half-Lit, SDF collision</sub></td>
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
    <td align="center"><img src="https://raw.githubusercontent.com/jango-git/sparcoon-editor/main/assets/gallery/fireflies.webp" width="400" alt="Fireflies" /><br /><b>Fireflies</b><br /><sub>spawn on a mesh, curl noise, SDF avoidance</sub></td>
    <td align="center"><img src="https://raw.githubusercontent.com/jango-git/sparcoon-editor/main/assets/gallery/sparks.webp" width="400" alt="Sparks" /><br /><b>Sparks</b><br /><sub>GPU simulation, scene depth collision, shadows</sub></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><img src="https://raw.githubusercontent.com/jango-git/sparcoon-editor/main/assets/editor.webp" width="100%" alt="The Portal preset in the editor" /><br /><b>Portal in the editor</b></td>
  </tr>
</table>

Every effect above is an editor preset. To open one, press `Ctrl+Space`, pick it on the **Content**
screen and press **Load**.

> **0.x.** The export format still changes, so an effect plays only on the runtime minor version it
> was exported for. After updating the runtime, export your effects again. The editor opens projects
> from every earlier version.

## Features

- Effects made of particle emitters and meshes under a shared timeline.
- Billboard and mesh particles, particle trails and ribbons.
- Random points on the surface of a mesh, evenly by area.
- Collisions with planes, boxes, spheres, cones, signed distance fields (SDF) baked from meshes and
  the depth of the rendered scene.
- Particle birth and death events for reactions between emitters and for listeners in your code,
  with attribute inheritance.
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
  `UniformsLib`. WebGPU support will be added if users of the editor ask for it, or once mobile
  playables no longer target WebGL1 devices. To ask for it, open an
  [issue](https://github.com/jango-git/sparcoon/issues).
- Neither the runtime nor the export calls `eval` or `new Function`, so effects run under a CSP that
  forbids code generation.
- The package is unbundled, unminified ESM with types. Loading it through a `<script>` tag is not
  supported. For older devices, transpile it together with your own code.
- The published code prefixes class members outside the API with `_private_`. A minifier shortens
  them when given the prefix: terser `mangle: { properties: { regex: /^_private_/ } }`, esbuild
  `--mangle-props=^_private_`.

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

A whole page that plays the editor's presets this way is in [examples](examples/).

`renderer` is needed to select the shader tier and for GPU simulation. Without it the effect runs on
Baseline and the CPU. An effect with depth sorting or with collisions against the scene's depth
requires `camera`.

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
    const onDrained = (): void => {
      effect.removeEventListener("drained", onDrained);
      effect.stop();
      effect.removeFromParent();
      this.idle.push(effect);
    };
    effect.addEventListener("drained", onDrained);
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

An emitter simulated on the GPU also runs programs that sparcoon builds itself, not three. Creating
the effect sends them off to build without waiting for them, and the first simulation step waits
only for one that has not finished. `compile()` waits for them too. `simulationReady()` waits for
them alone, for a game that compiles three's programs itself:

```ts
await renderer.compileAsync(scene, camera);
await effect.simulationReady();
```

- On three r157 `compile()` compiles the whole `scene` synchronously and stalls until three's
  programs are built, so add the effect to the scene before the call. From r158 it waits without
  stalling.
- Without `KHR_parallel_shader_compile` a build cannot be waited for without stalling. `compile()`
  then stalls once for each program sparcoon builds, and each of three's programs stalls on its
  first draw.
- Turn `renderer.debug.checkShaderErrors` off in production. With it on, three reads the logs of
  every program it builds: on r157 while compiling, from r158 on its first draw.
- A program the driver rejects does not reject `compile()` or `simulationReady()`. The failure is
  logged and `getEmitter(name)?.simulationFailure` holds the driver's log. Without its simulation program the
  emitter spawns no particles, and without its sort program it draws them unsorted.
- If the effect draws into a post-processing buffer, set that render target on the renderer before
  `compile()`.
- Shadow pass shaders are not compiled ahead.
- Three deletes a shader together with the last material using it, and sparcoon deletes a
  simulation program together with the last effect using it. An effect built after every earlier
  one was disposed compiles again.

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

### Particle births and deaths

```ts
const shells = effect.getEmitter("Shells");
const stopListening = shells?.onParticleEvent("death", (death) => {
  playBang(death.position); // the object is reused, so copy what you keep
});
shells?.onParticleEvent("birth", (birth) => playLaunch(birth.position));
```

- Only a CPU emitter reports births and deaths (`reportsParticleEvents`). The editor moves reaction
  sources to the CPU itself.
- Listeners run after every emitter of the world has ticked: in one frame deaths first, then
  births.
- A birth is reported at the position its spawn chose, with the velocity of the emitter or of the
  spawn origin. A death is reported after the particle's last update, with how fast it moved over
  its last frame.
- `slot` holds every attribute of the particle. At a birth only what its spawn wrote is set. To let
  the particles of your own burst inherit values, pass them in `origin.inherited`. Without it the
  particles get the default values.

### Sorting and capacity

```ts
if (sparks?.sort !== undefined) {
  sparks.camera = closeUpCamera; // sorts by distance from another camera
  sparks.sort.fraction = 0.25; // share of frames that re-sort
}
```

- An emitter sorts its particles back to front when the editor gives it a sort interval, on the CPU
  and on the GPU. Whether it sorts is fixed when the effect is built: an emitter without sorting
  has no `sort`, and the fraction of one with it can be changed. It sorts from the emitter's
  `camera`, which can be changed too.
- An emitter with a trail or a ribbon, or one that does not draw its particles, does not sort.
- On the GPU a sort compares every slot with every other, so its cost grows with the square of the
  capacity. A sorted GPU emitter also copies its particles into a texture on every frame they
  change.
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

### Scene depth

Two nodes read the depth of the opaque scene a camera sees. Depth Fade fades particles out near
its surfaces (soft particles), and Depth Sample lets GPU-simulated particles collide with them. For
either the camera needs a depth texture of the opaque scene:

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
- Without depth, Depth Fade draws hard edges and Depth Sample finds no surface. Depth Fade also
  draws hard edges into the target that owns the camera's depth.
- Do not give a camera the depth of a target another camera draws the effects into.
- Depth Fade works only in blending mode (`blending`).
- Logarithmic and reversed depth buffers are not supported.

Collisions with the depth have rules of their own:

- They run only in the GPU simulation, on WebGL2. On Baseline and in the CPU simulation Depth
  Sample finds no surface.
- A tick reads the depth of the frame rendered before it, so collisions lag one frame behind the
  scene. Move the camera before `FXWorld.update`, not between it and `renderer.render`. The
  simulation reads the depth with the camera as it stood after the tick before.
- The camera's whole view has to fill the depth texture. A view drawn into a part of the target
  (a viewport smaller than the target) is not supported.
- Only what the depth holds collides: opaque surfaces in view. Particles off screen, behind the
  camera or more than the node's thickness behind a surface find none.
- An emitter collides with the depth of its `camera`, the effect's `options.camera` unless changed.
  Other cameras drawing the effect do not change it.

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

### Signed distance fields

An effect whose particles sample an SDF takes it among its assets as a `Data3DTexture` in R8:
`RedFormat` and `UnsignedByteType`, texels in `image.data` with x varying fastest, then y, then z.
The box the field fills and how a texel encodes a distance are part of the effect, so the texture
carries only the texels. How you store and load them is up to you.

The editor downloads a baked SDF as a grayscale PNG of its slices, with the size in the file name
(`Box SDF 64x64x64.png`). Slice `z` is the tile at column `z % columns` and row
`floor(z / columns)`, where `columns` is `ceil(sqrt(depth))`, and its rows run from the top. This
builds the texture from it:

```ts
import { Data3DTexture, RedFormat, UnsignedByteType } from "three";

function sdfFromSlices(image: HTMLImageElement, width: number, height: number, depth: number) {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d")!;
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, image.width, image.height).data;
  const columns = Math.ceil(Math.sqrt(depth));
  const texels = new Uint8Array(width * height * depth);
  for (let z = 0; z < depth; z++) {
    const left = (z % columns) * width;
    const top = Math.floor(z / columns) * height;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        texels[(z * height + y) * width + x] = pixels[((top + y) * image.width + left + x) * 4];
      }
    }
  }
  const sdf = new Data3DTexture(texels, width, height, depth);
  sdf.format = RedFormat;
  sdf.type = UnsignedByteType;
  return sdf;
}
```

- Keep `image.data` after loading. The CPU simulation reads it, and the GPU simulation uploads its
  own copy, filtered linearly.
- Only the simulation reads the field. Materials do not.

## Checks

- Argument checks run only in a development build and are removed with `NODE_ENV=production`.
- An effect exported for another minor version logs a warning naming both versions. The runtime's
  version is `FX_RUNTIME_VERSION`.
- Given a `renderer`, a trail or a ribbon that needs more vertex attributes, varyings, uniforms or
  textures than the GPU offers (a heavy one on WebGL1) is skipped with a warning, and its particles
  draw without it.

## The `sparcoon/editor` entry point

An unstable API for tools that build emitters and meshes from artifacts directly. The editor's
preview uses it, and it is not needed for playing effects.

## The `sparcoon/helpers` entry point

The functions and GLSL sources compiled code calls by name: the CPU simulation's math and noise,
and the helpers its shaders link. Exported effects import it themselves, and a bundle keeps one copy
of each helper for all of them. A game does not call it.

The GLSL helpers in `src/helpers/glsl.ts` are generated from `scripts/glsl`. After changing them,
run `npm run generate`.

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

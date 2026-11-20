# Changelog

Every notable change to sparcoon, as it affects a game playing effects exported from the
[Sparcoon Editor](https://jango-git.github.io/sparcoon-editor/). Versions follow semver; while the
major is 0, a minor release may change what an exported effect is made of, and an effect plays only
on the minor it was built for - after such an update, re-export every effect.

## 0.25.0 - 2026-11-20

### Changed

- The CPU simulation repeats itself. Its random draws hash the particle's id and a seed that every
  update advances, where an exported effect called `Math.random`. An effect played with the same
  frame times spawns the same particles on every run, so its CPU path can be compared against
  screenshots. The GPU simulation already did so. Export your effects again.

### Fixed

- `fxSetCameraDepth` accepts `null` and takes the depth away, as with `undefined`. From three r164
  `WebGLRenderTarget.depthTexture` is typed `DepthTexture | null`, and passing it no longer fails
  type checking.

## 0.24.0 - 2026-11-19

### Added

- `FXEffect.simulationReady()` waits for the programs of the effect's GPU simulation, leaving three's
  draw programs to the game's own compiling. `FXEmitter.simulationFailure` holds the driver's log
  for one it rejected.
- In `sparcoon/editor`, `fxPrepareKernel(renderer, kernel)` sends a GPU kernel's program off to
  build before an emitter is built from it, and tells when the build has ended.

### Changed

- Re-export every effect. An effect exported for 0.23 plays as before, but warns in development
  that it was built for another version.
- `FXEffect.compile()` also waits for the programs of the GPU simulation.
- A GPU simulation program the driver fails to compile or link no longer sends the emitter to the
  CPU simulation. The failure is logged on the emitter's first simulation step or while
  `compile()` or `simulationReady()` waits, and the emitter spawns no particles. A rejected sort program leaves the particles unsorted. An
  emitter still simulates on the CPU when the GPU cannot hold its kernel.

### Performance

- Creating an effect no longer waits for the programs of its GPU simulation and sort to compile and
  link. They build in the background, and the first simulation step waits only for one that has not
  finished. With `KHR_parallel_shader_compile`, `compile()` waits for them without stalling.

## 0.23.0 - 2026-11-18

### Added

- In `sparcoon/editor`, `fxEmitterStripMesh(emitter, kind)` returns the mesh an emitter draws its
  trail or ribbon with.
- The `sparcoon/helpers` entry: the GLSL helpers an exported effect's shaders link, as constants
  each effect module imports by name. A bundle carries each helper once, however many effects use
  it.

### Changed

- The CPU math and noise functions an exported effect calls (`fxMix`, `fxNoise1`, `fxSeedHash1`
  and the rest) moved from `sparcoon` to `sparcoon/helpers`. Re-export every effect.

### Removed

- `fxFbm` and `fxFbm3`. An effect exported for this version does not call them.

## 0.22.0 - 2026-11-15

### Added

- An emitter can draw a ribbon, a band through its particles in the order they were born, on both
  backends. Each particle joins the one born right after it, so a ribbon follows one stream of
  births. Along the ribbon `p_uv.x` is each point's age over its lifetime, or repeats every given
  number of particles. With `head`, while a play emits from the emitter's pose, the ribbon reaches
  from its newest particle to the particle a birth would seed now, computed by the behavior's spawn
  every tick. A ribbon is skipped with a warning past the GPU's limits, as a trail is.
- An emitter can simulate its particles without drawing them, for an emitter shown only by its trail
  or ribbon.
- GPU-simulated emitters sort their particles back to front. The simulation keeps the particles in
  place, and on every frame they change they are copied into a texture the material reads, in an
  order a sort keeps on the GPU. A sort compares every slot with every other in one draw, so its
  cost grows with the square of the capacity.
- A behavior can sample a 3D texture, such as an SDF, on both backends. An effect takes it among
  its assets and `FXEmitter.fromArtifacts` in `volumes`, as an R8 `Data3DTexture` whose texels
  stay in `image.data`. The GPU simulation uploads its own copy of each, filtered linearly.
- GPU-simulated particles can collide with the depth of the rendered scene, the same depth
  `fxSetCameraDepth` gives Depth Fade. A tick reads the depth of the frame before it, with the
  camera as it stood after the tick before, so the camera has to move before `FXWorld.update`. An
  effect with such an emitter requires `options.camera` on WebGL2.

### Changed

- **Breaking:** re-export every effect.
- **Breaking:** `FXEmitter.fromArtifacts(behavior, options, world)` takes the particles' render
  artifact as `options.particles`, which can be left out, instead of its first argument.
  `applyRenderArtifact(undefined)` stops drawing the particles. `applyTrailArtifact` and
  `hasTrail` are replaced by `applyStripArtifact(kind, options)` and `hasStrip(kind)`, which take
  `"trail"` or `"ribbon"`. `applyValues` takes `ribbonMaterial`. In `sparcoon/editor`,
  `fxTrailRenderBudget` is replaced by `fxStripRenderBudget(kind, ...)`.
- **Breaking:** whether an emitter sorts is set when it is built. Replace `sortCamera` and
  `sortFraction` with the options `camera` and `sort: { fraction }` of `FXEmitter.fromArtifacts`.
  The emitter's `camera` and `sort.fraction` can still be changed, and `sort` is `undefined` on an
  emitter built without it.
- **Breaking:** an `FXEffect` with a sorted emitter throws without `options.camera`. Before, the
  emitter did not sort.
- Particle ids count births modulo `FX_PARTICLE_ID_RANGE` (2^24) and start over from 0. Before, past
  that many births two consecutive ids read as one.
- `FXEmitter.fromArtifacts` throws for an emitter with `sort` and a trail, a ribbon or no drawn
  particles, and `applyStripArtifact` throws on an emitter that sorts. Before, sorting was skipped
  with a warning.
- In `sparcoon/editor`, `fxEmitterRenderBudget` takes `sorted` to count the GPU mesh of a sorted
  emitter, which reads its particles from textures instead of attributes.

### Fixed

- On three 0.187, a texture three uploaded after a GPU emitter sampling a mesh surface was built,
  and before the next `FXWorld.update`, could ignore its `flipY`, `premultiplyAlpha` or
  `unpackAlignment`.

## 0.21.0 - 2026-11-14

### Added

- **Birth reactions**: an emitter can spawn at every birth of another emitter's particles, the same
  way it spawns at their deaths - a burst or a finite play from where the particle was born, with
  attribute inheritance. Its births land one frame after the particle's. As with deaths, the
  source runs on the CPU whatever its GPU setting.
- `FXEmitter.onParticleEvent("birth", listener)` reports each particle born alive, where its spawn
  placed it and with the velocity of the pose it was born from. Births of `prewarm` are not
  reported.
- The `"octagon"` geometry primitive: the `"plane"` quad with its corners cut, 83% of its area,
  textured the same way. For a large sprite whose texture is empty in the corners it draws the
  same picture with fewer pixels.
- **Random points on a mesh surface**, in the spawn and the update, on the CPU and the GPU. The
  editor's Random Mesh Point node draws a point on a mesh evenly by area, with the mesh's normal
  there, interpolated between the normals of the triangle's vertices (the triangle's own normal if
  the geometry has no normals). The effect takes the mesh as a `BufferGeometry` in its assets under
  the mesh asset's name and requires it, so a missing one throws when the effect is built. The
  runtime reads a geometry when the first emitter sampling it is built, and again for an emitter
  built after the geometry's attributes changed.

### Changed

- **Breaking:** one API for both kinds of particle event. Replace `onParticleDeath(listener)` with
  `onParticleEvent("death", listener)`, `reportsParticleDeaths` with `reportsParticleEvents`, and
  the types `FXParticleDeath` and `FXParticleDeathListener` with `FXParticleEvent` and
  `FXParticleEventListener`. In `sparcoon/editor`, `connectDeathReaction(source, target, ...)`
  becomes `connectReaction(source, kind, target, ...)` and `FXDeathSource` becomes
  `FXParticleEventSource`.
- `FXEffectReaction` takes `on: "birth" | "death"`. Without it a reaction fires on deaths, so
  effects exported before keep their behavior.

## 0.20.1 - 2026-11-14

Effects exported for 0.20.0 play as they are.

### Added

- three 0.180 to 0.187 are supported. The peer range is now `>=0.157.0 <0.188.0`.
- An effect given a `WebGPURenderer` fails with an error saying that it needs a `WebGLRenderer`. The
  constructor throws it, `compile()` rejects with it, and an effect built without `renderer` throws
  it on its first draw by one. Before, the first case threw a `TypeError` and the last drew nothing.

## 0.20.0 - 2026-11-13

### Added

- **Inheritance on death reactions**: the particles a reaction spawns can take values from the
  particle whose death spawned them - any attribute its emitter writes (color, size, a seed...),
  matched by name and exact type, or its id or lifetime - authored with the editor's Inherited
  Attribute node. A birth no death spawned reads the node's default. On the GPU path a reaction's
  births cost nothing extra: they already spawn in a pass of their own.
- **Hash on VFX meshes**: a VFX mesh seeds the editor's Hash node by a seed of its own, the same
  every frame and another for every mesh built - so two copies of one effect, or two meshes of it,
  draw different randoms. Particles still seed by their id.
- `FXParticleDeath.slot`: the dying particle's whole slot, laid out as `FXEmitter.particleSlot`.
- `FXSpawnOrigin.inherited`: what the births of a burst or play at an origin inherit, as many floats
  as `FXEmitter.inheritDefaults`.
- `FXEmitter.inheritDefaults` (what its births inherit when no death spawned them) and
  `FXEmitter.particleSlot` (the layout of a particle's slot).
- The types `FXInheritLayout` (a behavior artifact's `inherit`) and `FXInheritCopies`, and the
  constant `FX_TRANSFORM_FEEDBACK_INHERITED_UNIFORM`, for code that builds artifacts or reactions by
  hand.

### Changed

- **Breaking:** re-export every effect.
- **Breaking:** a behavior artifact's `spawn` takes the inherited values as a sixth argument, and its
  `emitter` argument is always given; an artifact may declare an `inherit` layout. Only code that
  builds behavior artifacts by hand is affected.
- **Breaking:** `connectDeathReaction` takes what to copy as a fourth argument (`FXInheritCopies`),
  and `FXSpawnTarget` and `FXDeathSource` need `inheritDefaults` and `particleSlot` - only code
  implementing them by hand is affected.
- Listening to an emitter's deaths copies each dying particle's whole slot instead of its position.
- `FXDrawInputs` carries the drawn object's `seed` (`RANDOM_SEED` in the shaders) - only code
  calling an artifact's `compute` by hand is affected.

## 0.19.0 - 2026-11-13

### Added

- **Shadow Threshold** on the editor's Surface sink: a shadow-casting effect's shadow keeps the
  fragments whose alpha reaches it, so it moves where the shadow ends - shrinking a soft sprite's
  shadow to its dense core, or widening it - without touching the visible effect. It works in every
  render mode, opaque included; left unwired, the shadow ends where the visible surface does, as
  before.

### Changed

- **Breaking:** re-export every effect.
- **Breaking:** an `FXRenderArtifact` holds its GLSL in two programs (`FXRenderProgram`): `color`,
  which draws it, and `shadow`, which draws it into a shadow map. Only code that builds render
  artifacts by hand is affected; a shadow-casting emitter or mesh needs the `shadow` program.

### Performance

- A shadow-casting effect's shadow pass computes only what decides which fragments cast - the
  color's alpha and the cutoff - and none of its lighting, color or emission, so its shaders are
  smaller and compile faster.

## 0.18.0 - 2026-11-13

### Changed

- **Breaking:** re-export every effect.
- A play spreads each frame's particles along the way its emitter came during that frame, instead
  of spawning them in one clump where the emitter stands at the frame's end: smoke behind a fast
  car or sparks behind a flying object leave an even stream, and a dense play no longer pulses with
  the frame rate. It costs no extra simulation pass. Bursts are unchanged, and so is a play's first
  frame, so an emitter moved into place and started does not smear from where it stood before.

## 0.17.0 - 2026-11-12

### Fixed

- Instances of one effect (a pool) no longer share parameter values: each draws and simulates with
  its own, as set by `setEmitterParam`, `setMeshParam` and its Timeline Values.
- A textured trail is no longer skipped on a GPU without vertex texture units.

### Changed

- **Breaking:** re-export every effect.
- A trail past any of the device's limits is skipped with a warning: uniform vectors and texture
  units are now checked as well as attributes and varyings.

### Performance

- Values that are the same for a whole draw or simulation pass (the clock, the pose, the object's
  motion, parameters) are computed once per frame on the CPU instead of per vertex, fragment or
  particle.
- A GPU simulation pass does no string lookups and copies no pose arrays.
- A trail no longer recomputes its parents' world matrices every frame.

## 0.16.0 - 2026-11-11

### Changed

- **Breaking:** re-export every effect.
- A particle binds only what its rendering reads, so more effects fit WebGL1's attribute limit on
  the CPU path.

## 0.15.0 - 2026-11-11

### Added

- An emitter that has finished stops simulating and drawing by itself once its longest-lived
  particle is gone (`maxLifetime`, written by the editor); `FXEmitter.isSettled` reports it.
- `FXEffect` dispatches `"drained"` after `"finished"` once every emitter has settled, so a game can
  return the effect to a pool without timing its tail itself.

### Performance

- three's `resetState()` runs once per renderer per frame, instead of after every GPU pass.

## 0.14.2 - 2026-11-11

### Added

- `FXEffect.compile(renderer, camera, scene?)` precompiles an effect's shaders: `compileAsync` on
  three r158+, a synchronous `renderer.compile` on r157.

### Changed

- `stop()` and `reset()` clear an emitter's GPU particles.

### Performance

- Emitters on one WebGL context share their GPU simulation programs.
- An idle emitter runs no GPU simulation pass and issues no draw call until its next birth.

## 0.14.1 - 2026-11-11

### Fixed

- `FX_RUNTIME_VERSION` matches the package version, so effects built for this version no longer
  warn that they are played on an incompatible runtime.

## 0.14.0 - 2026-11-11

### Added

- An effect can kill particles early (the editor's update `kill`). A killed particle reports its
  death to `onParticleDeath` listeners and death reactions, as one that dies of age does.
- Fractal, curl and Voronoi noise for effects.

## 0.13.0 - 2026-11-10

### Added

- Depth Fade: `fxSetCameraDepth(camera, texture)` gives a camera the depth of the scene it sees, and
  every effect using Depth Fade that this camera draws fades against it. Without a depth texture,
  the edge is hard.
- External texture slots take either a whole `Texture` or a region of one (`FXExternalTexture`,
  `FXTextureRegion`). `fxAtlasRegion` builds the region of a packed atlas sprite from its frame
  values.
- Half-lit lighting for effects.
- Distance-based emission: a play's rate can count per unit of distance its emitter moves instead of
  per second (`FXEmissionBasis`).
- `FX_RUNTIME_VERSION`. Every exported effect records the runtime it was built for, and in
  development it warns once when played on an incompatible runtime.

## 0.12.0 - 2026-11-09

### Added

- Death reactions: a particle's death can spawn on another emitter, from the dying particle's
  position and velocity. `FXEmitter.onParticleDeath` lets a game listen too.
- Spawn origins (`FXSpawnOrigin`): a burst or a play can spawn from a given point instead of the
  emitter's pose.

### Changed

- **Breaking:** re-export every effect.

## 0.11.1 - 2026-11-08

### Added

- Effects can scale their color by an intensity, in linear light, in every blend mode and without
  changing alpha.
- A `"step"` key easing.

### Fixed

- During playback, transform tracks are sampled at the continuous time rather than snapped to the
  frame grid. Anything reading an object's velocity no longer sees a still pose followed by a jump.
- World-matrix reads in an effect's fragment stage compile.

## 0.11.0 - 2026-11-08

### Added

- Particle trails: an emitter can keep a history of its particles' positions and draw them as a
  ribbon. A trail past the device's attribute or varying limits is skipped with a warning.
- `FXEmitter.particleOverflowCount`.

### Changed

- **Breaking:** emitters have a fixed capacity on every path. The default is 256, and
  `capacityStep` is removed.

## 0.10.0 - 2026-11-06

### Changed

- Published to npm's `latest` tag as the stable line.

## 0.9.5 - 2026-11-06

### Added

- Play-once playback: `FXEffect.play({ loop })`, a `loop` flag in the spec, and a `"finished"` event
  (`FXEffectEventMap`).
- Key easing curves (`FXKeyEase`: `linear`, `in`, `out`, `inOut`).

### Changed

- More effects fit the device's limits: GPU simulation captures every particle property in one
  buffer, and properties only the vertex stage reads take no varyings.

## 0.9.4 - 2026-11-06

### Fixed

- An emitter falls back to CPU simulation when the GPU has too few transform-feedback outputs for
  it. Before, it spawned nothing, without an error.

## 0.9.3 - 2026-11-06

### Fixed

- Each GPU burst spawns from its own pose.
- A looping timeline wraps seamlessly.

### Changed

- Published under npm's `experimental` tag.

## 0.9.2 - 2026-07-22

### Added

- GPU simulation on WebGL2: an emitter whose effect was exported with it simulates on the GPU when a
  `renderer` is given, and on the CPU otherwise.

### Changed

- **Breaking:** re-export every effect.

## 0.9.1 - 2026-07-17

### Changed

- `FXWorld.registerObject` and `unregisterObject` replace the emitter-only registration methods.

## 0.9.0 - 2026-07-17

Rewrite. sparcoon is now the runtime for effects authored in the Sparcoon Editor: the editor
compiles node graphs into effects, and the runtime plays them. It no longer builds graphs, compiles
shaders or ships its own nodes.

### Added

- `FXEffect`, the base class of an exported effect. It plays emitters, meshes, transforms and a
  timeline, and offers `play`, `stop`, `advanceFrame`, `getEmitter`, `getMesh`, `setEmitterParam`,
  `setMeshParam` and `dispose`.
- `FXWorld`, the tick domain. One `FXWorld.update(deltaTime)` per frame drives every effect.
- Unlit and Lambert materials, with the `blending`, `alphaHash`, `alphaTest` and `opaque` render
  modes.

### Removed

- The previous library: hand-built behaviors, spawners, materials, nodes, `FXColor`, `FXCurve1D`
  and texture views.

## 0.7.3 and earlier

The previous library, which assembled effects from behaviors, spawners and material nodes at run
time. It is not compatible with 0.9.0 and later.

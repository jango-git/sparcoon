# Changelog

Every notable change to sparcoon, as it affects a game playing effects exported from the
[Sparcoon Editor](https://jango-git.github.io/sparcoon-editor/). Versions follow semver; while the
major is 0, a minor release may change what an exported effect is made of, and an effect plays only
on the minor it was built for - after such an update, re-export every effect.

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

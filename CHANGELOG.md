# Changelog

Every notable change to sparcoon. Versions follow semver; while the major is 0, a minor release may
break the artifact format, and an exported effect module plays only on the minor it was built for.

The `sparcoon/editor` entry is tooling for the Sparcoon Editor and carries no semver guarantees;
its changes are listed only where they explain a change to the runtime.

## 0.16.0 - 2026-11-11

### Changed

- **Breaking:** the JS backend keeps each particle in one interleaved slot, like the GPU backend.
  A JS behavior artifact is now `{ buffers, bindings, spawn(slots, ...), update(slots, ...) }`
  over that slot. Every exported effect must be re-exported.
- A particle mesh binds only the fields its render reads, so more effects fit WebGL1's attribute
  limit on the JS path. Swapping a render artifact remounts the views over the same particle
  state, with no re-upload.

### Added

- `FX_CORE_BUFFERS`, the buffers every particle has.
- `sparcoon/editor`: `slotLayout`, `FXSlotLayout` and `FXSlotField`, the slot layout the editor
  bakes a JS kernel's offsets from.

### Removed

- `FXKernelBuffers` and the per-buffer write lists of the JS behavior artifact.
- `sparcoon/editor`: `unpackedAttributes`.

## 0.15.0 - 2026-11-11

### Added

- `maxLifetime` per emitter in the effect spec. An emitter settles by itself once that long has
  passed since its last birth, with nothing scheduled and its trail faded out. `FXEmitter.isSettled`
  reports it.
- `FXEffect` dispatches `"drained"` after `"finished"` once every emitter has settled, so a host can
  return the effect to a pool without keeping its own tail timings.

### Changed

- GPU passes defer three's `resetState()`. `FXWorld.update` and `prewarm` flush it once per
  renderer per tick, instead of once after every pass.

## 0.14.2 - 2026-11-11

### Added

- `FXEffect.compile(renderer, camera, scene?)` precompiles an effect's shaders. It uses
  `compileAsync` on three r158+ and a synchronous `renderer.compile` on r157.

### Changed

- Emitters on one WebGL context share their linked transform-feedback kernel programs.
- `stop()` and `reset()` clear an emitter's GPU particles. An idle emitter runs no transform-feedback
  pass and issues no draw call until its next birth.

## 0.14.1 - 2026-11-11

### Added

- `fxSeedHash1` to `fxSeedHash4`, the seed hash behind the editor's Hash node.

### Fixed

- `FX_RUNTIME_VERSION` now matches the version in `package.json`.

## 0.14.0 - 2026-11-11

### Added

- A behavior's update can kill a particle. A killed particle reports its death to death listeners
  and reactions, the same way a particle that dies of age does.
- Fractal (`fxFractal1`-`3`), curl (`fxCurl2`, `fxCurl3`) and Voronoi (`fxVoronoi2`, `fxVoronoi3`)
  noise.

### Changed

- Noise moves into its own module. Its existing functions keep their names and are still exported
  from the main entry.

## 0.13.0 - 2026-11-10

### Added

- Depth Fade: `fxSetCameraDepth(camera, texture)` gives a camera the depth of the scene it sees, and
  every graph using Depth Fade that this camera draws fades against it. Without a depth texture,
  the edge is hard.
- External texture slots take either a whole `Texture` or a region of one (`FXExternalTexture`,
  `FXTextureRegion`). `fxAtlasRegion` builds the region of a packed atlas sprite from its frame
  values.
- Half-lit lighting intrinsics for lighting nodes.
- Distance-based emission: a play's rate can count per unit of distance moved instead of per second
  (`FXEmissionBasis`).
- `FX_RUNTIME_VERSION`. Every exported effect spec records the runtime it was built for
  (`runtime`), and in development an effect warns once if it is played on an incompatible runtime.

## 0.12.0 - 2026-11-09

### Added

- Death reactions: a particle's death can spawn on another emitter, from the dying particle's
  position and velocity. They are listed as `reactions` in the effect spec, and
  `FXEmitter.onParticleDeath` exposes them for hosts.
- Spawn origins (`FXSpawnOrigin`) for plays and bursts.

### Changed

- **Breaking:** timeline events are spawn actions (`FXSpawnAction`), shared by the runtime and the
  editor's preview, instead of `{ kind: "play", ... }` records.
- **Breaking:** the surface frame is built only for the builtins the fragment stage reads, and graph
  varyings travel as one structured list. Per-primitive values are `flat` on GLSL ES 3.00
  (`FX_FLAT`).
- The render budget counts varyings the way the editor's compiler packs them (`sparcoon/editor`:
  `fxGraphVaryingAllowance`, `fxVaryingShape`, `packedVaryingVectors`).

## 0.11.1 - 2026-11-08

### Added

- An `intensity` output slot: a multiplier on the color alone, in linear light. It applies in every
  blend mode and never changes the alpha.
- A `"step"` key easing.

### Fixed

- During playback, transform tracks are sampled at the continuous time rather than snapped to the
  frame grid. Anything reading an object's velocity no longer sees a still pose followed by a jump.
- `modelMatrix` is declared in fragment shaders, so fragment-stage world-matrix reads compile.

## 0.11.0 - 2026-11-08

### Added

- Particle trails: an emitter can keep a history of its particles' positions and draw them as a
  ribbon (`trail` in the effect spec, `FXTrailOptions`, `FX_TRAIL_MAX_FRAMES`). A trail that exceeds
  the device's attribute or varying limits is skipped with a warning.
- `FXEmitter.particleOverflowCount`.
- `sparcoon/editor`: the attribute packing rule (`packingOrder`, `packConsecutive`) and
  `fxTrailRenderBudget`. The editor uses the same rule, so a kernel's slot and the views bound over
  it agree by construction.

### Changed

- **Breaking:** emitters have a fixed capacity on every path. The default is 256, and
  `capacityStep` is removed.
- Moved to eslint 10 and typescript-eslint 8.72 (development only).

## 0.10.0 - 2026-11-06

### Changed

- Published to npm's `latest` tag as the stable line. The experimental notes are gone.

## 0.9.5 - 2026-11-06

### Added

- Play-once playback: `FXEffect.play({ loop })`, a `loop` flag in the spec, and a `"finished"` event
  (`FXEffectEventMap`).
- Key easing curves (`FXKeyEase`: `linear`, `in`, `out`, `inOut`).
- `sparcoon/editor`: `fxEmitterRenderBudget`, `fxMeshRenderBudget` and
  `FX_RENDER_BUDGET_MINIMUMS`. They count the vertex attributes and varyings an artifact takes
  against the minimum each GPU tier guarantees, so the editor can refuse an effect that some GPUs
  could not draw.

### Changed

- Transform feedback is captured interleaved.
- Particle properties that the fragment stage never reads no longer take varyings.

## 0.9.4 - 2026-11-06

### Fixed

- An emitter falls back to its JS kernel when the GPU has too few transform-feedback outputs for its
  buffers. Before, it spawned nothing, without an error.

## 0.9.3 - 2026-11-06

### Fixed

- Each GPU burst spawns from its own pose.
- A looping timeline wraps seamlessly.

### Changed

- Published under npm's `experimental` tag.

## 0.9.2 - 2026-07-22

### Added

- A WebGL2 transform-feedback simulation path. An emitter with a GPU kernel artifact
  (`gpuBehavior`) simulates on the GPU when a `renderer` is given, and on its JS kernel otherwise.
- `FXEmitter.applyRenderArtifact`.

### Changed

- **Breaking:** render artifacts are given per GLSL tier (`FXRenderArtifactsByGLSLTier`).
- `fxNoise1`-`3` and `fxFbm3` replace `fxSnoise2`, `fxSnoise3` and `fxValueNoise`. `fxHash` is
  removed.

## 0.9.1 - 2026-07-17

### Added

- The `sparcoon/editor` entry: `FXEmitter`, `FXMesh` (a VFX mesh built from a render artifact and
  driven by `FXWorld`) and the keyframe sampling functions that the editor's live preview shares
  with the runtime.

### Changed

- `FXWorld.registerObject` and `unregisterObject` replace the emitter-only registration methods.

## 0.9.0 - 2026-07-17

Rewrite. sparcoon is now the runtime for effects authored in the
[Sparcoon Editor](https://jango-git.github.io/sparcoon-editor/). The editor compiles node graphs
into artifacts (simulation kernels and render shaders), and the runtime plays them. It no longer
builds graphs, compiles shaders or ships its own nodes.

### Added

- `FXEffect`, the base class of an exported effect module. It plays an `FXEffectSpec` (emitters,
  meshes, transforms and timeline) and offers `play`, `stop`, `advanceFrame`, `getEmitter`,
  `getMesh`, `setEmitterParam`, `setMeshParam` and `dispose`.
- `FXWorld`, the tick domain. One `FXWorld.update(deltaTime)` per frame drives every effect.
- The artifact contracts that the editor emits (`FXBehaviorArtifact`, `FXRenderArtifact`) and the
  core particle layout (`position`, `lifecycle`).
- Unlit and Lambert graph materials, with the `blending`, `alphaHash`, `alphaTest` and `opaque`
  render modes.
- The math and noise helpers that kernels call (`fxMath`), and `fxDataTexture`.

### Removed

- The previous library: hand-built behaviors, spawners, materials, nodes, `FXColor`, `FXCurve1D`
  and texture views.

## 0.7.3 and earlier

The previous library, which assembled effects from behaviors, spawners and material nodes at run
time. It is not compatible with 0.9.0 and later.

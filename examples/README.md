# Examples

The editor's presets played by the runtime alone, without the editor:
[jango-git.github.io/sparcoon](https://jango-git.github.io/sparcoon/).

```sh
npm install
npm run dev
```

- `effects/` holds the modules the editor exported, and `public/media/` their textures and meshes,
  from the editor's **Export zip**. Effects that use the same file share one copy.
- `src/catalog.ts` lists the effects with the file each of their assets is loaded from. The
  Lightning Crack moves along a path in the editor's preview only, so here the page moves it, as a
  game would.
- `src/studio.ts` holds the lights and the ground, and `src/depthPass.ts` the depth that soft
  particles and collisions with the scene read (see [Scene depth](../README.md#scene-depth)).
- `src/showcase.ts` loads an effect, compiles it ahead and swaps it in for the one before.
- The examples install sparcoon from npm at the version in `package.json`. After a minor release of
  the runtime, export the effects again with the editor of that version and raise it.

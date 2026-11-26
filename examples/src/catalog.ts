import { Vector3 } from "three";
import type { FXEffect, FXEffectOptions } from "sparcoon";

import type { Media } from "./media";
import type { View } from "./viewRig";

export interface Example {
  /** The page's hash (`#portal`) that opens the effect. */
  readonly id: string;
  readonly title: string;
  /** What the effect shows of the runtime, as in the README's gallery. */
  readonly tags: string;
  readonly view: View;
  /** The scene the effect plays in, from `public/media/scenes`, as in the editor's preset: what it
   *  collides with, falls on and is lit against. Without one it plays over the studio ground or,
   *  with `ground` false, over nothing. */
  readonly scene?: string;
  /** Whether the effect stands on the studio ground, when it has no scene. */
  readonly ground: boolean;
  /** Whether the effect reads the scene depth (Depth Fade or Depth Sample), which the page then
   *  renders each frame. */
  readonly depth: boolean;
  /** The effect's position at a time of its timeline, for an effect that the game moves. */
  readonly path?: (time: number) => Vector3;
  /** Loads the effect's module and assets. The page fetches only the effects a visitor opens. */
  readonly load: (media: Media) => Promise<(options: FXEffectOptions) => FXEffect>;
}

type EffectClass<Assets> = new (assets: Assets, options?: FXEffectOptions) => FXEffect;

/** An example of an exported effect, with the file each of its assets is loaded from. */
function example<Assets>(
  entry: Omit<Example, "load"> & {
    readonly module: () => Promise<EffectClass<Assets>>;
    readonly assets: { readonly [Name in keyof Assets]: string };
  },
): Example {
  const { module, assets, ...rest } = entry;
  return {
    ...rest,
    load: async (media) => {
      const [Effect, loaded] = await Promise.all([module(), media.load(assets)]);
      return (options) => new Effect(loaded as Assets, options);
    },
  };
}

/** The track the Lightning Crack runs along in the editor's preview, as (x, z) every 0.4 s of its
 *  16 s lap, back to where it started. */
const CRACK_TRACK: readonly (readonly [number, number])[] = [
  [-5, 1.5],
  [-4.329, 1.046],
  [-3.783, 0.427],
  [-3.221, -0.177],
  [-2.523, -0.597],
  [-1.748, -0.368],
  [-1.105, 0.149],
  [-0.479, 0.688],
  [0.224, 1.117],
  [0.952, 1.508],
  [1.693, 1.872],
  [2.472, 2.142],
  [3.291, 2.165],
  [4.064, 1.884],
  [4.759, 1.439],
  [5.351, 0.866],
  [5.611, 0.099],
  [5.503, -0.718],
  [5.342, -1.528],
  [5.182, -2.337],
  [4.877, -3.101],
  [4.226, -3.578],
  [3.413, -3.711],
  [2.588, -3.69],
  [1.782, -3.526],
  [1.119, -3.04],
  [0.477, -2.524],
  [-0.315, -2.481],
  [-1.0, -2.938],
  [-1.65, -3.447],
  [-2.394, -3.789],
  [-3.21, -3.708],
  [-3.985, -3.426],
  [-4.711, -3.032],
  [-5.37, -2.537],
  [-5.901, -1.906],
  [-6.273, -1.172],
  [-6.396, -0.362],
  [-6.15, 0.423],
  [-5.699, 1.111],
  [-5, 1.5],
];
const CRACK_STEP = 0.4;

/** The Lightning Crack's position at `time`, linear between the track's points, looped. */
function crackPosition(time: number): Vector3 {
  const lap = (CRACK_TRACK.length - 1) * CRACK_STEP;
  const at = (((time % lap) + lap) % lap) / CRACK_STEP;
  const index = Math.min(Math.floor(at), CRACK_TRACK.length - 2);
  const [x0, z0] = CRACK_TRACK[index]!;
  const [x1, z1] = CRACK_TRACK[index + 1]!;
  const u = at - index;
  return new Vector3(x0 + (x1 - x0) * u, 0, z0 + (z1 - z0) * u);
}

export const EXAMPLES: readonly Example[] = [
  example({
    id: "campfire",
    title: "Campfire",
    tags: "flipbook, Half-Lit, SDF collision",
    module: async () => (await import("../effects/Campfire")).Campfire,
    assets: {
      tFire: "T_Fire.webp",
      tGlow: "T_Glow.webp",
      tSmoke: "T_Smoke.webp",
      tSmokeLight: "T_SmokeLight.webp",
      "CampCollider SDF": "CampCollider SDF 125x85x128.png",
    },
    view: { position: [-2.1, 1, 3.637], target: [0, 1.5, 0], fov: 54 },
    scene: "scenes/Camp.glb",
    ground: false,
    depth: true,
  }),
  example({
    id: "lightning-crack",
    title: "Lightning Crack",
    tags: "mesh particles, shadows, soft particles",
    module: async () => (await import("../effects/LightningCrack")).LightningCrack,
    assets: {
      tGlow: "T_Glow.webp",
      tLightning: "T_Lightning.webp",
      tSmoke: "T_Smoke.webp",
      tSmokeLight: "T_SmokeLight.webp",
      CrackSegment: "CrackSegment.glb",
      Rock: "Rock.glb",
    },
    view: { position: [-1.835, 8.28, 9.054], target: [-0.261, 1.2, 0.13], fov: 45 },
    scene: "scenes/Wasteland.glb",
    ground: false,
    depth: true,
    path: crackPosition,
  }),
  example({
    id: "portal",
    title: "Portal",
    tags: "vortex, soft particles, mesh particles",
    module: async () => (await import("../effects/Portal")).Portal,
    assets: {
      tGlow: "T_Glow.webp",
      tGrit: "T_Grit.webp",
      tLightning: "T_Lightning.webp",
      tRunes: "T_Runes.webp",
      tSmoke: "T_Smoke.webp",
      ChunkA: "ChunkA.glb",
      ChunkC: "ChunkC.glb",
    },
    view: { position: [2.87, 2.3, 7.89], target: [0, 1.3, 0], fov: 42 },
    ground: true,
    depth: true,
  }),
  example({
    id: "shield",
    title: "Energy Shield",
    tags: "sphere collision, death reactions, trails",
    module: async () => (await import("../effects/EnergyShield")).EnergyShield,
    assets: {
      tGlow: "T_Glow.webp",
      tSmoke: "T_Smoke.webp",
      tHexDome: "T_HexDome.webp",
      tHexDomeCells: "T_HexDomeCells.webp",
      Strikes: "Strikes.glb",
      Dome: "Dome.glb",
    },
    view: { position: [-2.9, 6.199, 7.969], target: [0, 0.9, 0], fov: 44 },
    scene: "scenes/Outpost.glb",
    ground: false,
    depth: true,
  }),
  example({
    id: "fireworks",
    title: "Fireworks",
    tags: "chained reactions, inherited color, trails",
    module: async () => (await import("../effects/Fireworks")).Fireworks,
    assets: { tGlow: "T_Glow.webp", tSmoke: "T_Smoke.webp" },
    view: { position: [0, 6.2, 25], target: [0, 6.6, -1], fov: 47 },
    ground: false,
    depth: false,
  }),
  example({
    id: "destruction",
    title: "Destruction",
    tags: "mesh particles, shadows, lighting, collisions",
    module: async () => (await import("../effects/Destruction")).Destruction,
    assets: {
      tGlow: "T_Glow.webp",
      tSmoke: "T_Smoke.webp",
      tWaveFront: "T_WaveFront.png",
      ChunkA: "ChunkA.glb",
      ChunkB: "ChunkB.glb",
      ChunkC: "ChunkC.glb",
      Pillar: "Pillar.glb",
      Rock: "Rock.glb",
      "RuinsCollider SDF": "RuinsCollider SDF 128x46x100.png",
    },
    view: { position: [-4.908, 7.27, 0.983], target: [0.433, 0.348, -0.087], fov: 50 },
    scene: "scenes/Ruins.glb",
    ground: false,
    depth: true,
  }),
  example({
    id: "fireflies",
    title: "Fireflies",
    tags: "spawn on a mesh, curl noise, SDF avoidance",
    module: async () => (await import("../effects/Fireflies")).Fireflies,
    assets: {
      tGlow: "T_Glow.webp",
      MossRock: "MossRock.glb",
      "GroveCollider SDF": "GroveCollider SDF 128x72x128.png",
    },
    view: { position: [-0.812, 13.331, 3.581], target: [0.095, 0.495, -1.333], fov: 20 },
    scene: "scenes/Grove.glb",
    ground: false,
    depth: false,
  }),
  example({
    id: "sparks",
    title: "Sparks",
    tags: "GPU simulation, scene depth collision, shadows",
    module: async () => (await import("../effects/Sparks")).Sparks,
    assets: {},
    view: { position: [-1.736, 2.246, 0.609], target: [0.846, 1.101, -0.638], fov: 50 },
    scene: "scenes/Site.glb",
    ground: false,
    depth: true,
  }),
];

import { CatmullRomCurve3, Vector3 } from "three";
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
  /** Whether the effect stands on a ground: what its shadows and debris fall on. */
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

/** The track the Lightning Crack runs along in the editor's preview, sampled once a second. */
const crackCurve = new CatmullRomCurve3(
  [
    [-6, 0, 1.5],
    [-4.753, 0, 0.096],
    [-3.323, 0, -1.104],
    [-1.642, 0, -0.568],
    [-0.225, 0, 0.663],
    [1.389, 0, 1.622],
    [3.179, 0, 1.946],
    [4.678, 0, 0.834],
    [6, 0, -0.5],
  ].map(([x, y, z]) => new Vector3(x, y, z)),
);
const CRACK_DURATION = 8;

export const EXAMPLES: readonly Example[] = [
  example({
    id: "campfire",
    title: "Campfire",
    tags: "flipbook, Half-Lit, ground collision",
    module: async () => (await import("../effects/Campfire")).Campfire,
    assets: {
      tFire: "T_Fire.webp",
      tGlow: "T_Glow.webp",
      tSmoke: "T_Smoke.webp",
      tSmokeLight: "T_SmokeLight.webp",
    },
    view: { position: [0, 1.5, 4.2], target: [0, 1.35, 0], fov: 50 },
    ground: false,
    depth: false,
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
    view: { position: [-1.2, 2.4, 9.5], target: [-1, 2.2, 0], fov: 45 },
    ground: true,
    depth: true,
    path: (time) => crackCurve.getPoint((time % CRACK_DURATION) / CRACK_DURATION),
  }),
  example({
    id: "portal",
    title: "Portal",
    tags: "vortex, soft particles",
    module: async () => (await import("../effects/Portal")).Portal,
    assets: {
      tGlow: "T_Glow.webp",
      tLightning: "T_Lightning.webp",
      tRunes: "T_Runes.webp",
      tSmoke: "T_Smoke.webp",
    },
    view: { position: [0, 2.3, 8.4], target: [0, 1.3, 0], fov: 42 },
    ground: false,
    depth: true,
  }),
  example({
    id: "shield",
    title: "Energy Shield",
    tags: "sphere collision, death reactions, trails",
    module: async () => (await import("../effects/EnergyShield")).EnergyShield,
    assets: {
      tGlow: "T_Glow.webp",
      tHexDome: "T_HexDome.webp",
      tHexDomeCells: "T_HexDomeCells.webp",
      Dome: "Dome.glb",
    },
    view: { position: [0, 2.6, 8.2], target: [0, 1, 0], fov: 38 },
    ground: false,
    depth: false,
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
      ChunkA: "ChunkA.glb",
      ChunkB: "ChunkB.glb",
      ChunkC: "ChunkC.glb",
      Pillar: "Pillar.glb",
      Rock: "Rock.glb",
    },
    view: { position: [5.5, 3.2, 8.5], target: [0, 1, 0], fov: 42 },
    ground: true,
    depth: true,
  }),
  example({
    id: "fireflies",
    title: "Fireflies",
    tags: "spawn on a mesh, curl noise",
    module: async () => (await import("../effects/Fireflies")).Fireflies,
    assets: { tGlow: "T_Glow.webp", MossRock: "MossRock.glb" },
    view: { position: [0, 1.8, 4.3], target: [0, 1.25, 0], fov: 50 },
    ground: true,
    depth: false,
  }),
  example({
    id: "sparks",
    title: "Sparks",
    tags: "GPU simulation, collision, shadows",
    module: async () => (await import("../effects/Sparks")).Sparks,
    assets: {},
    view: { position: [0, 1.3, 5.2], target: [0, 1, 0], fov: 45 },
    ground: false,
    depth: false,
  }),
];

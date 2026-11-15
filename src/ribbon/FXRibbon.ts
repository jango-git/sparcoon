import type { Mesh } from "three";

import type { FXRenderArtifact } from "../artifact/FXArtifact.js";
import { FXArtifactMaterial } from "../render/FXArtifactMaterial.js";
import type { FXExternalTexture } from "../render/FXExternalTexture.js";
import type { FXRenderBudget } from "../render/FXRenderBudget.js";
import { createRibbonUniforms } from "../render/FXStripMaterial.Internal.js";
import { type FXParticleStrip, type FXStripFrame, FXStripMesh } from "../strip/FXStrip.Internal.js";
import type { FXRibbonPoints } from "./FXRibbonPoints.Internal.js";

/**
 * How `p_uv.x` runs along a ribbon, from its newest particle to its oldest:
 * - `"stretch"`: each point's age over its lifetime, 0 at birth and 1 at death;
 * - `"tile"`: one repeat (1 -> 0) every `particles` particles.
 */
export type FXRibbonUV =
  { readonly mode: "stretch" } | { readonly mode: "tile"; readonly particles: number };

/**
 * A ribbon through an emitter's particles in the order they were born: its render artifact
 * (compiled against the editor's ribbon target) and how `p_uv.x` runs along it.
 */
export interface FXRibbonOptions {
  readonly render: FXRenderArtifact;
  /** default `{ mode: "stretch" }` */
  readonly uv?: FXRibbonUV;
  /**
   * While a play emits from the emitter's pose, extend the ribbon from its newest particle to the
   * particle a birth would seed now - computed by the behavior's spawn every tick, so it follows
   * the spawn's shape and randomness. default false
   */
  readonly head?: boolean;
}

/** Particles per repeat of `p_uv.x` for `options`, 0 for none. */
export function ribbonTileOf(options: FXRibbonOptions): number {
  return options.uv?.mode === "tile" ? options.uv.particles : 0;
}

/**
 * Validates the ribbon options in every build: a ribbon is built once, so the check costs nothing
 * per frame.
 */
export function assertValidRibbonOptions(options: FXRibbonOptions, context: string): void {
  if (options.head !== undefined && typeof options.head !== "boolean") {
    throw new TypeError(`${context}.head: expected a boolean`);
  }
  const uv = options.uv;
  if (uv === undefined || uv.mode === "stretch") {
    return;
  }
  if ((uv.mode as string) !== "tile") {
    throw new Error(`${context}.uv.mode: expected "stretch" or "tile"`);
  }
  if (!Number.isInteger(uv.particles) || uv.particles < 1) {
    throw new RangeError(
      `${context}.uv.particles: expected an integer >= 1, got ${String(uv.particles)}`,
    );
  }
}

/**
 * @internal The ribbon of one emitter: a single instanced draw of a segment from every point to the
 * next over its {@link FXRibbonPoints} - its particles in birth order, then its head. Owned by an `FXEmitter`, which records after
 * every tick. Unlike a trail it keeps no past: it shows the particles alive now, and goes with
 * them.
 *
 * Drawn after the emitter's particles (and its trail) at the same depth, as a trail is.
 */
export class FXRibbon implements FXParticleStrip {
  private readonly strip: FXStripMesh;

  /** @param options - Valid (see {@link assertValidRibbonOptions}). */
  constructor(
    private readonly points: FXRibbonPoints,
    options: FXRibbonOptions,
    textures: Readonly<Record<string, FXExternalTexture>> = {},
  ) {
    const material = new FXArtifactMaterial(options.render, textures);
    this.strip = new FXStripMesh(
      "FXRibbon",
      material,
      material.buildThreeRibbonMaterial(points.layout, createRibbonUniforms(ribbonTileOf(options))),
      (geometry) => {
        points.mount(geometry);
      },
    );
  }

  public get mesh(): Mesh {
    return this.strip.mesh;
  }

  public get budget(): FXRenderBudget {
    return this.strip.budget;
  }

  public get artifactMaterial(): FXArtifactMaterial {
    return this.strip.material;
  }

  public record(frame: FXStripFrame): void {
    this.points.record(frame);
    this.strip.segments = this.points.segments;
  }

  public reset(): void {
    this.points.clear();
    this.strip.segments = 0;
  }

  // It draws only the particles alive now.
  public fadedBy(): boolean {
    return true;
  }

  public destroy(): void {
    this.strip.destroy();
    this.points.destroy();
  }
}

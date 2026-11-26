import type { Mesh, Object3D } from "three";

import type { FXEmitter } from "../emitter/FXEmitter.js";
import type { FXEmitterDriver } from "../emitter/FXEmitterDriver.Internal.js";
import type { FXArtifactMaterial } from "../render/FXArtifactMaterial.js";
import type { FXExternalTexture } from "../render/FXExternalTexture.js";
import { fxBudgetOverruns, type FXRenderBudget } from "../render/FXRenderBudget.js";
import {
  assertValidRibbonOptions,
  FXRibbon,
  ribbonSectionOf,
  ribbonTileOf,
} from "../ribbon/FXRibbon.js";
import { assertValidTrailOptions, FXTrail } from "../trail/FXTrail.js";
import type { FXParticleStrip, FXStripFrame } from "./FXStrip.Internal.js";
import { stripReadFields } from "./FXStripLayout.Internal.js";
import { FX_STRIP_KINDS, type FXStripKind, type FXStripOptions } from "./FXStripOptions.js";

type FXTextures = Readonly<Record<string, FXExternalTexture>>;

/** How each kind of strip is checked and built over an emitter's driver. */
const STRIP_KINDS: {
  readonly [K in FXStripKind]: {
    readonly assertValid: (options: FXStripOptions[K], context: string) => void;
    readonly build: (
      driver: FXEmitterDriver,
      options: FXStripOptions[K],
      textures: FXTextures,
    ) => FXParticleStrip;
  };
} = {
  trail: {
    assertValid: assertValidTrailOptions,
    build: (driver, options, textures) => {
      const history = driver.createTrailHistory(stripReadFields(options.render), options.frames);
      try {
        return new FXTrail(history, options, textures);
      } catch (error) {
        history.destroy();
        throw error;
      }
    },
  },
  ribbon: {
    assertValid: assertValidRibbonOptions,
    build: (driver, options, textures) => {
      const points = driver.createRibbonPoints(stripReadFields(options.render), {
        tile: ribbonTileOf(options),
        section: ribbonSectionOf(options),
        head: options.head === true,
      });
      try {
        return new FXRibbon(points, options, textures);
      } catch (error) {
        points.destroy();
        throw error;
      }
    },
  },
};

/** Each emitter's strips, for {@link fxEmitterStripMesh}; weak, so it never keeps an emitter alive. */
const STRIPS_BY_OWNER = new WeakMap<Object3D, FXEmitterStrips>();

/**
 * Editor tooling: the mesh `emitter` draws its strip of `kind` with, if it draws one. Not part of
 * the game's API, where an emitter's meshes are the runtime's own.
 */
export function fxEmitterStripMesh(emitter: FXEmitter, kind: FXStripKind): Mesh | undefined {
  return STRIPS_BY_OWNER.get(emitter)?.mesh(kind);
}

/**
 * @internal The strips an emitter draws through its particles - at most one of each kind - and
 * what building one takes: its driver, and the GPU's limits a strip's material is checked against
 * (a strip past them is skipped, with a warning once per kind). Each strip's mesh is a child of
 * `owner`, added in {@link FX_STRIP_KINDS} order after the particles.
 */
export class FXEmitterStrips {
  private readonly strips: { [K in FXStripKind]?: FXParticleStrip } = {};
  private readonly warned = new Set<FXStripKind>();

  constructor(
    private readonly owner: Object3D,
    private readonly driver: FXEmitterDriver,
    private readonly limits: FXRenderBudget | undefined,
  ) {
    STRIPS_BY_OWNER.set(owner, this);
  }

  /** Every strip that draws, in draw order. */
  public get all(): readonly FXParticleStrip[] {
    return FX_STRIP_KINDS.flatMap((kind) => this.strips[kind] ?? []);
  }

  /** Whether a strip of `kind` draws: given and not skipped past the GPU's limits. */
  public has(kind: FXStripKind): boolean {
    return this.strips[kind] !== undefined;
  }

  /** The mesh of the strip of `kind`, if one draws. */
  public mesh(kind: FXStripKind): Mesh | undefined {
    return this.strips[kind]?.mesh;
  }

  /** The material of the strip of `kind`, if one draws. */
  public material(kind: FXStripKind): FXArtifactMaterial | undefined {
    return this.strips[kind]?.artifactMaterial;
  }

  /**
   * Replaces the strip of `kind` with one built from `options`, or removes it (`undefined`).
   * `prepare` readies the new strip's material before it replaces the current one.
   * @throws When `options` are invalid or the new strip cannot be built or prepared; the current
   *   strip is then left in place.
   */
  public replace<K extends FXStripKind>(
    kind: K,
    options: FXStripOptions[K] | undefined,
    textures: FXTextures,
    prepare: (strip: FXParticleStrip) => void = (): void => undefined,
  ): void {
    let next: FXParticleStrip | undefined;
    if (options !== undefined) {
      const strip = STRIP_KINDS[kind];
      strip.assertValid(options, `FXEmitter.${kind}`);
      next = this.withinLimits(kind, strip.build(this.driver, options, textures));
      try {
        if (next !== undefined) {
          prepare(next);
        }
      } catch (error) {
        next?.destroy();
        throw error;
      }
    }
    this.strips[kind]?.destroy();
    this.strips[kind] = next;
    if (next !== undefined) {
      // After the particles and every strip drawn before it.
      this.owner.add(next.mesh);
      for (const later of FX_STRIP_KINDS.slice(FX_STRIP_KINDS.indexOf(kind) + 1)) {
        const mesh = this.strips[later]?.mesh;
        if (mesh !== undefined) {
          this.owner.add(mesh);
        }
      }
    }
  }

  public record(frame: FXStripFrame): void {
    for (const strip of this.all) {
      strip.record(frame);
    }
  }

  public reset(): void {
    for (const strip of this.all) {
      strip.reset();
    }
  }

  /** Whether no strip draws anything from before the last particle died, `sinceDeath` ago. */
  public fadedBy(sinceDeath: number): boolean {
    return this.all.every((strip) => strip.fadedBy(sinceDeath));
  }

  public destroy(): void {
    for (const kind of FX_STRIP_KINDS) {
      this.strips[kind]?.destroy();
      delete this.strips[kind];
    }
  }

  /**
   * `strip`, or `undefined` (destroyed, with a warning once per kind) when its material takes
   * more of any resource than the limits - attributes, varying vectors, uniform vectors or texture
   * units of a stage: a program past them fails to link, so it would never draw anyway, and the
   * particles still do without it.
   */
  private withinLimits(kind: FXStripKind, strip: FXParticleStrip): FXParticleStrip | undefined {
    const overruns = this.limits === undefined ? [] : fxBudgetOverruns(strip.budget, this.limits);
    if (overruns.length === 0) {
      return strip;
    }
    strip.destroy();
    if (!this.warned.has(kind)) {
      this.warned.add(kind);
      const needs = overruns.map(
        (overrun) =>
          `${String(overrun.used)} ${overrun.resource} (the GPU offers ${String(overrun.limit)})`,
      );
      console.warn(`FXEmitter: the ${kind} is skipped - its material needs ${needs.join(", ")}.`);
    }
    return undefined;
  }
}

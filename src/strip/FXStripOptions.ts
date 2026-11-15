import type { FXRibbonOptions } from "../ribbon/FXRibbon.js";
import type { FXTrailOptions } from "../trail/FXTrail.js";

/**
 * The options of each kind of strip an emitter can draw through its particles, beside them: a
 * trail behind every particle, and a ribbon through them in the order they were born. An emitter
 * draws at most one of each.
 */
export interface FXStripOptions {
  readonly trail: FXTrailOptions;
  readonly ribbon: FXRibbonOptions;
}

export type FXStripKind = keyof FXStripOptions;

/** Every kind of strip, in the order an emitter draws them, after its particles. */
export const FX_STRIP_KINDS: readonly FXStripKind[] = ["trail", "ribbon"];

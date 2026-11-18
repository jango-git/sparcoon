import type { FXGLSLRenderTier } from "../../src/artifact/FXArtifact.js";

/**
 * One GLSL helper as `src/helpers/glsl.ts` declares it: the constant `name`, its `source`, and the
 * helpers it calls on each tier that links it. A tier missing from `requires` does not link it.
 */
export interface FXGLSLHelperDefinition {
  readonly name: string;
  readonly source: string;
  readonly requires: Partial<Record<FXGLSLRenderTier, readonly FXGLSLHelperDefinition[]>>;
}

/** Linked by both tiers, with the same dependencies on each. */
export function everyTier(
  requires: readonly FXGLSLHelperDefinition[] = [],
): FXGLSLHelperDefinition["requires"] {
  return { baseline: requires, standard: requires };
}

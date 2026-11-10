import { warnInDevelopment } from "../miscellaneous/asserts.js";
import { FX_RUNTIME_VERSION } from "../version.js";
import type { FXEffectSpec } from "./FXEffectSpec.js";

interface FXVersion {
  readonly major: number;
  readonly minor: number;
}

/** `major.minor` of a `major.minor.patch` version (the patch and any suffix ignored); undefined
 *  when it is not one. */
function parseVersion(version: unknown): FXVersion | undefined {
  const match = typeof version === "string" ? /^(\d+)\.(\d+)\.\d+/.exec(version) : null;
  return match === null ? undefined : { major: Number(match[1]), minor: Number(match[2]) };
}

/**
 * Whether a module built against `built` plays on `runtime`. A patch is a fix, never a format
 * change, so either side may be on any patch. Below 1.0 a minor is breaking, so it must match;
 * from 1.0 the major must match and the runtime's minor be no older (it may lack a newer feature).
 */
function isCompatible(runtime: FXVersion, built: FXVersion): boolean {
  if (runtime.major !== built.major) {
    return false;
  }
  return built.major === 0 ? runtime.minor === built.minor : runtime.minor >= built.minor;
}

// Specs already checked: an effect module is instantiated many times, warned about once.
const checkedSpecifications = new WeakSet<FXEffectSpec>();

/**
 * Warns (development builds only, once per module) when an effect module was compiled against a
 * runtime this one is not compatible with (see {@link isCompatible}) - or by an editor that predates
 * the stamp. A warning, not a throw: a mismatched module often still plays.
 */
export function checkRuntimeVersion(specification: FXEffectSpec): void {
  if (checkedSpecifications.has(specification)) {
    return;
  }
  checkedSpecifications.add(specification);
  const runtime = parseVersion(FX_RUNTIME_VERSION);
  const built = parseVersion(specification.runtime);
  if (runtime !== undefined && built !== undefined && isCompatible(runtime, built)) {
    return;
  }
  const builtAgainst =
    built === undefined ? "an unknown sparcoon version" : `sparcoon ${specification.runtime}`;
  warnInDevelopment(
    `sparcoon: an effect module was built against ${builtAgainst}, this is ${FX_RUNTIME_VERSION} - ` +
      "re-export it from a matching editor",
  );
}

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FXEffectSpec } from "../../src/effect/FXEffectSpec";
import { checkRuntimeVersion } from "../../src/effect/FXRuntimeVersion.Internal";
import { FX_RUNTIME_VERSION } from "../../src/version";
import { FXWorld } from "../../src/world/FXWorld";
import { effectSpec, TestEffect } from "../helpers/effectSpecs";

const packageVersion = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

/** This runtime's version with one part replaced. */
function shifted(part: 0 | 1 | 2, delta: number): string {
  const parts = FX_RUNTIME_VERSION.split(".").map(Number);
  parts[part] += delta;
  return parts.join(".");
}

/** Whether a module built against `runtime` warns here (each call checks a fresh spec). */
function warns(runtime: unknown): boolean {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  checkRuntimeVersion({ ...effectSpec(), runtime } as FXEffectSpec);
  const warned = warn.mock.calls.length > 0;
  warn.mockRestore();
  return warned;
}

describe("runtime version", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("matches package.json", () => {
    expect(FX_RUNTIME_VERSION).toBe(packageVersion);
  });

  it("accepts a module of this minor on any patch, older or newer", () => {
    expect(warns(FX_RUNTIME_VERSION)).toBe(false);
    expect(warns(`${FX_RUNTIME_VERSION}-beta.1`)).toBe(false);
    expect(warns(shifted(2, 1))).toBe(false);
    expect(warns(shifted(2, 7))).toBe(false);
    if (Number(FX_RUNTIME_VERSION.split(".")[2]) > 0) {
      expect(warns(shifted(2, -1))).toBe(false);
    }
  });

  it("warns on another minor below 1.0, another major, or no stamp at all", () => {
    expect(warns(shifted(1, 1))).toBe(true);
    expect(warns(shifted(1, -1))).toBe(true);
    expect(warns(shifted(0, 1))).toBe(true);
    expect(warns(undefined)).toBe(true); // exported before the stamp
    expect(warns("garbage")).toBe(true);
  });

  it("names both versions, once per module however many effects it builds", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const world = new FXWorld();
    const specification = effectSpec({ runtime: "0.1.0" });
    try {
      new TestEffect(specification, { world }).dispose();
      new TestEffect(specification, { world }).dispose();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("built against sparcoon 0.1.0");
      expect(warn.mock.calls[0][0]).toContain(`this is ${FX_RUNTIME_VERSION}`);
    } finally {
      world.dispose();
    }
  });
});

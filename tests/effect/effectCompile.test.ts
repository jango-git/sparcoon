import { afterEach, describe, expect, it, vi } from "vitest";
import { PerspectiveCamera, Scene, type WebGLRenderer } from "three";
import { FXWorld } from "../../src/world/FXWorld";
import { effectSpec, emitterSpec, TestEffect } from "../helpers/effectSpecs";

const camera = new PerspectiveCamera();

// A world per test, disposed after it, so no effect outlives its test.
const worlds: FXWorld[] = [];

afterEach(() => {
  for (const world of worlds.splice(0)) {
    world.dispose();
  }
});

function effect(): TestEffect {
  const world = new FXWorld();
  worlds.push(world);
  return new TestEffect(effectSpec({ emitters: [emitterSpec("sparks")] }), { world });
}

describe("FXEffect.compile", () => {
  it("awaits compileAsync for the effect alone, lit by the given scene", async () => {
    let finish = (): void => undefined;
    const compileAsync = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const renderer = { compile: vi.fn(), compileAsync } as unknown as WebGLRenderer;
    const target = effect();
    const scene = new Scene();

    let done = false;
    const compiled = target.compile(renderer, camera, scene).then(() => {
      done = true;
    });
    expect(compileAsync).toHaveBeenCalledWith(target, camera, scene);
    await Promise.resolve();
    expect(done).toBe(false);

    finish();
    await compiled;
    expect(done).toBe(true);
    expect(renderer.compile).not.toHaveBeenCalled();
  });

  it("lights the effect by itself without a scene", async () => {
    const compileAsync = vi.fn(() => Promise.resolve());
    const target = effect();
    await target.compile({ compileAsync } as unknown as WebGLRenderer, camera);
    expect(compileAsync).toHaveBeenCalledWith(target, camera, null);
  });

  it("compiles the whole scene synchronously on three r157", async () => {
    const compile = vi.fn();
    const scene = new Scene();
    await effect().compile({ compile } as unknown as WebGLRenderer, camera, scene);
    expect(compile).toHaveBeenCalledWith(scene, camera);
  });

  it("compiles nothing once disposed", async () => {
    const compileAsync = vi.fn(() => Promise.resolve());
    const target = effect();
    target.dispose();
    await target.compile({ compileAsync } as unknown as WebGLRenderer, camera);
    expect(compileAsync).not.toHaveBeenCalled();
  });
});

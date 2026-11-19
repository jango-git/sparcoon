import { PerspectiveCamera, Scene, type WebGLRenderer } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FXParticleKernelArtifact } from "../../src/artifact/FXArtifact";
import { FXWorld } from "../../src/world/FXWorld";
import { effectSpec, emitterSpec, TestEffect } from "../helpers/effectSpecs";
import { callsNamed, type MockRenderer, mockRenderer } from "../helpers/mockWebGL";

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

const KERNEL: FXParticleKernelArtifact = {
  vertexSource: "#version 300 es\nvoid main(){}",
  fragmentSource: "#version 300 es\nvoid main(){}",
  buffers: [
    { name: "position", stride: 3 },
    { name: "lifecycle", stride: 3 },
  ],
  transformFeedbackVaryings: ["out_position", "out_lifecycle"],
  bindings: {},
};

/** An effect simulating one emitter on the GPU of `mock`. */
function gpuEffect(mock: MockRenderer): TestEffect {
  const world = new FXWorld();
  worlds.push(world);
  const target = new TestEffect(
    effectSpec({ emitters: [emitterSpec("sparks", { gpuBehavior: KERNEL })] }),
    { world, renderer: mock.renderer },
  );
  expect(target.getEmitter("sparks")?.simulationPrograms).toHaveLength(1);
  return target;
}

describe("FXEffect.compile", () => {
  it("waits for the GPU simulation's build as well as for three's programs", async () => {
    vi.useFakeTimers();
    try {
      const mock = mockRenderer({ parallelShaderCompile: true });
      const target = gpuEffect(mock);
      let done = false;
      void target
        .compile(
          {
            isWebGLRenderer: true,
            compileAsync: () => Promise.resolve(),
          } as unknown as WebGLRenderer,
          camera,
        )
        .then(() => {
          done = true;
        });
      await vi.advanceTimersByTimeAsync(50);
      expect(done).toBe(false);
      mock.gl.finishBuilds();
      await vi.advanceTimersByTimeAsync(20);
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends the GPU simulation off to build when the effect is created, without waiting for it", () => {
    const mock = mockRenderer({ parallelShaderCompile: true });
    gpuEffect(mock);
    expect(callsNamed(mock.gl, "linkProgram")).toHaveLength(1);
    expect(callsNamed(mock.gl, "getProgramParameter")).toEqual([]);
    expect(callsNamed(mock.gl, "getUniformLocation")).toEqual([]);
  });

  it("without KHR_parallel_shader_compile, simulationReady waits for the build in a timer, not in the call", async () => {
    const mock = mockRenderer();
    const target = gpuEffect(mock);
    const ready = target.simulationReady();
    expect(callsNamed(mock.gl, "getProgramParameter")).toEqual([]);
    await ready;
    expect(callsNamed(mock.gl, "getProgramParameter").length).toBeGreaterThan(0);
  });

  it("resolves simulationReady at once for an effect simulated on the CPU", async () => {
    await effect().simulationReady();
  });

  it("awaits compileAsync for the effect alone, lit by the given scene", async () => {
    let finish = (): void => undefined;
    const compileAsync = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const renderer = {
      isWebGLRenderer: true,
      compile: vi.fn(),
      compileAsync,
    } as unknown as WebGLRenderer;
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
    await target.compile(
      { isWebGLRenderer: true, compileAsync } as unknown as WebGLRenderer,
      camera,
    );
    expect(compileAsync).toHaveBeenCalledWith(target, camera, null);
  });

  it("compiles the whole scene synchronously on three r157", async () => {
    const compile = vi.fn();
    const scene = new Scene();
    await effect().compile(
      { isWebGLRenderer: true, compile } as unknown as WebGLRenderer,
      camera,
      scene,
    );
    expect(compile).toHaveBeenCalledWith(scene, camera);
  });

  it("compiles nothing once disposed", async () => {
    const compileAsync = vi.fn(() => Promise.resolve());
    const target = effect();
    target.dispose();
    await target.compile(
      { isWebGLRenderer: true, compileAsync } as unknown as WebGLRenderer,
      camera,
    );
    expect(compileAsync).not.toHaveBeenCalled();
  });
});

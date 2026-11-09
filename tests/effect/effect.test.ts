import { afterEach, describe, expect, it } from "vitest";
import { Group, PerspectiveCamera, Texture, type ShaderMaterial } from "three";
import { FXWorld } from "../../src/world/FXWorld";
import { buildPrimitiveGeometry } from "../../src/instancedParticle/primitiveGeometry";
import type {
  FXEffectEmitterSpec,
  FXEffectReaction,
  FXEffectSpec,
} from "../../src/effect/FXEffectSpec";
import type { FXRenderArtifact } from "../../src/artifact/FXArtifact";
import { behaviorArtifact, renderForBothTargets, unlitArtifact } from "../helpers/artifacts";
import { effectSpec, emitterSpec as baseEmitterSpec, TestEffect } from "../helpers/effectSpecs";
import { emitterVelocityOf, particlesOf, registeredObjectCount } from "../helpers/internals";

type EmitterOverrides = Partial<Omit<FXEffectEmitterSpec, "render">> & {
  render?: FXRenderArtifact;
};

/** An emitter rendering `over.render` (flat white by default) for both render targets. */
function emitterSpec(name: string, over: EmitterOverrides = {}): FXEffectEmitterSpec {
  const { render, ...rest } = over;
  return baseEmitterSpec(name, {
    ...rest,
    ...(render === undefined ? {} : { render: renderForBothTargets(render) }),
  });
}

/** A render declaring a float `u_param_size`, baked at 0. */
function sizeRender(): FXRenderArtifact {
  return unlitArtifact({
    uniformDeclarations: ["uniform float u_param_size;"],
    uniforms: { u_param_size: { type: "float", value: 0 } },
  });
}

// Each test gets its own world; disposing it between tests frees the effects and their emitters, so
// no live state bleeds across tests.
const worlds: FXWorld[] = [];

function newWorld(): FXWorld {
  const world = new FXWorld();
  worlds.push(world);
  return world;
}

function makeEffect(world: FXWorld, specification: FXEffectSpec): TestEffect {
  return new TestEffect(specification, { world });
}

afterEach(() => {
  for (const world of worlds.splice(0)) {
    world.dispose();
  }
});

describe("FXEffect lookup", () => {
  it("returns emitters by name and undefined for an unknown name", () => {
    const world = newWorld();
    const effect = makeEffect(
      world,
      effectSpec({ emitters: [emitterSpec("a"), emitterSpec("b")] }),
    );
    expect(effect.getEmitter("a")).toBeDefined();
    expect(effect.getEmitter("b")).toBeDefined();
    expect(effect.getEmitter("missing")).toBeUndefined();
    expect(effect.getMesh("missing")).toBeUndefined();
  });
});

describe("FXEffect timeline events", () => {
  it("fires a burst event as the playhead crosses its time", () => {
    const world = newWorld();
    const effect = makeEffect(
      world,
      effectSpec({
        emitters: [emitterSpec("e", { events: [{ kind: "burst", time: 0.5, count: 10 }] })],
      }),
    );
    effect.play();
    expect(effect.getEmitter("e")!.particleCount).toBe(0); // burst is at t=0.5, not yet reached
    world.update(1); // advances 0 -> 1, crossing t=0.5
    expect(effect.getEmitter("e")!.particleCount).toBe(10);
  });

  it("emits continuously for a play event", () => {
    const world = newWorld();
    const effect = makeEffect(
      world,
      effectSpec({
        emitters: [
          emitterSpec("e", { events: [{ kind: "play", time: 0, rate: 100, duration: 0 }] }),
        ],
      }),
    );
    effect.play();
    world.update(0.1); // 100/s for 0.1s
    expect(effect.getEmitter("e")!.particleCount).toBeGreaterThan(0);
  });

  it("ignores a zero-count burst and a zero-rate play (degenerate authored events)", () => {
    const world = newWorld();
    const effect = makeEffect(
      world,
      effectSpec({
        emitters: [
          emitterSpec("e", {
            events: [
              { kind: "burst", time: 0.2, count: 0 },
              { kind: "play", time: 0.3, rate: 0, duration: 0 },
            ],
          }),
        ],
      }),
    );
    effect.play();
    world.update(1);
    expect(effect.getEmitter("e")!.particleCount).toBe(0);
  });
});

describe("FXEffect transport", () => {
  it("does not advance while stopped", () => {
    const world = newWorld();
    const effect = makeEffect(
      world,
      effectSpec({
        emitters: [emitterSpec("e", { events: [{ kind: "burst", time: 0.5, count: 5 }] })],
      }),
    );
    // Never played: the world tick must not fire the burst.
    world.update(1);
    expect(effect.getEmitter("e")!.particleCount).toBe(0);
  });

  it("stop() clears live particles and freezes at frame 0", () => {
    const world = newWorld();
    const effect = makeEffect(
      world,
      effectSpec({
        emitters: [emitterSpec("e", { events: [{ kind: "burst", time: 0.5, count: 8 }] })],
      }),
    );
    effect.play();
    world.update(1);
    expect(effect.getEmitter("e")!.particleCount).toBe(8);

    effect.stop();
    expect(effect.getEmitter("e")!.particleCount).toBe(0);
    world.update(1); // frozen: nothing spawns
    expect(effect.getEmitter("e")!.particleCount).toBe(0);
  });

  it("loops seamlessly: live particles run on across the seam, and the timeline replays", () => {
    const world = newWorld();
    const effect = makeEffect(
      world,
      effectSpec({
        duration: 1,
        emitters: [emitterSpec("e", { events: [{ kind: "burst", time: 0.5, count: 5 }] })],
      }),
    );
    effect.play();
    world.update(0.6); // crosses t=0.5 -> 5 particles
    expect(effect.getEmitter("e")!.particleCount).toBe(5);

    world.update(0.6); // now = 1.2 -> wrap, remainder 0.2 (before the burst): nothing cleared
    expect(effect.getEmitter("e")!.particleCount).toBe(5);

    world.update(0.4); // 0.2 -> 0.6 crosses t=0.5 again -> the burst replays on top
    expect(effect.getEmitter("e")!.particleCount).toBe(10);

    effect.stop(); // an explicit stop still clears
    expect(effect.getEmitter("e")!.particleCount).toBe(0);
  });

  it("reads no velocity from the pose jumping back at the seam", () => {
    // Moves 0 -> 10 along X over the lap, then jumps back to 0 on the wrap.
    const world = newWorld();
    const effect = makeEffect(
      world,
      effectSpec({
        duration: 1,
        emitters: [
          emitterSpec("e", {
            transformTracks: [
              {
                channel: "position",
                keys: [
                  { time: 0, value: [0, 0, 0] },
                  { time: 1, value: [10, 0, 0] },
                ],
              },
            ],
          }),
        ],
      }),
    );
    const velocityX = (): number => emitterVelocityOf(effect.getEmitter("e")!)[0];
    effect.play();
    world.update(0.5);
    world.update(0.25); // moving at about +10/s (poses are frame-quantized)
    expect(velocityX()).toBeGreaterThan(5);

    world.update(0.5); // wraps: 10 -> 0 in one step, which is no motion
    expect(Math.abs(velocityX())).toBeLessThan(1e-6);
  });

  it("fires the events of a lap's tail in the update that wraps past it", () => {
    const world = newWorld();
    const effect = makeEffect(
      world,
      effectSpec({
        duration: 1,
        emitters: [emitterSpec("e", { events: [{ kind: "burst", time: 0.95, count: 3 }] })],
      }),
    );
    effect.play();
    world.update(0.9);
    world.update(0.2); // 0.9 -> 1.1: the burst at 0.95 fires, then the wrap keeps it
    expect(effect.getEmitter("e")!.particleCount).toBe(3);
  });
});

describe("FXEffect parameter drive", () => {
  it("drives a value track onto a declared uniform", () => {
    const world = newWorld();
    const render = sizeRender();
    const effect = makeEffect(
      world,
      effectSpec({
        emitters: [
          emitterSpec("e", {
            render,
            tracks: [
              {
                name: "size",
                keys: [
                  { time: 0, value: 1 },
                  { time: 1, value: 5 },
                ],
              },
            ],
          }),
        ],
      }),
    );
    effect.play(); // driveFrame(0) samples size = 1
    expect(render.uniforms["u_param_size"].value).toBe(1);
    world.update(0.5); // frame-stepped: size = 3 at t=0.5
    expect(render.uniforms["u_param_size"].value).toBeCloseTo(3, 6);
  });

  it("leaves every slot alone for an unknown emitter, mesh or parameter", () => {
    const world = newWorld();
    const render = sizeRender();
    const effect = makeEffect(world, effectSpec({ emitters: [emitterSpec("e", { render })] }));
    effect.setEmitterParam("missing", "size", 2);
    effect.setMeshParam("missing", "size", 2);
    effect.setEmitterParam("e", "missing", 2);
    expect(render.uniforms["u_param_size"].value).toBe(0);
  });
});

describe("FXEffect emitter construction", () => {
  it("hands an emitter with a sortInterval the camera, sorting one frame in sortInterval", () => {
    const world = newWorld();
    const camera = new PerspectiveCamera();
    const effect = new TestEffect(
      effectSpec({
        emitters: [emitterSpec("sorted", { sortInterval: 4 }), emitterSpec("unsorted")],
      }),
      { world, camera },
    );
    expect(effect.getEmitter("sorted")!.sortCamera).toBe(camera);
    expect(effect.getEmitter("sorted")!.sortFraction).toBe(0.25);
    expect(effect.getEmitter("unsorted")!.sortCamera).toBeUndefined();
  });

  it("resolves an emitter's external texture and custom geometry from the effect's assets", () => {
    const world = newWorld();
    const flame = new Texture();
    const rock = buildPrimitiveGeometry("sphere");
    // An asset named in `externalSlots` binds the external slot `u_param_<name>`; a custom
    // geometry is looked up by its own name.
    const render: FXRenderArtifact = {
      ...unlitArtifact({
        uniformDeclarations: ["uniform sampler2D u_param_flame;"],
        uniforms: { u_param_flame: { type: "sampler2D", external: "u_param_flame" } },
      }),
      geometry: { type: "custom", external: "rock" },
    };
    const effect = new TestEffect(
      effectSpec({ emitters: [emitterSpec("e", { render, externalSlots: ["flame"] })] }),
      { world },
      { flame, rock },
    );
    const mesh = particlesOf(effect.getEmitter("e")!);
    expect((mesh.material as ShaderMaterial).uniforms["u_param_flame"].value).toBe(flame);
    // The instanced geometry takes the custom geometry's vertices.
    expect(mesh.geometry.getAttribute("position").count).toBe(rock.getAttribute("position").count);
  });
});

describe("FXEffect dispose", () => {
  it("empties from its parent, drops its emitters, and leaves an inert effect", () => {
    const world = newWorld();
    const parent = new Group();
    const render = sizeRender();
    const effect = makeEffect(
      world,
      effectSpec({
        duration: 1,
        loop: false,
        emitters: [emitterSpec("e", { render, events: [{ kind: "burst", time: 0, count: 3 }] })],
      }),
    );
    parent.add(effect);
    const emitter = effect.getEmitter("e")!;
    let finished = 0;
    effect.addEventListener("finished", () => {
      finished += 1;
    });

    effect.dispose();
    effect.dispose();
    expect(parent.children).not.toContain(effect);
    expect(effect.getEmitter("e")).toBeUndefined();
    expect(emitter.parent).toBeNull();
    expect(registeredObjectCount(world)).toBe(0);

    // Unregistered: nothing plays, drives or finishes any more.
    effect.play();
    effect.setEmitterParam("e", "size", 2);
    world.update(2);
    expect(emitter.particleCount).toBe(0);
    expect(render.uniforms["u_param_size"].value).toBe(0);
    expect(finished).toBe(0);
  });
});

describe("FXEffect event order", () => {
  it("fires a frame's bursts after posing the emitter for that frame", () => {
    // A burst spawns from the pose it is called with, so the frame's pose must be in place first:
    // otherwise an animated emitter bursts from where the previous frame left it.
    const world = newWorld();
    const effect = makeEffect(
      world,
      effectSpec({
        duration: 2,
        fps: 30,
        emitters: [
          emitterSpec("e", {
            transformTracks: [
              {
                channel: "position",
                keys: [
                  { time: 0, value: [0, 0, 0] },
                  { time: 1, value: [10, 0, 0] },
                ],
              },
            ],
            events: [{ kind: "burst", time: 0.5, count: 1 }],
          }),
        ],
      }),
    );
    const emitter = effect.getEmitter("e")!;
    const burstPositions: number[] = [];
    const burst = emitter.burst.bind(emitter);
    emitter.burst = (...args: Parameters<typeof emitter.burst>): number => {
      burstPositions.push(emitter.position.x);
      return burst(...args);
    };

    effect.play();
    world.update(0.6); // frame 18 (t = 0.6): x = 6; the burst at 0.5 fires in this update.

    expect(burstPositions).toHaveLength(1);
    expect(burstPositions[0]).toBeCloseTo(6);
  });
});

describe("FXEffect transform drive", () => {
  function movingEffect(world: FXWorld) {
    return makeEffect(
      world,
      effectSpec({
        duration: 2,
        fps: 30,
        emitters: [
          emitterSpec("e", {
            transformTracks: [
              {
                channel: "position",
                keys: [
                  { time: 0, value: [0, 0, 0] },
                  { time: 1, value: [10, 0, 0] },
                ],
              },
            ],
          }),
        ],
      }),
    );
  }

  it("poses at the continuous time while playing, between two frames too", () => {
    // Updates faster than the fps grid: a pose held to the grid would stand still on every update
    // between two frames, which anything reading the emitter's velocity sees as no motion.
    const world = newWorld();
    const effect = movingEffect(world);
    const emitter = effect.getEmitter("e")!;
    effect.play();
    const positions: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      world.update(1 / 120);
      positions.push(emitter.position.x);
    }
    positions.forEach((x, i) => {
      expect(x).toBeCloseTo(((i + 1) / 120) * 10, 6);
    });
  });

  it("keeps value tracks on the fps grid", () => {
    const world = newWorld();
    const render = unlitArtifact({
      uniformDeclarations: ["uniform float u_param_size;"],
      uniforms: { u_param_size: { type: "float", value: 0 } },
    });
    const effect = makeEffect(
      world,
      effectSpec({
        fps: 30,
        emitters: [
          emitterSpec("e", {
            render,
            tracks: [
              {
                name: "size",
                keys: [
                  { time: 0, value: 0 },
                  { time: 1, value: 30 },
                ],
              },
            ],
          }),
        ],
      }),
    );
    effect.play();
    world.update(1 / 120); // still frame 0 (t = 1/120 rounds to 0)
    expect(render.uniforms["u_param_size"].value).toBe(0);
    world.update(1 / 40); // t = 1/30: frame 1
    expect(render.uniforms["u_param_size"].value).toBeCloseTo(1, 6);
  });
});

describe("FXEffect once-through playback", () => {
  function onceEffect(world: FXWorld, loop: boolean | undefined) {
    return makeEffect(
      world,
      effectSpec({
        duration: 1,
        ...(loop !== undefined ? { loop } : {}),
        emitters: [
          emitterSpec("e", {
            events: [
              { kind: "burst", time: 0.5, count: 5 },
              { kind: "burst", time: 0.95, count: 3 },
            ],
          }),
        ],
      }),
    );
  }

  it("plays an authored once-through timeline to its end, holds it and says so once", () => {
    const world = newWorld();
    const effect = onceEffect(world, false);
    let finished = 0;
    effect.addEventListener("finished", () => {
      finished += 1;
    });
    effect.play();
    world.update(0.6);
    expect(finished).toBe(0);
    world.update(0.6); // past the end: the tail burst at 0.95 fires, then the timeline holds
    expect(finished).toBe(1);
    expect(effect.getEmitter("e")!.particleCount).toBe(8);

    world.update(1); // held: nothing replays, nothing is cleared, no second event
    expect(effect.getEmitter("e")!.particleCount).toBe(8);
    expect(finished).toBe(1);
  });

  it("lets play() override the authored choice, both ways", () => {
    const world = newWorld();
    const looping = onceEffect(world, undefined); // no field: loops, as older modules do
    let finished = 0;
    looping.addEventListener("finished", () => {
      finished += 1;
    });
    looping.play({ loop: false });
    world.update(1.2);
    expect(finished).toBe(1);

    const once = onceEffect(world, false);
    once.addEventListener("finished", () => {
      finished += 1;
    });
    once.play({ loop: true });
    world.update(1.2);
    world.update(0.4); // 0.2 -> 0.6: the burst at 0.5 replays on the next lap
    expect(finished).toBe(1);
    expect(once.getEmitter("e")!.particleCount).toBe(13);
  });

  it("starts over on the next play()", () => {
    const world = newWorld();
    const effect = onceEffect(world, false);
    let finished = 0;
    effect.addEventListener("finished", () => {
      finished += 1;
    });
    effect.play();
    world.update(1.2);
    effect.play();
    expect(effect.getEmitter("e")!.particleCount).toBe(0);
    world.update(0.6);
    expect(effect.getEmitter("e")!.particleCount).toBe(5);
    world.update(0.6);
    expect(finished).toBe(2);
  });
});

describe("FXEffect death reactions", () => {
  function shellAndSparks(reaction: FXEffectReaction): FXEffectSpec {
    return effectSpec({
      duration: 10,
      emitters: [
        {
          ...emitterSpec("shell", { events: [{ kind: "burst", time: 0, count: 1 }] }),
          behavior: behaviorArtifact({ lifetime: 0.15 }),
        },
        emitterSpec("sparks", { reactions: [reaction] }),
      ],
    });
  }

  it("spawns on the reacting emitter one tick after each death of the source's particles", () => {
    const world = newWorld();
    const effect = makeEffect(world, shellAndSparks({ source: 0, kind: "burst", count: 4 }));
    effect.play();
    world.update(0.1); // the shell is born
    world.update(0.1);
    world.update(0.1); // it dies
    expect(effect.getEmitter("sparks")!.particleCount).toBe(0);
    world.update(0.1);
    expect(effect.getEmitter("sparks")!.particleCount).toBe(4);
  });

  it("refuses a bad reaction before building anything", () => {
    const world = newWorld();
    expect(() => makeEffect(world, shellAndSparks({ source: 5, kind: "burst", count: 4 }))).toThrow(
      /does not exist/,
    );
    expect(() =>
      makeEffect(world, shellAndSparks({ source: 0, kind: "play", rate: 4, duration: 0 })),
    ).toThrow(/finite duration/);
    expect(registeredObjectCount(world)).toBe(0);
  });
});

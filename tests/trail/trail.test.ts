import type { InterleavedBufferAttribute, ShaderMaterial, WebGLRenderer } from "three";
import { PerspectiveCamera, Texture } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  FXAttributeDecl,
  FXParticleKernelArtifact,
  FXRenderArtifact,
} from "../../src/artifact/FXArtifact";
import { FX_CORE_LIFECYCLE, FX_CORE_POSITION } from "../../src/coreLayout";
import type { FXEffectSpec } from "../../src/effect/FXEffectSpec";
import { FXEmitter } from "../../src/emitter/FXEmitter";
import { FXJSEmitterDriver } from "../../src/emitter/FXJSEmitterDriver.Internal";
import { FX_RENDER_BUDGET_MINIMUMS, fxTrailRenderBudget } from "../../src/render/FXRenderBudget";
import type { FXTrailOptions } from "../../src/trail/FXTrail";
import { FXWorld } from "../../src/world/FXWorld";
import { behaviorArtifact, renderForBothTargets, unlitArtifact } from "../helpers/artifacts";
import { effectSpec, emitterSpec, TestEffect } from "../helpers/effectSpecs";
import {
  bindingValue,
  driveEmitterValues,
  landBirths,
  particlesOf,
  tickEmitter,
  trailOf,
} from "../helpers/internals";
import { callsNamed, mockRenderer } from "../helpers/mockWebGL";
import { behaviorSlot } from "../helpers/slots";
import { clearRanges, pendingRanges } from "../helpers/uploadRanges";

const GLSL_FLOAT_TYPES = ["float", "vec2", "vec3", "vec4"];

/** An unlit trail render declaring `attributeReads` and reading every one in its vertex stage. */
function reading(attributeReads: readonly FXAttributeDecl[]): FXRenderArtifact {
  return unlitArtifact({
    attributeReads,
    vertexBody: attributeReads.map(
      ({ name, components }) => `${GLSL_FLOAT_TYPES[components - 1]} read_${name} = p_fx_${name};`,
    ),
  });
}

/** Each update moves every particle +1 along x. */
function movingBehavior(lifetime = 10): ReturnType<typeof behaviorArtifact> {
  return behaviorArtifact({
    lifetime,
    update(fields, count): void {
      const position = fields[FX_CORE_POSITION];
      for (let i = 0; i < count; i++) {
        position[i * 3] += 1;
      }
    },
  });
}

function trailOptions(over: Partial<FXTrailOptions> = {}): FXTrailOptions {
  return { render: unlitArtifact(), frames: 4, sampleInterval: 0.1, ...over };
}

function cpuEmitter(
  trail: FXTrailOptions = trailOptions(),
  capacity = 2,
  behavior = movingBehavior(),
): FXEmitter {
  return FXEmitter.fromArtifacts(unlitArtifact(), behavior, { expectedCapacity: capacity, trail });
}

/** History point (frame, slot) of `emitter`'s trail: its position x, id tag, tangent x, time. */
function point(
  emitter: FXEmitter,
  frame: number,
  slot: number,
): { x: number; tag: number; tangentX: number; time: number } {
  const { array, stride } = trailOf(emitter).history;
  const capacity = particlesOf(emitter).instanceCapacity;
  const base = (frame * capacity + slot) * stride;
  // The packed point: [x, y, z, id + 1 | 0], then [tangent x, y, z, time recorded].
  return { x: array[base], tag: array[base + 3], tangentX: array[base + 4], time: array[base + 7] };
}

describe("trail history - JS backend", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("draws frames x capacity segments once recorded, each reading two history frames of one buffer", () => {
    const emitter = cpuEmitter(trailOptions({ frames: 5 }), 3);
    try {
      expect(emitter.hasTrail).toBe(true);
      const { mesh } = trailOf(emitter);
      expect(mesh.parent).toBe(emitter);
      const geometry = mesh.geometry as unknown as {
        instanceCount: number;
        attributes: Record<string, unknown>;
      };
      expect(geometry.instanceCount).toBe(0);
      emitter.burst(1);
      tickEmitter(emitter, 0.1);
      expect(geometry.instanceCount).toBe(15);
      const a = geometry.attributes["a_tA_trailPoint"] as InterleavedBufferAttribute;
      const b = geometry.attributes["a_tB_trailPoint"] as InterleavedBufferAttribute;
      expect(a.data).toBe(b.data);
      // The end point is one whole frame (capacity * stride floats) further on.
      expect(b.offset - a.offset).toBe(3 * a.data.stride);
      // Five frames plus the mirror.
      expect(a.data.count).toBe(6 * 3);
      // The packed point and joint of each end, and the base quad's position - no uv or normal,
      // and no lifecycle: this trail does not read it.
      expect(Object.keys(geometry.attributes).sort()).toEqual([
        "a_tA_trailPoint",
        "a_tA_trailTangent",
        "a_tB_trailPoint",
        "a_tB_trailTangent",
        "position",
      ]);
    } finally {
      emitter.destroy();
    }
  });

  it("overwrites the head every tick and moves it on once per sample interval", () => {
    const emitter = cpuEmitter();
    try {
      emitter.burst(1);
      landBirths(emitter); // born before the tick, so the tick's update moves it
      tickEmitter(emitter, 0.04); // records frame 0
      expect(trailOf(emitter).uniforms.head.value).toBe(0);
      expect(point(emitter, 0, 0).x).toBe(1);

      tickEmitter(emitter, 0.04); // still frame 0, overwritten
      expect(trailOf(emitter).uniforms.head.value).toBe(0);
      expect(point(emitter, 0, 0).x).toBe(2);

      tickEmitter(emitter, 0.04); // 0.08 since the first record: still frame 0
      tickEmitter(emitter, 0.04); // 0.12: moves on to frame 1
      expect(trailOf(emitter).uniforms.head.value).toBe(1);
      expect(point(emitter, 0, 0).x).toBe(3); // frame 0 keeps its last state
      expect(point(emitter, 1, 0).x).toBe(4);
    } finally {
      emitter.destroy();
    }
  });

  it("mirrors frame 0 into the extra last frame while recording it", () => {
    const emitter = cpuEmitter(trailOptions({ frames: 2 }));
    try {
      emitter.burst(1);
      landBirths(emitter);
      tickEmitter(emitter, 0.1);
      tickEmitter(emitter, 0.1);
      tickEmitter(emitter, 0.1); // head 1 -> 0
      expect(trailOf(emitter).uniforms.head.value).toBe(0);
      expect(point(emitter, 2, 0)).toEqual(point(emitter, 0, 0));
      expect(point(emitter, 2, 0).x).toBe(3);
    } finally {
      emitter.destroy();
    }
  });

  it("uploads one contiguous range per tick: the head, the mirror at head 0, frames 0-1 on moving to 1", () => {
    const emitter = cpuEmitter(trailOptions({ frames: 3 }), 2);
    try {
      const { buffer, stride } = trailOf(emitter).history;
      const frame = 2 * stride;
      emitter.burst(2);
      clearRanges(buffer);
      tickEmitter(emitter, 0.01); // head 0: the mirror only
      expect(pendingRanges(buffer)).toEqual([{ start: 3 * frame, count: frame }]);
      clearRanges(buffer);
      tickEmitter(emitter, 0.1); // moves to 1: frames 0 and 1
      expect(pendingRanges(buffer)).toEqual([{ start: 0, count: 2 * frame }]);
      clearRanges(buffer);
      tickEmitter(emitter, 0.01); // head 1 again
      expect(pendingRanges(buffer)).toEqual([{ start: frame, count: frame }]);
    } finally {
      emitter.destroy();
    }
  });

  it("keeps a reused slot's old and new occupants apart by id", () => {
    const emitter = cpuEmitter(trailOptions({ frames: 4 }), 1, movingBehavior(0.15));
    try {
      emitter.burst(1);
      tickEmitter(emitter, 0.1);
      tickEmitter(emitter, 0.1); // dies (age 0.2 >= 0.15)
      emitter.burst(1); // reuses slot 0
      tickEmitter(emitter, 0.1);
      const first = point(emitter, 0, 0);
      const second = point(emitter, 2, 0);
      expect(first.tag).toBeGreaterThan(0);
      expect(second.tag).toBeGreaterThan(0);
      expect(first.tag).not.toBe(second.tag);
      // The new occupant's first point does not join the old one's path.
      expect(second.tangentX).toBe(0);
    } finally {
      emitter.destroy();
    }
  });

  it("gives each point the direction it arrived from, so both segments at it share a joint", () => {
    const emitter = cpuEmitter(trailOptions({ frames: 4, sampleInterval: 0.1 }));
    try {
      emitter.burst(1);
      tickEmitter(emitter, 0.1); // frame 0: x 1, the particle's first point
      tickEmitter(emitter, 0.1); // frame 1: x 2
      tickEmitter(emitter, 0.1); // frame 2: x 3
      expect(point(emitter, 0, 0).tangentX).toBe(0);
      expect(point(emitter, 1, 0).tangentX).toBe(1);
      expect(point(emitter, 2, 0).tangentX).toBe(1);
      expect(point(emitter, 2, 0).time).toBeCloseTo(0.3);
    } finally {
      emitter.destroy();
    }
  });

  it("marks a dead particle's point dead, and a never-written one reads dead too", () => {
    const emitter = cpuEmitter(trailOptions({ frames: 4 }), 2, movingBehavior(0.15));
    try {
      emitter.burst(1);
      landBirths(emitter);
      tickEmitter(emitter, 0.1);
      expect(point(emitter, 0, 1).tag).toBe(0); // slot 1 never claimed
      tickEmitter(emitter, 0.1); // dies
      expect(point(emitter, 1, 0).tag).toBe(0);
    } finally {
      emitter.destroy();
    }
  });

  it("uploads nothing while no particle was ever born", () => {
    const emitter = cpuEmitter(trailOptions({ frames: 3 }), 2);
    try {
      const { buffer } = trailOf(emitter).history;
      clearRanges(buffer);
      tickEmitter(emitter, 0.05);
      tickEmitter(emitter, 0.2);
      expect(pendingRanges(buffer)).toEqual([]);
    } finally {
      emitter.destroy();
    }
  });

  it("stretches the trail's span to the frame rate when samples are asked for faster", () => {
    const emitter = cpuEmitter(trailOptions({ frames: 5, sampleInterval: 0.001 }));
    try {
      emitter.burst(1);
      for (let i = 0; i < 40; i++) {
        tickEmitter(emitter, 1 / 60);
      }
      expect(trailOf(emitter).uniforms.span.value).toBeCloseTo(4 / 60, 3);
    } finally {
      emitter.destroy();
    }
  });

  it("forgets the whole path on reset()", () => {
    const emitter = cpuEmitter();
    try {
      emitter.burst(2);
      tickEmitter(emitter, 0.2);
      tickEmitter(emitter, 0.2);
      emitter.reset();
      expect(trailOf(emitter).history.array.every((value) => value === 0)).toBe(true);
      expect(trailOf(emitter).uniforms.head.value).toBe(0);
    } finally {
      emitter.destroy();
    }
  });

  it("restarts the measured sample gap and the span on reset()", () => {
    const emitter = cpuEmitter(trailOptions({ frames: 5, sampleInterval: 0.001 }));
    try {
      const trail = trailOf(emitter);
      emitter.burst(1);
      for (let i = 0; i < 40; i++) {
        tickEmitter(emitter, 1 / 60);
      }
      expect(trail.uniforms.span.value).toBeCloseTo(4 / 60, 3);
      emitter.reset();
      expect(trail.advanceGap).toBe(0.001);
      expect(trail.uniforms.span.value).toBeCloseTo(4 * 0.001, 9);
      expect(trail.uniforms.tail.value).toBe(0);
      // Ticks run again from a clean state.
      emitter.burst(1);
      tickEmitter(emitter, 1 / 60);
      tickEmitter(emitter, 1 / 60);
      expect(point(emitter, 1, 0).tag).toBeGreaterThan(0);
    } finally {
      emitter.destroy();
    }
  });

  it("rejects a zero sample interval or a fractional frame count in every build", () => {
    expect(() => cpuEmitter(trailOptions({ sampleInterval: 0 }))).toThrow(RangeError);
    expect(() => cpuEmitter(trailOptions({ sampleInterval: Number.NaN }))).toThrow(RangeError);
    expect(() => cpuEmitter(trailOptions({ frames: 2.5 }))).toThrow(RangeError);
  });

  it("draws the trail after the particles, however it was attached", () => {
    const built = cpuEmitter();
    const swapped = FXEmitter.fromArtifacts(unlitArtifact(), movingBehavior(), {
      expectedCapacity: 2,
    });
    try {
      swapped.applyTrailArtifact(trailOptions());
      for (const emitter of [built, swapped]) {
        expect(emitter.children).toEqual([particlesOf(emitter), trailOf(emitter).mesh]);
        expect(trailOf(emitter).mesh.id).toBeGreaterThan(particlesOf(emitter).id);
      }
    } finally {
      built.destroy();
      swapped.destroy();
    }
  });

  it("releases the driver when the trail fails to build in fromArtifacts", () => {
    const destroy = vi.spyOn(FXJSEmitterDriver.prototype, "destroy");
    const lit = { ...unlitArtifact(), lightingIntrinsics: ["fxLambertShade"] };
    expect(() => cpuEmitter(trailOptions({ render: lit }))).toThrow(/unlit/);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("keeps the current trail when a replacement fails to build", () => {
    const emitter = cpuEmitter();
    try {
      emitter.burst(1);
      tickEmitter(emitter, 0.1);
      const before = trailOf(emitter);
      const lit = { ...unlitArtifact(), lightingIntrinsics: ["fxLambertShade"] };
      expect(() => {
        emitter.applyTrailArtifact(trailOptions({ render: lit }));
      }).toThrow(/unlit/);
      expect(trailOf(emitter)).toBe(before);
      expect(before.mesh.parent).toBe(emitter);
      tickEmitter(emitter, 0.1);
      expect(point(emitter, 1, 0).tag).toBeGreaterThan(0);
    } finally {
      emitter.destroy();
    }
  });

  it("starts a swapped-in trail from the values applyValues drove, not its baked ones", () => {
    const glow = (): FXRenderArtifact["uniforms"] => ({
      u_param_glow: { type: "float", value: 0 },
    });
    const emitter = FXEmitter.fromArtifacts(unlitArtifact({ uniforms: glow() }), movingBehavior(), {
      trail: trailOptions({ render: unlitArtifact({ uniforms: glow() }) }),
    });
    try {
      emitter.applyValues({ uniforms: { u_param_glow: 0.75, u_param_other: 2 } });
      emitter.applyTrailArtifact(trailOptions({ render: unlitArtifact({ uniforms: glow() }) }));
      const material = trailOf(emitter).mesh.material as ShaderMaterial;
      expect(material.uniforms["u_param_glow"].value).toBe(0.75);
      // A name the new trail does not declare is not added to it.
      expect(material.uniforms["u_param_other"]).toBeUndefined();
    } finally {
      emitter.destroy();
    }
  });

  it("binds a swapped-in trail's external textures from the swap, not the values applied before", () => {
    const sampled = (): FXRenderArtifact =>
      unlitArtifact({
        uniformDeclarations: ["uniform sampler2D u_param_sheet;"],
        uniforms: { u_param_sheet: { type: "sampler2D", external: "u_param_sheet" } },
        outputs: { albedo: "fxSample_u_param_sheet(vec2(0.5))" },
      });
    const region = { texture: new Texture(), uvTransform: [1, 0, 0, 0, 1, 0] as const };
    const emitter = FXEmitter.fromArtifacts(sampled(), movingBehavior(), {
      textures: { u_param_sheet: region },
      trail: trailOptions({ render: sampled() }),
    });
    try {
      emitter.applyValues({
        uniforms: { u_param_sheet: { ...region, uvTransform: [0.5, 0, 0, 0, 0.5, 0] } },
      });
      // A whole texture now: the applied region is of a variant this slot cannot take.
      const sheet = new Texture();
      emitter.applyTrailArtifact(trailOptions({ render: sampled() }), { u_param_sheet: sheet });
      expect(
        (trailOf(emitter).mesh.material as ShaderMaterial).uniforms["u_param_sheet"].value,
      ).toBe(sheet);
    } finally {
      emitter.destroy();
    }
  });

  it("scrubs a material's own values into it alone, and never into a later swap", () => {
    // Both graphs named a value of their own `_0`: the same name, two different uniforms.
    const own = (): FXRenderArtifact =>
      unlitArtifact({
        uniformDeclarations: ["uniform float _0;"],
        uniforms: { _0: { type: "float", value: 0 } },
      });
    const emitter = FXEmitter.fromArtifacts(own(), movingBehavior(), {
      trail: trailOptions({ render: own() }),
    });
    try {
      emitter.applyValues({ particleMaterial: { _0: 1 }, trailMaterial: { _0: 2 } });
      const particles = particlesOf(emitter).material as ShaderMaterial;
      expect(particles.uniforms["_0"].value).toBe(1);
      expect((trailOf(emitter).mesh.material as ShaderMaterial).uniforms["_0"].value).toBe(2);
      emitter.applyTrailArtifact(trailOptions({ render: own() }));
      expect((trailOf(emitter).mesh.material as ShaderMaterial).uniforms["_0"].value).toBe(0);
    } finally {
      emitter.destroy();
    }
  });

  it("rejects an external texture edit one material cannot take, changing neither", () => {
    const sampled = (): FXRenderArtifact =>
      unlitArtifact({
        uniformDeclarations: ["uniform sampler2D u_param_sheet;"],
        uniforms: { u_param_sheet: { type: "sampler2D", external: "u_param_sheet" } },
        outputs: { albedo: "fxSample_u_param_sheet(vec2(0.5))" },
      });
    const sheet = new Texture();
    const region = { texture: new Texture(), uvTransform: [1, 0, 0, 0, 1, 0] as const };
    // The particles bind a region, the trail a whole texture: a region fits only the particles.
    const emitter = FXEmitter.fromArtifacts(sampled(), movingBehavior(), {
      textures: { u_param_sheet: region },
      trail: trailOptions({ render: sampled() }),
    });
    try {
      expect(() => emitter.applyTrailArtifact(trailOptions({ render: sampled() }), {})).toThrow(
        /no texture supplied/,
      );
      emitter.applyTrailArtifact(trailOptions({ render: sampled() }), { u_param_sheet: sheet });
      const particles = particlesOf(emitter).material as ShaderMaterial;
      const next = { texture: new Texture(), uvTransform: [0.5, 0, 0, 0, 0.5, 0] as const };
      expect(() => emitter.applyValues({ uniforms: { u_param_sheet: next } })).toThrow(
        /bound to a whole texture/,
      );
      expect(particles.uniforms["u_param_sheet"].value).toBe(region.texture);
      // Not kept for a later trail either: swapping one in still works.
      emitter.applyTrailArtifact(trailOptions({ render: sampled() }), { u_param_sheet: sheet });
      expect(
        (trailOf(emitter).mesh.material as ShaderMaterial).uniforms["u_param_sheet"].value,
      ).toBe(sheet);
    } finally {
      emitter.destroy();
    }
  });

  it("reports each frame's age since it was recorded", () => {
    const emitter = cpuEmitter(trailOptions({ frames: 3, sampleInterval: 0.1 }));
    try {
      emitter.burst(1);
      tickEmitter(emitter, 0.1); // frame 0 at t=0.1
      tickEmitter(emitter, 0.1); // frame 1 at t=0.2
      tickEmitter(emitter, 0.05); // frame 1 again at t=0.25
      const ages = trailOf(emitter).uniforms.ages.value;
      expect(ages[0]).toBeCloseTo(0.15);
      expect(ages[1]).toBeCloseTo(0);
    } finally {
      emitter.destroy();
    }
  });

  it("skips sorting on an emitter with a trail, warning once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const world = new FXWorld();
    const emitter = FXEmitter.fromArtifacts(
      unlitArtifact(),
      movingBehavior(),
      { expectedCapacity: 4, trail: trailOptions(), sortCamera: new PerspectiveCamera() },
      world,
    );
    try {
      emitter.sortFraction = 1;
      const sort = vi.spyOn(particlesOf(emitter), "sortByDistance");
      emitter.burst(3);
      world.update(0.1);
      world.update(0.1);
      expect(sort).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      emitter.destroy();
      world.dispose();
    }
  });

  it("rejects a history shorter than two frames", () => {
    expect(() => cpuEmitter(trailOptions({ frames: 1 }))).toThrow(RangeError);
  });

  it("replaces or removes the trail in place, keeping the particles", () => {
    const emitter = cpuEmitter();
    try {
      emitter.burst(2);
      tickEmitter(emitter, 0.1);
      const before = trailOf(emitter).mesh;
      emitter.applyTrailArtifact(trailOptions({ frames: 6 }));
      expect(before.parent).toBeNull();
      expect(trailOf(emitter).mesh.parent).toBe(emitter);
      expect(emitter.particleCount).toBe(2);
      emitter.applyTrailArtifact(undefined);
      expect(emitter.hasTrail).toBe(false);
      expect(emitter.particleCount).toBe(2);
    } finally {
      emitter.destroy();
    }
  });
});

describe("trail material", () => {
  function trailMaterial(render: FXRenderArtifact): ShaderMaterial {
    const emitter = FXEmitter.fromArtifacts(unlitArtifact(), behaviorArtifact(), {
      trail: trailOptions({ render }),
    });
    const material = trailOf(emitter).mesh.material as ShaderMaterial;
    const copy = { vertexShader: material.vertexShader, uniforms: material.uniforms };
    emitter.destroy();
    return copy as ShaderMaterial;
  }

  it("interpolates the particle builtins between the segment's two points", () => {
    const { vertexShader } = trailMaterial(unlitArtifact());
    expect(vertexShader).toContain("p_position = mix(fxTrailPosA, fxTrailPosB, fxTrailT);");
    expect(vertexShader).toContain("float fxTrailWidth = 0.1;");
    // Not read by this trail, so not recorded.
    expect(vertexShader).not.toContain("a_tA_lifecycle");
  });

  it("records the lifecycle only for a trail that reads the age, lifetime or id", () => {
    const { vertexShader } = trailMaterial(
      unlitArtifact({ outputs: { albedo: "vec4(PARTICLE_AGE / PARTICLE_LIFETIME)" } }),
    );
    expect(vertexShader).toContain("p_lifecycle = mix(a_tA_lifecycle, a_tB_lifecycle, fxTrailT);");
  });

  it("refuses a trail reading an attribute at another width than the emitter holds it", () => {
    expect(() =>
      FXEmitter.fromArtifacts(
        unlitArtifact(),
        behaviorArtifact({ attributes: [{ name: "tint", components: 4, value: [1, 1, 1, 1] }] }),
        {
          trail: trailOptions({
            render: reading([{ name: "tint", components: 3 }]),
          }),
        },
      ),
    ).toThrow(/components/);
  });

  it("joins segments by the stored tangent on a JS history, the previous point on a GPU one", () => {
    const { vertexShader } = trailMaterial(unlitArtifact());
    expect(vertexShader).toContain(
      "vec3 fxTrailTangent = fxTrailT < 0.5 ? a_tA_trailTangent.xyz : a_tB_trailTangent.xyz;",
    );
  });

  it("reads an attribute the emitter does not hold as zero", () => {
    const { vertexShader } = trailMaterial(reading([{ name: "heat", components: 1 }]));
    expect(vertexShader).toContain("p_fx_heat = float(0.0);");
    expect(vertexShader).not.toContain("a_tA_fx_heat");
  });

  it("records an attribute the behavior writes and the trail reads", () => {
    const emitter = FXEmitter.fromArtifacts(
      unlitArtifact(),
      behaviorArtifact({ attributes: [{ name: "heat", components: 1, value: [7] }] }),
      {
        trail: trailOptions({
          render: reading([{ name: "heat", components: 1 }]),
        }),
      },
    );
    try {
      const { vertexShader } = trailOf(emitter).mesh.material as ShaderMaterial;
      expect(vertexShader).toContain("p_fx_heat = mix(a_tA_fx_heat, a_tB_fx_heat, fxTrailT);");
    } finally {
      emitter.destroy();
    }
  });

  it("records no attribute the trail declares but never reads", () => {
    const heat = [{ name: "heat", components: 1 as const }];
    const emitter = FXEmitter.fromArtifacts(
      unlitArtifact(),
      behaviorArtifact({ attributes: [{ ...heat[0], value: [7] }] }),
      { trail: trailOptions({ render: unlitArtifact({ attributeReads: heat }) }) },
    );
    try {
      const { vertexShader } = trailOf(emitter).mesh.material as ShaderMaterial;
      expect(vertexShader).not.toContain("a_tA_fx_heat");
      expect(
        fxTrailRenderBudget(unlitArtifact({ attributeReads: heat }), behaviorSlot(heat)).attributes,
      ).toBe(fxTrailRenderBudget(unlitArtifact(), behaviorSlot(heat)).attributes);
    } finally {
      emitter.destroy();
    }
  });

  it("skips a trail past the renderer's attribute limit, warning once, and keeps the particles", () => {
    const floats = (count: number): { name: string; components: 1; value: number[] }[] =>
      Array.from({ length: count }, (_, i) => ({
        name: `f${String(i)}`,
        components: 1,
        value: [0],
      }));
    const trailReading = (count: number): FXTrailOptions =>
      trailOptions({
        render: reading(floats(count).map(({ name }) => ({ name, components: 1 }))),
      });
    // WebGL1's minimum; no gpuKernel, so the renderer is only read for its limits.
    const renderer = {
      isWebGLRenderer: true,
      capabilities: { isWebGL2: false, maxAttributes: 8, maxVaryings: 8 },
    } as unknown as WebGLRenderer;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const emitter = FXEmitter.fromArtifacts(
      unlitArtifact(),
      behaviorArtifact({ attributes: floats(5) }),
      { renderer, expectedCapacity: 2, trail: trailReading(5) },
    );
    try {
      expect(fxTrailRenderBudget(trailReading(5).render, behaviorSlot(floats(5))).attributes).toBe(
        9,
      );
      expect(emitter.hasTrail).toBe(false);
      emitter.burst(2);
      tickEmitter(emitter, 0.1);
      expect(emitter.particleCount).toBe(2);
      // A swap past the limit is skipped too, without a second warning.
      emitter.applyTrailArtifact(trailReading(5));
      expect(emitter.hasTrail).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("the trail is skipped");
      // Four floats pack into one view per end: within the limit, drawn.
      emitter.applyTrailArtifact(trailReading(4));
      expect(emitter.hasTrail).toBe(true);
    } finally {
      emitter.destroy();
      warn.mockRestore();
    }
  });

  it("checks no limit without a renderer", () => {
    const floats = [0, 1, 2, 3, 4].map((i) => ({ name: `f${String(i)}`, components: 1 as const }));
    const emitter = FXEmitter.fromArtifacts(
      unlitArtifact(),
      behaviorArtifact({ attributes: floats.map((f) => ({ ...f, value: [0] })) }),
      { trail: trailOptions({ render: reading(floats) }) },
    );
    try {
      expect(emitter.hasTrail).toBe(true);
    } finally {
      emitter.destroy();
    }
  });

  it("takes the width output", () => {
    const { vertexShader } = trailMaterial(
      unlitArtifact({ outputs: { albedo: "vec4(1.0)", width: "0.25 * p_uv.x" } }),
    );
    expect(vertexShader).toContain("float fxTrailWidth = 0.25 * p_uv.x;");
  });

  it("refuses a lit trail graph", () => {
    const lit = { ...unlitArtifact(), lightingIntrinsics: ["fxLambertShade"] };
    expect(() => trailMaterial(lit)).toThrow(/unlit/);
  });

  it("fits the WebGL1 attribute minimum with up to four recorded floats, packed, not with five", () => {
    // The quad, then each end's packed point and joint.
    expect(fxTrailRenderBudget(unlitArtifact(), behaviorSlot()).attributes).toBe(5);
    const floats = (names: readonly string[]): { name: string; components: 1 }[] =>
      names.map((name) => ({ name, components: 1 }));
    const budget = (names: readonly string[]): number =>
      fxTrailRenderBudget(reading(floats(names)), behaviorSlot(floats(names))).attributes;
    expect(budget(["a"])).toBe(7);
    // Two to four floats share one vec4 view per end.
    expect(budget(["a", "b"])).toBe(7);
    expect(budget(["a", "b", "c", "d"])).toBe(7);
    expect(budget(["a", "b", "c", "d"])).toBeLessThanOrEqual(
      FX_RENDER_BUDGET_MINIMUMS.baseline.attributes,
    );
    expect(budget(["a", "b", "c", "d", "e"])).toBe(9);
    // Read but not simulated: zero, unrecorded.
    expect(
      fxTrailRenderBudget(reading([{ name: "a", components: 1 }]), behaviorSlot()).attributes,
    ).toBe(5);
    // The GPU history over the core slot: the quad, the frame, the previous point's position and
    // lifecycle, and both ends' position and lifecycle.
    expect(
      fxTrailRenderBudget(unlitArtifact(), behaviorSlot(), { backend: "gpu" }).attributes,
    ).toBe(8);
  });

  it("budgets exactly the attributes a JS-driven trail mounts", () => {
    const attributes = [{ name: "heat", components: 1 as const }];
    const render = unlitArtifact({
      attributeReads: [{ name: "heat", components: 1 }],
      outputs: { albedo: "vec4(PARTICLE_AGE / PARTICLE_LIFETIME)" },
    });
    const emitter = FXEmitter.fromArtifacts(
      unlitArtifact(),
      behaviorArtifact({ attributes: [{ ...attributes[0], value: [1] }] }),
      { trail: trailOptions({ render }) },
    );
    try {
      const mounted = Object.keys(trailOf(emitter).mesh.geometry.attributes);
      // The quad, the packed point and joint, and one view of the lifecycle (read: age/lifetime)
      // with the heat - per end.
      expect(mounted).toHaveLength(7);
      expect(fxTrailRenderBudget(render, behaviorSlot(attributes)).attributes).toBe(mounted.length);
    } finally {
      emitter.destroy();
    }
  });
});

describe("trail in an effect", () => {
  const worlds: FXWorld[] = [];

  afterEach(() => {
    for (const world of worlds.splice(0)) {
      world.dispose();
    }
  });

  function trailEffect(specification: FXEffectSpec): TestEffect {
    const world = new FXWorld();
    worlds.push(world);
    return new TestEffect(specification, { world, camera: new PerspectiveCamera() });
  }

  function spec(): FXEffectSpec {
    const uniform = (): FXRenderArtifact["uniforms"] => ({
      u_param_glow: { type: "float", value: 0 },
    });
    return effectSpec({
      duration: 1,
      emitters: [
        emitterSpec("Sparks", {
          render: renderForBothTargets(unlitArtifact({ uniforms: uniform() })),
          behavior: behaviorArtifact(),
          expectedCapacity: 8,
          sortInterval: 1,
          liveParams: ["glow"],
          trail: {
            render: renderForBothTargets(unlitArtifact({ uniforms: uniform() })),
            frames: 8,
            sampleInterval: 0.05,
          },
        }),
      ],
    });
  }

  it("drives a shared parameter in both the particle and the trail material", () => {
    const effect = trailEffect(spec());
    try {
      const emitter = effect.getEmitter("Sparks");
      expect(emitter?.hasTrail).toBe(true);
      effect.setEmitterParam("Sparks", "glow", 0.5);
      const particles = particlesOf(emitter as FXEmitter).material as ShaderMaterial;
      const trail = trailOf(emitter as FXEmitter).mesh.material as ShaderMaterial;
      expect(particles.uniforms["u_param_glow"].value).toBe(0.5);
      expect(trail.uniforms["u_param_glow"].value).toBe(0.5);
    } finally {
      effect.dispose();
    }
  });

  it("does not hand a trailed emitter the sort camera, and says why in a development build", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const effect = trailEffect(spec());
    try {
      expect(effect.getEmitter("Sparks")?.sortCamera).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/both a trail and a sortInterval/);
    } finally {
      effect.dispose();
      warn.mockRestore();
    }
  });

  it("restores the baked baseline - not the last driven value - once a parameter stops", () => {
    const base = spec();
    const emitter = base.emitters[0];
    const glow = (): FXRenderArtifact["uniforms"] => ({
      u_param_glow: { type: "float", value: 0.25 },
    });
    const behavior = { ...behaviorArtifact(), bindings: { b_param_glow: { value: 3 } } };
    const specification: FXEffectSpec = {
      ...base,
      emitters: [
        {
          ...emitter,
          sortInterval: 0,
          behavior,
          render: renderForBothTargets(unlitArtifact({ uniforms: glow() })),
          trail: {
            render: renderForBothTargets(unlitArtifact({ uniforms: glow() })),
            frames: 8,
            sampleInterval: 0.05,
          },
        },
      ],
    };
    const effect = trailEffect(specification);
    try {
      const drive = (values: Map<string, number>): void => {
        driveEmitterValues(effect, 0, values);
      };
      const sparks = effect.getEmitter("Sparks") as FXEmitter;
      const particles = particlesOf(sparks).material as ShaderMaterial;
      const trail = trailOf(sparks).mesh.material as ShaderMaterial;
      drive(new Map([["glow", 0.5]]));
      drive(new Map([["glow", 0.75]]));
      expect(particles.uniforms["u_param_glow"].value).toBe(0.75);
      expect(bindingValue(sparks, "b_param_glow")).toBe(0.75);
      drive(new Map());
      expect(particles.uniforms["u_param_glow"].value).toBe(0.25);
      expect(trail.uniforms["u_param_glow"].value).toBe(0.25);
      expect(bindingValue(sparks, "b_param_glow")).toBe(3);
      expect(behavior.bindings.b_param_glow.value).toBe(3); // never written
    } finally {
      effect.dispose();
    }
  });
});

describe("trail draw range", () => {
  const drawn = (emitter: FXEmitter): number =>
    (trailOf(emitter).mesh.geometry as unknown as { instanceCount: number }).instanceCount;

  it("JS: draws nothing once every particle died and its path faded, and again on a birth", () => {
    const emitter = cpuEmitter(trailOptions({ frames: 2 }), 2, movingBehavior(0.15));
    try {
      emitter.burst(1);
      tickEmitter(emitter, 0.1);
      expect(drawn(emitter)).toBe(4);
      // Dead after 0.15 s; two more records leave no frame holding a live point.
      for (let i = 0; i < 4; i++) {
        tickEmitter(emitter, 0.1);
      }
      expect(drawn(emitter)).toBe(0);
      emitter.burst(1);
      tickEmitter(emitter, 0.1);
      expect(drawn(emitter)).toBe(4);
    } finally {
      emitter.destroy();
    }
  });

  it("JS: draws nothing from reset until the next birth", () => {
    const emitter = cpuEmitter(trailOptions({ frames: 2 }), 2);
    try {
      emitter.burst(1);
      tickEmitter(emitter, 0.1);
      emitter.reset();
      expect(drawn(emitter)).toBe(0);
      tickEmitter(emitter, 0.1);
      expect(drawn(emitter)).toBe(0);
    } finally {
      emitter.destroy();
    }
  });

  it("GPU: draws every segment from the first birth on, nothing after reset", () => {
    const { renderer } = mockRenderer();
    const emitter = FXEmitter.fromArtifacts(unlitArtifact(), behaviorArtifact(), {
      gpuKernel: {
        vertexSource: "",
        fragmentSource: "",
        buffers: [
          { name: FX_CORE_POSITION, stride: 3 },
          { name: FX_CORE_LIFECYCLE, stride: 3 },
        ],
        transformFeedbackVaryings: ["out_position", "out_lifecycle"],
        bindings: {},
      },
      renderer,
      expectedCapacity: 4,
      trail: trailOptions({ frames: 3 }),
    });
    try {
      expect(drawn(emitter)).toBe(0);
      emitter.burst(1);
      tickEmitter(emitter, 0.1);
      expect(drawn(emitter)).toBe(12);
      emitter.reset();
      expect(drawn(emitter)).toBe(0);
    } finally {
      emitter.destroy();
    }
  });
});

describe("trail history - GPU backend", () => {
  const kernel: FXParticleKernelArtifact = {
    vertexSource: "",
    fragmentSource: "",
    buffers: [
      { name: FX_CORE_POSITION, stride: 3 },
      { name: FX_CORE_LIFECYCLE, stride: 3 },
    ],
    transformFeedbackVaryings: ["out_position", "out_lifecycle"],
    bindings: {},
  };

  it("copies the drawn slot buffer into the head frame and the mirrors of the first and last", () => {
    const { renderer, gl } = mockRenderer();
    const emitter = FXEmitter.fromArtifacts(unlitArtifact(), behaviorArtifact(), {
      gpuKernel: kernel,
      renderer,
      expectedCapacity: 4,
      trail: trailOptions({ frames: 3, sampleInterval: 0.1 }),
    });
    try {
      const frameBytes = 4 * 6 * 4;
      emitter.burst(1);
      gl.calls.length = 0;
      tickEmitter(emitter, 0.01); // head 0
      const copies = (): (readonly unknown[])[] =>
        callsNamed(gl, "copyBufferSubData").map((call) => call.args);
      // Frame f lives at f + 1; frame 0 is mirrored after the last frame (at 4).
      expect(copies().map((args) => args[3])).toEqual([frameBytes, 4 * frameBytes]);
      gl.calls.length = 0;
      tickEmitter(emitter, 0.1); // head 1
      expect(copies().map((args) => args[3])).toEqual([2 * frameBytes]);
      expect(copies()[0][4]).toBe(frameBytes);
      gl.calls.length = 0;
      tickEmitter(emitter, 0.1); // head 2, the last frame: mirrored before frame 0 (at 0)
      expect(copies().map((args) => args[3])).toEqual([3 * frameBytes, 0]);
    } finally {
      emitter.destroy();
    }
  });

  it("keeps a two-frame history: each head frame is a mirror's source as well", () => {
    const { renderer, gl } = mockRenderer();
    const emitter = FXEmitter.fromArtifacts(unlitArtifact(), behaviorArtifact(), {
      gpuKernel: kernel,
      renderer,
      expectedCapacity: 4,
      trail: trailOptions({ frames: 2, sampleInterval: 0.1 }),
    });
    try {
      const frameBytes = 4 * 6 * 4;
      const copies = (): unknown[] =>
        callsNamed(gl, "copyBufferSubData").map((call) => call.args[3]);
      // Four physical frames: [mirror of 1][frame 0][frame 1][mirror of 0].
      const allocations = callsNamed(gl, "bufferData");
      expect(allocations.map((call) => call.args[1])).toContain(4 * frameBytes);
      emitter.burst(1);
      gl.calls.length = 0;
      tickEmitter(emitter, 0.01); // head 0: itself and its mirror after frame 1
      expect(copies()).toEqual([frameBytes, 3 * frameBytes]);
      gl.calls.length = 0;
      tickEmitter(emitter, 0.1); // head 1, the last frame: itself and its mirror before frame 0
      expect(copies()).toEqual([2 * frameBytes, 0]);
      gl.calls.length = 0;
      tickEmitter(emitter, 0.1); // head 0 again
      expect(copies()).toEqual([frameBytes, 3 * frameBytes]);
      const geometry = trailOf(emitter).mesh.geometry as unknown as { instanceCount: number };
      expect(geometry.instanceCount).toBe(2 * 4);
    } finally {
      emitter.destroy();
    }
  });

  it("budgets exactly the attributes a GPU-driven trail mounts", () => {
    const { renderer } = mockRenderer();
    const render = unlitArtifact({ outputs: { albedo: "vec4(PARTICLE_AGE / PARTICLE_LIFETIME)" } });
    const emitter = FXEmitter.fromArtifacts(unlitArtifact(), behaviorArtifact(), {
      gpuKernel: kernel,
      renderer,
      expectedCapacity: 4,
      trail: trailOptions({ render }),
    });
    try {
      const mounted = Object.keys(trailOf(emitter).mesh.geometry.attributes);
      expect(mounted).toHaveLength(8);
      expect(fxTrailRenderBudget(render, kernel.buffers, { backend: "gpu" }).attributes).toBe(
        mounted.length,
      );
    } finally {
      emitter.destroy();
    }
  });
});

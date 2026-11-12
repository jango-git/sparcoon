import type { InterleavedBufferAttribute, Mesh, ShaderMaterial } from "three";
import { describe, expect, it } from "vitest";

import type {
  FXAttributeDecl,
  FXBufferLayout,
  FXParticleKernelArtifact,
  FXRenderArtifact,
} from "../../src/artifact/FXArtifact";
import { FX_CORE_LIFECYCLE, FX_CORE_POSITION, FX_LIFETIME } from "../../src/coreLayout";
import { FXEmitter } from "../../src/emitter/FXEmitter";
import { packingOrder } from "../../src/render/FXAttributePacking";
import { fxEmitterRenderBudget, fxTrailRenderBudget } from "../../src/render/FXRenderBudget";
import type { FXTrailOptions } from "../../src/trail/FXTrail";
import { behaviorArtifact, unlitArtifact } from "../helpers/artifacts";
import {
  gpuParticlesOf,
  isGPUDriven,
  particlesOf,
  tickEmitter,
  trailOf,
} from "../helpers/internals";
import { mockRenderer } from "../helpers/mockWebGL";
import { fieldBehavior, fieldComponents } from "../helpers/slots";

function vertexShaderOf(mesh: Mesh): string {
  return (mesh.material as ShaderMaterial).vertexShader;
}

/** The instanced (`a_*`) attributes `mesh` binds, beside the base geometry's. */
function instancedAttributes(mesh: Mesh): string[] {
  return Object.keys(mesh.geometry.attributes)
    .filter((name) => name.startsWith("a_"))
    .sort();
}

/** The fixture fields: a vec3 color, a float alpha and a float size. */
const COLOR_ALPHA_SIZE: readonly FXAttributeDecl[] = [
  { name: "color", components: 3 },
  { name: "alpha", components: 1 },
  { name: "size", components: 1 },
];

/** A render reading color, alpha and size. */
function colorAlphaSizeRender(over: Partial<FXRenderArtifact> = {}): FXRenderArtifact {
  return {
    ...unlitArtifact({
      attributeReads: COLOR_ALPHA_SIZE,
      outputs: { albedo: "vec4(p_fx_color * p_fx_size, p_fx_alpha)" },
    }),
    ...over,
  };
}

function trailOptions(render: FXRenderArtifact): FXTrailOptions {
  return { render, frames: 3, sampleInterval: 0.1 };
}

/** The slot of an emitter writing color, alpha and size, in the JS behavior's declaration order. */
const DECLARED_SLOT: readonly FXBufferLayout[] = [
  { name: FX_CORE_POSITION, stride: 3 },
  { name: FX_CORE_LIFECYCLE, stride: 3 },
  ...COLOR_ALPHA_SIZE.map((decl) => ({ name: decl.name, stride: decl.components })),
];

/** The slot of an emitter writing color, alpha and size - laid out by packingOrder, as the editor
 *  lays out both the JS behavior's and the GPU kernel's. */
function packedKernelBuffers(): FXBufferLayout[] {
  return packingOrder([
    { name: FX_CORE_POSITION, components: 3 },
    { name: FX_CORE_LIFECYCLE, components: 3 },
    ...COLOR_ALPHA_SIZE,
  ]).map((field) => ({ name: field.name, stride: field.components }));
}

function kernelOf(buffers: readonly FXBufferLayout[]): FXParticleKernelArtifact {
  return {
    vertexSource: "",
    fragmentSource: "",
    buffers,
    transformFeedbackVaryings: buffers.map((buffer) => `out_${buffer.name}`),
    bindings: {},
  };
}

function cpuEmitter(render: FXRenderArtifact, trail?: FXRenderArtifact): FXEmitter {
  return FXEmitter.fromArtifacts(
    render,
    behaviorArtifact({
      attributes: [
        { name: "color", components: 3, value: [0.1, 0.2, 0.3] },
        { name: "alpha", components: 1, value: [0.4] },
        { name: "size", components: 1, value: [0.5] },
      ],
    }),
    { expectedCapacity: 2, ...(trail === undefined ? {} : { trail: trailOptions(trail) }) },
  );
}

function gpuEmitter(
  render: FXRenderArtifact,
  buffers: readonly FXBufferLayout[],
  trail?: FXRenderArtifact,
): FXEmitter {
  const emitter = FXEmitter.fromArtifacts(render, behaviorArtifact(), {
    gpuKernel: kernelOf(buffers),
    renderer: mockRenderer().renderer,
    expectedCapacity: 4,
    ...(trail === undefined ? {} : { trail: trailOptions(trail) }),
  });
  expect(isGPUDriven(emitter)).toBe(true);
  return emitter;
}

describe("CPU trail history packing", () => {
  it("lays the recorded fields out in packingOrder and records each in its own components", () => {
    const emitter = cpuEmitter(unlitArtifact(), colorAlphaSizeRender());
    try {
      const { history, mesh } = trailOf(emitter);
      // vec4(color, alpha) and size, after the packed point and joint (8 floats).
      expect(history.stride).toBe(13);
      expect(history.layout.packed.map((view) => [view.offset, view.components])).toEqual([
        [8, 4],
        [12, 1],
      ]);

      emitter.burst(1);
      tickEmitter(emitter, 0.01);
      const point = Array.from(history.array.subarray(0, history.stride));
      expect(point.slice(8, 11).map((value) => Number(value.toFixed(6)))).toEqual([0.1, 0.2, 0.3]);
      expect(point[11]).toBeCloseTo(0.4, 6);
      expect(point[12]).toBeCloseTo(0.5, 6);

      // Mounted as one vec4 and one float per end, the end a whole frame further on.
      const a = mesh.geometry.getAttribute("a_tA_pack0") as InterleavedBufferAttribute;
      const b = mesh.geometry.getAttribute("a_tB_pack0") as InterleavedBufferAttribute;
      expect([a.itemSize, a.offset]).toEqual([4, 8]);
      expect(b.offset - a.offset).toBe(history.capacity * history.stride);
      expect((mesh.geometry.getAttribute("a_tA_pack1") as InterleavedBufferAttribute).offset).toBe(
        12,
      );

      // Split back into the very names the rest of the shader reads.
      const shader = vertexShaderOf(mesh);
      expect(shader).toContain("attribute vec4 a_tA_pack0;");
      expect(shader).toContain("a_tA_fx_color = a_tA_pack0.xyz;");
      expect(shader).toContain("a_tB_fx_alpha = a_tB_pack0.w;");
      expect(shader).toContain("a_tA_fx_size = a_tA_pack1;");
      expect(shader).toContain("p_fx_color = mix(a_tA_fx_color, a_tB_fx_color, fxTrailT);");
      expect(shader).not.toMatch(/attribute \w+ a_tA_fx_/);
    } finally {
      emitter.destroy();
    }
  });

  it("budgets exactly what it mounts: 9 attributes for color + alpha + size (11 unpacked)", () => {
    const render = colorAlphaSizeRender();
    const emitter = cpuEmitter(unlitArtifact(), render);
    try {
      const mounted = Object.keys(trailOf(emitter).mesh.geometry.attributes);
      expect(mounted).toHaveLength(9);
      expect(fxTrailRenderBudget(render, DECLARED_SLOT).attributes).toBe(mounted.length);
    } finally {
      emitter.destroy();
    }
  });
});

describe("GPU packing", () => {
  it("binds the particle mesh through the kernel slot's packed views", () => {
    const render = colorAlphaSizeRender();
    const buffers = packedKernelBuffers();
    // packingOrder: color + alpha, lifecycle + size, position.
    expect(buffers.map((buffer) => buffer.name)).toEqual([
      "color",
      "alpha",
      "lifecycle",
      "size",
      "position",
    ]);
    const emitter = gpuEmitter(render, buffers);
    try {
      const mesh = gpuParticlesOf(emitter);
      expect(instancedAttributes(mesh)).toEqual(["a_pack0", "a_pack1", "a_pack2"]);
      const shader = vertexShaderOf(mesh);
      expect(shader).toContain("p_fx_color = a_pack0.xyz;");
      expect(shader).toContain("p_fx_alpha = a_pack0.w;");
      expect(shader).toContain("p_lifecycle = a_pack1.xyz;");
      expect(shader).toContain("p_fx_size = a_pack1.w;");
      expect(shader).toContain("p_position = a_pack2;");
      // The base geometry's three, then the views - fewer for the packing order than for the
      // order fields were declared in.
      const budget = fxEmitterRenderBudget(render, buffers);
      expect(budget.attributes).toBe(3 + 3);
      expect(fxEmitterRenderBudget(render, DECLARED_SLOT).attributes).toBe(3 + 4);
      const depth = fxEmitterRenderBudget(render, buffers, { castShadow: true });
      expect(depth.attributes).toBe(budget.attributes);
    } finally {
      emitter.destroy();
    }
  });

  it("binds a JS-driven mesh through the same packed views, over its own slot", () => {
    const render = colorAlphaSizeRender();
    const buffers = packedKernelBuffers();
    const emitter = FXEmitter.fromArtifacts(
      render,
      fieldBehavior({
        buffers,
        spawn(fields, start, count): void {
          for (let i = start; i < start + count; i++) {
            fields[FX_CORE_LIFECYCLE][i * 3 + FX_LIFETIME] = 1;
            fields["alpha"][i] = 0.4;
            fields["size"][i] = 0.5;
          }
        },
      }),
      { expectedCapacity: 2 },
    );
    try {
      const mesh = particlesOf(emitter);
      expect(instancedAttributes(mesh)).toEqual(["a_pack0", "a_pack1", "a_pack2"]);
      const shader = vertexShaderOf(mesh);
      expect(shader).toContain("p_fx_alpha = a_pack0.w;");
      expect(shader).toContain("p_fx_size = a_pack1.w;");
      expect(fxEmitterRenderBudget(render, buffers).attributes).toBe(3 + 3);

      emitter.burst(1);
      tickEmitter(emitter, 0);
      // One interleaved record per particle: color, alpha, lifecycle, size, position.
      expect(mesh.slot.stride).toBe(11);
      expect(mesh.slots[3]).toBeCloseTo(0.4, 6);
      expect(mesh.slots[7]).toBeCloseTo(0.5, 6);
    } finally {
      emitter.destroy();
    }
  });

  it("packs the depth material the same way", () => {
    const render = colorAlphaSizeRender();
    const emitter = FXEmitter.fromArtifacts(render, behaviorArtifact(), {
      gpuKernel: kernelOf(packedKernelBuffers()),
      renderer: mockRenderer().renderer,
      expectedCapacity: 4,
      castShadow: true,
    });
    try {
      const depth = gpuParticlesOf(emitter).customDepthMaterial as ShaderMaterial;
      expect(depth.vertexShader).toContain("attribute vec4 a_pack0;");
      expect(depth.vertexShader).toContain("p_fx_alpha = a_pack0.w;");
    } finally {
      emitter.destroy();
    }
  });

  it("mounts the GPU trail history's start, end and previous views off the slot", () => {
    const render = colorAlphaSizeRender({
      outputs: { albedo: "vec4(p_fx_color * p_fx_size, p_fx_alpha * PARTICLE_AGE)" },
    });
    const buffers = packedKernelBuffers();
    const emitter = gpuEmitter(unlitArtifact(), buffers, render);
    try {
      const { mesh, history } = trailOf(emitter);
      const stride = 11;
      const frameFloats = 4 * stride;
      const offsetOf = (name: string): number =>
        (mesh.geometry.getAttribute(name) as unknown as { offset: number }).offset;
      // Start views one frame in (frame 0 lives after the mirror), end views two.
      expect(history.layout.packed.map((view) => view.offset)).toEqual([0, 4, 8]);
      expect(offsetOf("a_tA_pack1")).toBe(frameFloats + 4);
      expect(offsetOf("a_tB_pack1")).toBe(2 * frameFloats + 4);
      // The previous point: position and lifecycle only - the lifecycle view trimmed off the size.
      expect(history.layout.previous.map((view) => [view.offset, view.components])).toEqual([
        [4, 3],
        [8, 3],
      ]);
      expect(offsetOf("a_tC_prev0")).toBe(4);
      expect(instancedAttributes(mesh).filter((name) => name !== "a_trailFrame")).toEqual([
        "a_tA_pack0",
        "a_tA_pack1",
        "a_tA_pack2",
        "a_tB_pack0",
        "a_tB_pack1",
        "a_tB_pack2",
        "a_tC_prev0",
        "a_tC_prev1",
      ]);
      const shader = vertexShaderOf(mesh);
      expect(shader).toContain("a_tC_lifecycle = a_tC_prev0;");
      expect(shader).toContain("a_tA_lifecycle = a_tA_pack1.xyz;");

      // The quad, the frame, the previous point's two views and three views per end.
      const mounted = Object.keys(mesh.geometry.attributes);
      expect(mounted).toHaveLength(10);
      expect(fxTrailRenderBudget(render, buffers, { backend: "gpu" }).attributes).toBe(
        mounted.length,
      );
    } finally {
      emitter.destroy();
    }
  });
});

describe("unwritten reads", () => {
  /** Reads `glow`, which no behavior or kernel here writes. */
  const glowRender = (): FXRenderArtifact =>
    unlitArtifact({
      attributeReads: [{ name: "glow", components: 3 }],
      outputs: { albedo: "vec4(p_fx_glow, 1.0)" },
    });

  it("are a zero constant on the JS path: no buffer, no attribute, not budgeted", () => {
    const emitter = FXEmitter.fromArtifacts(glowRender(), behaviorArtifact(), {
      castShadow: true,
    });
    try {
      const mesh = particlesOf(emitter);
      expect(fieldComponents(mesh, "fx_glow")).toBeUndefined();
      expect(instancedAttributes(mesh)).toEqual(["a_pack0", "a_pack1"]);
      for (const material of [mesh.material, mesh.customDepthMaterial] as ShaderMaterial[]) {
        expect(material.vertexShader).toContain("p_fx_glow = vec3(0.0);");
        expect(material.vertexShader).not.toContain("a_fx_glow");
        // Still a varying: the fragment stage reads it.
        expect(material.fragmentShader).toContain("varying vec3 p_fx_glow;");
      }
      expect(fxEmitterRenderBudget(glowRender(), DECLARED_SLOT.slice(0, 2)).attributes).toBe(3 + 2);
    } finally {
      emitter.destroy();
    }
  });

  it("are a zero constant on the GPU path: no buffer, no attribute, not budgeted", () => {
    const buffers: FXBufferLayout[] = [
      { name: FX_CORE_POSITION, stride: 3 },
      { name: FX_CORE_LIFECYCLE, stride: 3 },
    ];
    const emitter = gpuEmitter(glowRender(), buffers);
    try {
      const mesh = gpuParticlesOf(emitter);
      expect(instancedAttributes(mesh)).toEqual(["a_pack0", "a_pack1"]);
      expect(vertexShaderOf(mesh)).toContain("p_fx_glow = vec3(0.0);");
      expect(fxEmitterRenderBudget(glowRender(), buffers).attributes).toBe(3 + 2);
    } finally {
      emitter.destroy();
    }
  });
});

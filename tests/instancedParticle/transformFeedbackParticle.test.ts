import { describe, expect, it } from "vitest";
import { BufferAttribute, BufferGeometry, MeshBasicMaterial } from "three";
import {
  FXTransformFeedbackParticle,
  slotLayout,
} from "../../src/instancedParticle/FXTransformFeedbackParticle";
import type { GLTypeInfo } from "../../src/instancedParticle/glTypeInfo";

// No real WebGL2 context is available in this headless test run - a minimal mock covering only
// the gl.* surface the constructor/buffer lifecycle actually calls, so the ping-pong bookkeeping
// (index flipping, buffer pairing, attribute-object replacement) can be verified without one.
// This proves the JS-side logic; it cannot prove the raw GL calls behave correctly against a real
// driver - that limitation holds for this whole file.
function mockGL(): WebGL2RenderingContext {
  let nextBufferId = 1;
  const deleted = new Set<unknown>();
  const uploads: (number | Float32Array)[] = [];
  const gl = {
    FLOAT: 0x1406,
    ARRAY_BUFFER: 0x8892,
    DYNAMIC_DRAW: 0x88e8,
    createBuffer: () => ({ id: nextBufferId++ }) as unknown as WebGLBuffer,
    bindBuffer: () => undefined,
    bufferData: (_target: number, data: number | Float32Array) => {
      uploads.push(data);
    },
    deleteBuffer: (buffer: WebGLBuffer) => {
      deleted.add(buffer);
    },
    // Exposed for assertions only, not part of the real WebGL2RenderingContext surface.
    __deleted: deleted,
    __uploads: uploads,
  };
  return gl as unknown as WebGL2RenderingContext;
}

function baseQuad(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(12), 3));
  geometry.setAttribute("uv", new BufferAttribute(new Float32Array(8), 2));
  geometry.setAttribute("normal", new BufferAttribute(new Float32Array(12), 3));
  return geometry;
}

const VEC3: GLTypeInfo = { glslTypeName: "vec3", bufferSize: 3, instantiable: true };
const FLOAT: GLTypeInfo = { glslTypeName: "float", bufferSize: 1, instantiable: true };

/** The slot a kernel writing position, lifecycle and a float `fx_glow` lays out: 7 floats. */
const LAYOUT = slotLayout([
  { name: "position", components: 3 },
  { name: "lifecycle", components: 3 },
  { name: "fx_glow", components: 1 },
]);
const VARYINGS = { position: VEC3, lifecycle: VEC3, fx_glow: FLOAT };

function particle(
  gl: WebGL2RenderingContext,
  capacity = 64,
  varyings: Record<string, GLTypeInfo> = VARYINGS,
) {
  return new FXTransformFeedbackParticle(
    gl,
    LAYOUT,
    varyings,
    capacity,
    new MeshBasicMaterial(),
    baseQuad(),
  );
}

interface SlotAttribute {
  readonly buffer: unknown;
  readonly itemSize: number;
  readonly offset: number;
  readonly stride: number;
  readonly data: unknown;
}

describe("slotLayout", () => {
  it("lays buffers out back to back, in order", () => {
    expect(LAYOUT).toEqual({
      stride: 7,
      fields: [
        { name: "position", components: 3, offset: 0 },
        { name: "lifecycle", components: 3, offset: 3 },
        { name: "fx_glow", components: 1, offset: 6 },
      ],
    });
  });
});

describe("FXTransformFeedbackParticle", () => {
  it("holds the whole state in one ping-pong pair of slot-sized buffers", () => {
    const gl = mockGL();
    const mesh = particle(gl, 64);
    try {
      expect(mesh.capacity).toBe(64);
      expect(mesh.readBuffer()).not.toBe(mesh.writeBuffer());
      const uploads = (gl as unknown as { __uploads: (number | Float32Array)[] }).__uploads;
      // Two halves of 64 slots x 7 floats x 4 bytes, uninitialized.
      expect(uploads).toEqual([64 * 7 * 4, 64 * 7 * 4]);
    } finally {
      mesh.destroy();
    }
  });

  it("reads every field out of the slot at its own offset, as three's interleaved attribute", () => {
    const gl = mockGL();
    const mesh = particle(gl);
    try {
      const glow = mesh.geometry.getAttribute("a_fx_glow") as unknown as SlotAttribute;
      expect(glow).toBe(mesh.propertyBuffers["fx_glow"]);
      expect(glow).toMatchObject({ buffer: mesh.readBuffer(), itemSize: 1, offset: 6, stride: 7 });
      // Three looks the buffer up through `data`.
      expect(glow.data).toBe(glow);
    } finally {
      mesh.destroy();
    }
  });

  it("every particle slot is always drawn - instanceCount is always capacity, never grows", () => {
    const gl = mockGL();
    const mesh = particle(gl, 128);
    try {
      expect((mesh.geometry as unknown as { instanceCount: number }).instanceCount).toBe(128);
    } finally {
      mesh.destroy();
    }
  });

  it("swapBuffers flips the halves and gives every field a fresh attribute object", () => {
    const gl = mockGL();
    const mesh = particle(gl);
    try {
      const read = mesh.readBuffer();
      const write = mesh.writeBuffer();
      const positionBefore = mesh.propertyBuffers["position"];

      mesh.swapBuffers();

      expect(mesh.readBuffer()).toBe(write);
      expect(mesh.writeBuffer()).toBe(read);
      // A new object, not the old one retargeted (three caches VAOs by attribute identity).
      expect(mesh.propertyBuffers["position"]).not.toBe(positionBefore);
      expect((mesh.propertyBuffers["position"] as unknown as SlotAttribute).buffer).toBe(write);

      mesh.swapBuffers();
      expect(mesh.readBuffer()).toBe(read);
    } finally {
      mesh.destroy();
    }
  });

  it("backs a varying the kernel does not write with a zero-filled buffer that never swaps", () => {
    const gl = mockGL();
    const mesh = particle(gl, 16, { ...VARYINGS, fx_tint: VEC3 });
    try {
      const uploads = (gl as unknown as { __uploads: (number | Float32Array)[] }).__uploads;
      expect(uploads[2]).toEqual(new Float32Array(16 * 3));
      const tint = mesh.propertyBuffers["fx_tint"];
      mesh.swapBuffers();
      expect(mesh.propertyBuffers["fx_tint"]).toBe(tint);
    } finally {
      mesh.destroy();
    }
  });

  it("destroy deletes every raw buffer this instance owns", () => {
    const gl = mockGL();
    const mesh = particle(gl, 32, { ...VARYINGS, fx_tint: VEC3 });
    const read = mesh.readBuffer();
    const write = mesh.writeBuffer();
    const tint = (mesh.propertyBuffers["fx_tint"] as unknown as SlotAttribute).buffer;

    mesh.destroy();

    const deleted = (gl as unknown as { __deleted: Set<unknown> }).__deleted;
    expect([read, write, tint].every((buffer) => deleted.has(buffer))).toBe(true);
  });
});

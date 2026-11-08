import { describe, expect, it } from "vitest";
import { BufferAttribute, BufferGeometry, MeshBasicMaterial } from "three";
import {
  FXTransformFeedbackParticle,
  slotLayout,
} from "../../src/instancedParticle/FXTransformFeedbackParticle";

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

/** The slot a kernel writing position, lifecycle and a float `fx_glow` lays out: 7 floats. */
const LAYOUT = slotLayout([
  { name: "position", components: 3 },
  { name: "lifecycle", components: 3 },
  { name: "fx_glow", components: 1 },
]);

function particle(gl: WebGL2RenderingContext, capacity = 64, layout = LAYOUT) {
  return new FXTransformFeedbackParticle(gl, layout, capacity, new MeshBasicMaterial(), baseQuad());
}

interface SlotAttribute {
  readonly buffer: unknown;
  readonly itemSize: number;
  readonly offset: number;
  readonly stride: number;
  readonly data: unknown;
}

function attributeOf(mesh: FXTransformFeedbackParticle, name: string): SlotAttribute {
  return mesh.geometry.getAttribute(name) as unknown as SlotAttribute;
}

describe("slotLayout", () => {
  it("lays buffers out back to back, in order, and packs adjacent ones into views", () => {
    expect(LAYOUT.stride).toBe(7);
    expect(LAYOUT.fields).toEqual([
      { name: "position", components: 3, offset: 0 },
      { name: "lifecycle", components: 3, offset: 3 },
      { name: "fx_glow", components: 1, offset: 6 },
    ]);
    // Position (3) and lifecycle (3) cannot share a vec4; lifecycle and glow can.
    expect(LAYOUT.packed).toEqual([
      {
        name: "pack0",
        offset: 0,
        components: 3,
        members: [{ name: "position", components: 3, componentOffset: 0 }],
      },
      {
        name: "pack1",
        offset: 3,
        components: 4,
        members: [
          { name: "lifecycle", components: 3, componentOffset: 0 },
          { name: "fx_glow", components: 1, componentOffset: 3 },
        ],
      },
    ]);
  });

  it("needs one view per vec4 bin for a kernel ordered by packingOrder", () => {
    // packingOrder of position, lifecycle, color (vec3), alpha, size: position+alpha,
    // lifecycle+size, color alone.
    const layout = slotLayout([
      { name: "position", components: 3 },
      { name: "fx_alpha", components: 1 },
      { name: "lifecycle", components: 3 },
      { name: "fx_size", components: 1 },
      { name: "fx_color", components: 3 },
    ]);
    expect(layout.packed.map((view) => view.members.map((member) => member.name))).toEqual([
      ["position", "fx_alpha"],
      ["lifecycle", "fx_size"],
      ["fx_color"],
    ]);
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
      // Two halves of 64 slots x 7 floats x 4 bytes, uninitialized - and nothing else.
      expect(uploads).toEqual([64 * 7 * 4, 64 * 7 * 4]);
    } finally {
      mesh.destroy();
    }
  });

  it("binds one attribute per packed view, out of the slot at its own offset", () => {
    const gl = mockGL();
    const mesh = particle(gl);
    try {
      const names = Object.keys(mesh.geometry.attributes).sort();
      expect(names).toEqual(["a_pack0", "a_pack1", "normal", "position", "uv"]);
      const view = attributeOf(mesh, "a_pack1");
      expect(view).toMatchObject({ buffer: mesh.readBuffer(), itemSize: 4, offset: 3, stride: 7 });
      // Three looks the buffer up through `data`.
      expect(view.data).toBe(view);
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

  it("swapBuffers flips the halves and gives every view a fresh attribute object", () => {
    const gl = mockGL();
    const mesh = particle(gl);
    try {
      const read = mesh.readBuffer();
      const write = mesh.writeBuffer();
      const before = attributeOf(mesh, "a_pack0");

      mesh.swapBuffers();

      expect(mesh.readBuffer()).toBe(write);
      expect(mesh.writeBuffer()).toBe(read);
      // A new object, not the old one retargeted (three caches VAOs by attribute identity).
      expect(attributeOf(mesh, "a_pack0")).not.toBe(before);
      expect(attributeOf(mesh, "a_pack0").buffer).toBe(write);
      expect(attributeOf(mesh, "a_pack1").buffer).toBe(write);

      mesh.swapBuffers();
      expect(mesh.readBuffer()).toBe(read);
    } finally {
      mesh.destroy();
    }
  });

  it("destroy deletes both halves of the pair", () => {
    const gl = mockGL();
    const mesh = particle(gl, 32);
    const read = mesh.readBuffer();
    const write = mesh.writeBuffer();

    mesh.destroy();

    const deleted = (gl as unknown as { __deleted: Set<unknown> }).__deleted;
    expect([read, write].every((buffer) => deleted.has(buffer))).toBe(true);
  });
});

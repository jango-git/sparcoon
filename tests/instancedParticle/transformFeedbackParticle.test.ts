import { describe, expect, it } from "vitest";
import { BufferAttribute, BufferGeometry, MeshBasicMaterial } from "three";
import { FXTransformFeedbackParticle } from "../../src/instancedParticle/FXTransformFeedbackParticle";

// No real WebGL2 context is available in this headless test run - a minimal mock covering only
// the gl.* surface the constructor/buffer lifecycle actually calls, so the ping-pong bookkeeping
// (index flipping, buffer pairing, attribute-object replacement) can be verified without one.
// This proves the JS-side logic; it cannot prove the raw GL calls behave correctly against a real
// driver - that limitation holds for this whole file.
function mockGL(): WebGL2RenderingContext {
  let nextBufferId = 1;
  const deleted = new Set<unknown>();
  const gl = {
    FLOAT: 0x1406,
    ARRAY_BUFFER: 0x8892,
    DYNAMIC_DRAW: 0x88e8,
    createBuffer: () => ({ id: nextBufferId++ }) as unknown as WebGLBuffer,
    bindBuffer: () => undefined,
    bufferData: () => undefined,
    deleteBuffer: (buffer: WebGLBuffer) => {
      deleted.add(buffer);
    },
    // Exposed for assertions only, not part of the real WebGL2RenderingContext surface.
    __deleted: deleted,
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

describe("FXTransformFeedbackParticle", () => {
  it("allocates a ping-pong buffer pair per declared varying, both distinct WebGLBuffers", () => {
    const gl = mockGL();
    const mesh = new FXTransformFeedbackParticle(
      gl,
      { position: { glslTypeName: "vec3", bufferSize: 3, instantiable: true } },
      64,
      new MeshBasicMaterial(),
      baseQuad(),
    );
    try {
      expect(mesh.capacity).toBe(64);
      expect(mesh.propertyBuffers["position"]).toBeDefined();
      // Read and write start on opposite halves of the pair.
      expect(mesh.readBuffer("position")).not.toBe(mesh.writeBuffer("position"));
    } finally {
      mesh.destroy();
    }
  });

  it("every particle slot is always drawn - instanceCount is always capacity, never grows", () => {
    const gl = mockGL();
    const mesh = new FXTransformFeedbackParticle(
      gl,
      { position: { glslTypeName: "vec3", bufferSize: 3, instantiable: true } },
      128,
      new MeshBasicMaterial(),
      baseQuad(),
    );
    try {
      expect((mesh.geometry as unknown as { instanceCount: number }).instanceCount).toBe(128);
    } finally {
      mesh.destroy();
    }
  });

  it("swapBuffers flips which half is current and replaces the attribute object", () => {
    const gl = mockGL();
    const mesh = new FXTransformFeedbackParticle(
      gl,
      { position: { glslTypeName: "vec3", bufferSize: 3, instantiable: true } },
      64,
      new MeshBasicMaterial(),
      baseQuad(),
    );
    try {
      const readBeforeSwap = mesh.readBuffer("position");
      const writeBeforeSwap = mesh.writeBuffer("position");
      const attributeBeforeSwap = mesh.propertyBuffers["position"];

      mesh.swapBuffers("position");

      // The buffer just written to is now the read side (ping-pong flip).
      expect(mesh.readBuffer("position")).toBe(writeBeforeSwap);
      expect(mesh.writeBuffer("position")).toBe(readBeforeSwap);
      // A fresh attribute object, not a mutation of the old one (the VAO-cache-identity fix -
      // see swapBuffers's own doc comment for why this must be a new object).
      expect(mesh.propertyBuffers["position"]).not.toBe(attributeBeforeSwap);
      expect(mesh.propertyBuffers["position"].buffer).toBe(writeBeforeSwap);

      // Swapping again returns to the original assignment - a genuine two-state flip, not a
      // one-way allocation of ever-more buffers.
      mesh.swapBuffers("position");
      expect(mesh.readBuffer("position")).toBe(readBeforeSwap);
      expect(mesh.writeBuffer("position")).toBe(writeBeforeSwap);
    } finally {
      mesh.destroy();
    }
  });

  it("destroy deletes every raw buffer this instance owns, both halves of every pair", () => {
    const gl = mockGL();
    const mesh = new FXTransformFeedbackParticle(
      gl,
      {
        position: { glslTypeName: "vec3", bufferSize: 3, instantiable: true },
        lifecycle: { glslTypeName: "vec3", bufferSize: 3, instantiable: true },
      },
      32,
      new MeshBasicMaterial(),
      baseQuad(),
    );
    const positionRead = mesh.readBuffer("position");
    const positionWrite = mesh.writeBuffer("position");
    const lifecycleRead = mesh.readBuffer("lifecycle");
    const lifecycleWrite = mesh.writeBuffer("lifecycle");

    mesh.destroy();

    const deleted = (gl as unknown as { __deleted: Set<unknown> }).__deleted;
    expect(deleted.has(positionRead)).toBe(true);
    expect(deleted.has(positionWrite)).toBe(true);
    expect(deleted.has(lifecycleRead)).toBe(true);
    expect(deleted.has(lifecycleWrite)).toBe(true);
  });
});

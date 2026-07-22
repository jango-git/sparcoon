import type { BufferGeometry, Material } from "three";
import { GLBufferAttribute, InstancedBufferGeometry, Mesh } from "three";
import type { GLTypeInfo } from "./glTypeInfo.js";

/**
 * @internal A `GLBufferAttribute` additionally declared instanced (divisor 1, one value per drawn
 * particle instead of per vertex). Confirmed by reading `WebGLBindingStates.js:432-444`: the
 * per-instance vertex-attribute divisor is driven by `isInstancedBufferAttribute`/
 * `meshPerAttribute` on the attribute object itself - a plain `GLBufferAttribute` never sets
 * either, so without this every particle's state would be read as per-VERTEX (one value shared
 * by the whole base primitive) instead of per-INSTANCE.
 */
class FXGLInstancedBufferAttribute extends GLBufferAttribute {
  public readonly isInstancedBufferAttribute = true;
  public readonly meshPerAttribute = 1;
}

/**
 * `InstancedBufferGeometry.setAttribute` is typed only for `BufferAttribute`/
 * `InterleavedBufferAttribute` - its `Attributes` generic defaults to `NormalBufferAttributes`,
 * and `InstancedBufferGeometry` itself is declared non-generic, so the wider
 * `NormalOrGLBufferAttributes` union (which DOES include `GLBufferAttribute`) is unreachable
 * through it at the type level, even though `GLBufferAttribute` is a real, three.js-documented
 * attribute type for exactly this GPGPU use case. Narrow, isolated escape hatch - matches the
 * existing three.js-typing-gap precedent in `FXInstancedParticle.invalidateInstanceCap`.
 */
function setInstancedGLAttribute(
  geometry: InstancedBufferGeometry,
  name: string,
  attribute: FXGLInstancedBufferAttribute,
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (geometry as any).setAttribute(name, attribute);
}

/**
 * @internal GPU-resident sibling of `FXInstancedParticle`: same instanced-mesh shape (one base
 * primitive drawn `capacity` times, one property buffer per declared varying), but every property
 * buffer is a **ping-pong pair** of raw `WebGLBuffer`s the transform-feedback simulation holder
 * writes directly - never a `Float32Array`-backed `InstancedBufferAttribute` three.js uploads
 * itself (`FXInstancedParticle`'s own mechanism, untouched). Capacity is fixed at construction, no
 * growth: this class is never resized, unlike `FXInstancedParticle.ensureCapacity` (a deferred
 * future extension, not required for correctness today). Every
 * particle slot is always drawn (`instanceCount` is always `capacity`) - the CPU never knows the
 * true live count for a GPU-driven emitter, so dead slots are hidden by the render shader's own
 * age/lifetime test, not by shrinking the draw range.
 */
export class FXTransformFeedbackParticle extends Mesh {
  public readonly propertyBuffers: Record<string, FXGLInstancedBufferAttribute> = {};
  public readonly capacity: number;

  private readonly instancedGeometry: InstancedBufferGeometry;
  private readonly gl: WebGL2RenderingContext;

  // Per-buffer-name ping-pong pair; `currentIndex[name]` (0 or 1) is which half is the currently
  // valid, renderable side - the other half is what the transform-feedback pass writes into this
  // tick. Never read and written by name in the same pass (see `readBuffer`/`writeBuffer`).
  private readonly rawBufferPairs: Record<string, readonly [WebGLBuffer, WebGLBuffer]> = {};
  private readonly currentIndex: Record<string, 0 | 1> = {};
  private readonly strides: Record<string, number> = {};

  constructor(
    gl: WebGL2RenderingContext,
    varyings: Record<string, GLTypeInfo>,
    capacity: number,
    material: Material,
    baseGeometry: BufferGeometry,
  ) {
    const instancedGeometry = new InstancedBufferGeometry();

    // Copy the base geometry's position/uv/normal + index onto the instanced geometry, same as
    // FXInstancedParticle - these stay real, CPU-readable BufferAttributes (the base primitive's
    // own shape, not per-particle state), borrowed by reference, never disposed here.
    const baseIndex = baseGeometry.getIndex();
    if (baseIndex !== null) {
      instancedGeometry.setIndex(baseIndex);
    }
    instancedGeometry.setAttribute("position", baseGeometry.getAttribute("position"));
    instancedGeometry.setAttribute("uv", baseGeometry.getAttribute("uv"));
    instancedGeometry.setAttribute("normal", baseGeometry.getAttribute("normal"));

    super(instancedGeometry, material);

    this.frustumCulled = false;
    this.gl = gl;
    this.instancedGeometry = instancedGeometry;
    this.capacity = capacity;
    this.instancedGeometry.instanceCount = capacity;

    for (const name in varyings) {
      const { bufferSize } = varyings[name];
      this.strides[name] = bufferSize;
      const bufferA = this.createSizedBuffer(bufferSize, capacity);
      const bufferB = this.createSizedBuffer(bufferSize, capacity);
      this.rawBufferPairs[name] = [bufferA, bufferB];
      this.currentIndex[name] = 0;

      const attribute = new FXGLInstancedBufferAttribute(
        bufferA,
        gl.FLOAT,
        bufferSize,
        4,
        capacity,
      );
      setInstancedGLAttribute(this.instancedGeometry, `a_${name}`, attribute);
      this.propertyBuffers[name] = attribute;
    }
  }

  /** The buffer transform feedback should bind as its `in` (read) source this tick - last tick's
   *  result, or uninitialized garbage on the very first tick (safe: the assembled program's spawn
   *  branch always zero-defaults every buffer before the graph's own writes, so a freshly claimed
   *  slot never actually reads it before being overwritten). */
  public readBuffer(name: string): WebGLBuffer {
    return this.rawBufferPairs[name][this.currentIndex[name]];
  }

  /** The buffer transform feedback should bind as its transform-feedback (write) target this tick
   *  - the stale half of the pair, about to become current once `swapBuffers` runs. */
  public writeBuffer(name: string): WebGLBuffer {
    return this.rawBufferPairs[name][this.currentIndex[name] === 0 ? 1 : 0];
  }

  /**
   * Call once per state buffer after a tick's transform-feedback pass has finished writing
   * `writeBuffer(name)`: flips which half is current, and replaces the whole attribute object on
   * the geometry - never just `.setBuffer()` + `.needsUpdate` on the existing one. Confirmed by
   * reading `WebGLBindingStates.needsUpdate()` (`WebGLBindingStates.js:166-209`): it decides
   * whether to rebind a cached VAO's vertex-attribute pointers purely by comparing attribute
   * OBJECT identity, never `.version`/`.buffer` - reusing the same attribute instance across a
   * swap would leave the render draw silently bound to the FIRST buffer forever (independently
   * confirmed against three.js issue #22843, which describes the identical root cause). Mirrors
   * `FXInstancedParticle.ensureCapacity`, which replaces the whole `InstancedBufferAttribute` for
   * the same reason - there discovered as an array-reallocation side effect, here load-bearing on
   * its own since nothing about capacity itself ever changes.
   */
  public swapBuffers(name: string): void {
    const nextIndex = this.currentIndex[name] === 0 ? 1 : 0;
    this.currentIndex[name] = nextIndex;
    const stride = this.strides[name];
    const attribute = new FXGLInstancedBufferAttribute(
      this.rawBufferPairs[name][nextIndex],
      this.gl.FLOAT,
      stride,
      4,
      this.capacity,
    );
    setInstancedGLAttribute(this.instancedGeometry, `a_${name}`, attribute);
    this.propertyBuffers[name] = attribute;
  }

  public drop(): void {
    // No live-particle count to reset for a GPU-driven emitter (instanceCount is always
    // `capacity`) - a reset instead means "everything currently alive should read as dead", which
    // is the simulation holder's job (it owns dt/age, not this buffer-holding class).
  }

  /**
   * Swaps the mounted material and base geometry in place for a render-only structural edit -
   * every ping-pong state buffer and `capacity` are left completely untouched, so playback never
   * resets. Never called when the varyings shape itself changed (the driver's own
   * `applyRenderArtifact` guards that) - only the constructor path handles a real buffer-layout
   * change.
   */
  public replaceMaterialAndBaseGeometry(material: Material, baseGeometry: BufferGeometry): void {
    // Detach the previous base attributes first, same as destroy()'s dance: they were borrowed by
    // reference from a caller-owned geometry (possibly shared with other live consumers), so they
    // must never be disposed here.
    this.instancedGeometry.deleteAttribute("position");
    this.instancedGeometry.deleteAttribute("uv");
    this.instancedGeometry.deleteAttribute("normal");
    this.instancedGeometry.setIndex(null);

    const baseIndex = baseGeometry.getIndex();
    if (baseIndex !== null) {
      this.instancedGeometry.setIndex(baseIndex);
    }
    this.instancedGeometry.setAttribute("position", baseGeometry.getAttribute("position"));
    this.instancedGeometry.setAttribute("uv", baseGeometry.getAttribute("uv"));
    this.instancedGeometry.setAttribute("normal", baseGeometry.getAttribute("normal"));

    // The mounted material IS disposable here (unlike the base geometry attributes above) - it was
    // built exclusively for this mesh, never shared.
    (this.material as Material | undefined)?.dispose();
    this.material = material;
  }

  // Disposes the instanced geometry, the currently mounted material, and every raw ping-pong
  // buffer this instance owns - never the base geometry's borrowed position/uv/normal/index.
  public destroy(): void {
    this.instancedGeometry.deleteAttribute("position");
    this.instancedGeometry.deleteAttribute("uv");
    this.instancedGeometry.deleteAttribute("normal");
    this.instancedGeometry.setIndex(null);
    this.instancedGeometry.dispose();
    (this.material as Material | undefined)?.dispose();
    for (const name in this.rawBufferPairs) {
      const [bufferA, bufferB] = this.rawBufferPairs[name];
      this.gl.deleteBuffer(bufferA);
      this.gl.deleteBuffer(bufferB);
    }
  }

  private createSizedBuffer(itemSize: number, count: number): WebGLBuffer {
    const buffer = this.gl.createBuffer();
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
    // Sized but uninitialized (garbage) - the spawn branch's zero-default (see the constructor
    // doc) makes this safe for every buffer, core and attribute alike.
    this.gl.bufferData(
      this.gl.ARRAY_BUFFER,
      itemSize * count * Float32Array.BYTES_PER_ELEMENT,
      this.gl.DYNAMIC_DRAW,
    );
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, null);
    return buffer;
  }
}

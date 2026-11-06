import type { BufferGeometry, Material } from "three";
import { GLBufferAttribute, InstancedBufferGeometry, Mesh } from "three";
import type { GLTypeInfo } from "./glTypeInfo.js";

/** One state buffer's place in a particle's interleaved slot, in floats. */
export interface FXSlotField {
  /** The mesh's property key (`position`, `lifecycle`, `fx_<name>`). */
  readonly name: string;
  readonly components: number;
  readonly offset: number;
}

/**
 * The interleaved per-particle slot a transform-feedback kernel writes: its state buffers back to
 * back, in the kernel's buffer order, `stride` floats in all. That order is also the order of the
 * kernel's input locations and output varyings, so a field's index is its attribute location.
 */
export interface FXSlotLayout {
  readonly stride: number;
  readonly fields: readonly FXSlotField[];
}

/** Lays `buffers` out back to back, in order. */
export function slotLayout(
  buffers: readonly { readonly name: string; readonly components: number }[],
): FXSlotLayout {
  let stride = 0;
  const fields = buffers.map((buffer) => {
    const field = { name: buffer.name, components: buffer.components, offset: stride };
    stride += buffer.components;
    return field;
  });
  return { stride, fields };
}

/**
 * @internal A `GLBufferAttribute` additionally declared instanced (divisor 1, one value per drawn
 * particle instead of per vertex): three drives the per-instance divisor purely from
 * `isInstancedBufferAttribute`/`meshPerAttribute` on the attribute object (`WebGLBindingStates`),
 * which a plain `GLBufferAttribute` never sets. Backs the attributes the kernel does not write.
 */
class FXGLInstancedBufferAttribute extends GLBufferAttribute {
  public readonly isInstancedBufferAttribute = true;
  public readonly meshPerAttribute = 1;
}

/**
 * @internal One field of the interleaved slot, as three's renderer reads it: per instance, at its
 * own offset, with the slot as stride, straight from our raw `WebGLBuffer`. No three class does
 * that - a `GLBufferAttribute` is always bound tightly packed, and an `InterleavedBufferAttribute`
 * needs a CPU array three uploads itself - so this duck-types both: `isGLBufferAttribute` makes
 * `WebGLAttributes` register `buffer` as is, and `isInterleavedBufferAttribute` over an
 * `isInstancedInterleavedBuffer` makes `WebGLBindingStates` bind it with `stride`/`offset` and a
 * divisor. Its `data` is itself, because three looks the buffer up through `data` - before or
 * after checking `isGLBufferAttribute`, depending on the version; this works in either order
 * (checked against three 0.157, 0.165 and 0.179 on real WebGL2).
 */
class FXInterleavedGLAttribute {
  public readonly isGLBufferAttribute = true;
  public readonly isInterleavedBufferAttribute = true;
  public readonly isInstancedInterleavedBuffer = true;
  public readonly meshPerAttribute = 1;
  public readonly type: number;
  public readonly elementSize = Float32Array.BYTES_PER_ELEMENT;
  public readonly normalized = false;
  public readonly version = 0;
  public readonly name = "";

  constructor(
    gl: WebGL2RenderingContext,
    public readonly buffer: WebGLBuffer,
    public readonly itemSize: number,
    public readonly offset: number,
    public readonly stride: number,
    public readonly count: number,
  ) {
    this.type = gl.FLOAT;
  }

  public get data(): this {
    return this;
  }
}

type FXParticleAttribute = FXGLInstancedBufferAttribute | FXInterleavedGLAttribute;

/**
 * `InstancedBufferGeometry.setAttribute` is typed only for `BufferAttribute`/
 * `InterleavedBufferAttribute`, though three's renderer takes both shapes above. Narrow, isolated
 * escape hatch - matches the three.js-typing-gap precedent in
 * `FXInstancedParticle.invalidateInstanceCap`.
 */
function setInstancedGLAttribute(
  geometry: InstancedBufferGeometry,
  name: string,
  attribute: FXParticleAttribute,
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (geometry as any).setAttribute(name, attribute);
}

/**
 * @internal GPU-resident sibling of `FXInstancedParticle`: the same instanced-mesh shape (one base
 * primitive drawn `capacity` times, an `a_<name>` attribute per declared varying), but its state
 * lives in one **ping-pong pair** of raw `WebGLBuffer`s that the transform-feedback simulation
 * holder writes directly, each particle one interleaved slot of {@link FXSlotLayout} - never a
 * `Float32Array` three uploads itself. A varying the kernel does not write (an attribute only the
 * render graph reads) gets a buffer of its own, zero-filled once and never swapped - the value the
 * JS backend gives it too.
 *
 * Capacity is fixed at construction, no growth (unlike `FXInstancedParticle.ensureCapacity`).
 * Every particle slot is always drawn (`instanceCount` is always `capacity`) - the CPU never knows
 * the true live count for a GPU-driven emitter, so dead slots are hidden by the render shader's
 * own age/lifetime test, not by shrinking the draw range.
 */
export class FXTransformFeedbackParticle extends Mesh {
  public readonly propertyBuffers: Record<string, FXParticleAttribute> = {};
  public readonly capacity: number;

  private readonly layout: FXSlotLayout;
  private readonly instancedGeometry: InstancedBufferGeometry;
  private readonly gl: WebGL2RenderingContext;

  // `currentIndex` is which half of the pair is the valid, renderable side; the other is what the
  // next transform-feedback pass writes. Never read and written in the same pass.
  private readonly slotBuffers: readonly [WebGLBuffer, WebGLBuffer];
  private currentIndex: 0 | 1 = 0;
  private readonly constantBuffers: WebGLBuffer[] = [];

  constructor(
    gl: WebGL2RenderingContext,
    layout: FXSlotLayout,
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
    this.layout = layout;
    this.instancedGeometry.instanceCount = capacity;

    // Sized but uninitialized (garbage) - the kernel's spawn branch zero-defaults every field of
    // a slot it claims, so a slot is never read before it is written.
    this.slotBuffers = [
      this.createSizedBuffer(layout.stride * capacity),
      this.createSizedBuffer(layout.stride * capacity),
    ];
    this.mountSlotAttributes();

    const written = new Set(layout.fields.map((field) => field.name));
    for (const name in varyings) {
      if (written.has(name)) {
        continue;
      }
      const { bufferSize } = varyings[name];
      const buffer = this.createZeroedBuffer(bufferSize * capacity);
      this.constantBuffers.push(buffer);
      const attribute = new FXGLInstancedBufferAttribute(buffer, gl.FLOAT, bufferSize, 4, capacity);
      setInstancedGLAttribute(this.instancedGeometry, `a_${name}`, attribute);
      this.propertyBuffers[name] = attribute;
    }
  }

  /** The half a transform-feedback pass reads as its input - last pass's result. */
  public readBuffer(): WebGLBuffer {
    return this.slotBuffers[this.currentIndex];
  }

  /** The half a transform-feedback pass writes - the stale one, current once swapped. */
  public writeBuffer(): WebGLBuffer {
    return this.slotBuffers[this.currentIndex === 0 ? 1 : 0];
  }

  /**
   * Call once after a pass has written {@link writeBuffer}: flips which half is current and gives
   * every field a fresh attribute object on the new half - never the same object retargeted. Three
   * decides whether a cached VAO needs its pointers rebound purely by attribute object identity
   * (`WebGLBindingStates.needsUpdate`), so a reused object would leave the draw bound to the first
   * buffer forever (three.js issue #22843, the same root cause).
   */
  public swapBuffers(): void {
    this.currentIndex = this.currentIndex === 0 ? 1 : 0;
    this.mountSlotAttributes();
  }

  public drop(): void {
    // No live-particle count to reset for a GPU-driven emitter (instanceCount is always
    // `capacity`) - a reset instead means "everything currently alive should read as dead", which
    // is the simulation holder's job (it owns dt/age, not this buffer-holding class).
  }

  /**
   * Swaps the mounted material and base geometry in place for a render-only structural edit -
   * the state buffers and `capacity` are left completely untouched, so playback never resets.
   * Never called when the varyings shape itself changed (the driver's own `applyRenderArtifact`
   * guards that) - only the constructor handles a real layout change.
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

  // Disposes the instanced geometry, the currently mounted material, and every raw buffer this
  // instance owns - never the base geometry's borrowed position/uv/normal/index.
  public destroy(): void {
    this.instancedGeometry.deleteAttribute("position");
    this.instancedGeometry.deleteAttribute("uv");
    this.instancedGeometry.deleteAttribute("normal");
    this.instancedGeometry.setIndex(null);
    this.instancedGeometry.dispose();
    (this.material as Material | undefined)?.dispose();
    for (const buffer of [...this.slotBuffers, ...this.constantBuffers]) {
      this.gl.deleteBuffer(buffer);
    }
  }

  /** Points every slot field's `a_<name>` attribute at the current half. */
  private mountSlotAttributes(): void {
    const buffer = this.readBuffer();
    for (const field of this.layout.fields) {
      const attribute = new FXInterleavedGLAttribute(
        this.gl,
        buffer,
        field.components,
        field.offset,
        this.layout.stride,
        this.capacity,
      );
      setInstancedGLAttribute(this.instancedGeometry, `a_${field.name}`, attribute);
      this.propertyBuffers[field.name] = attribute;
    }
  }

  /** A buffer of `floats` floats, sized but uninitialized. */
  private createSizedBuffer(floats: number): WebGLBuffer {
    const buffer = this.gl.createBuffer();
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
    this.gl.bufferData(
      this.gl.ARRAY_BUFFER,
      floats * Float32Array.BYTES_PER_ELEMENT,
      this.gl.DYNAMIC_DRAW,
    );
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, null);
    return buffer;
  }

  /** A buffer of `floats` zeros. */
  private createZeroedBuffer(floats: number): WebGLBuffer {
    const buffer = this.gl.createBuffer();
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array(floats), this.gl.DYNAMIC_DRAW);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, null);
    return buffer;
  }
}

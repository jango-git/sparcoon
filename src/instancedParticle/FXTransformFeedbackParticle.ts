import type { BufferGeometry, InterleavedBufferAttribute, Material } from "three";
import { InstancedBufferGeometry, Mesh } from "three";
import type { FXBufferLayout } from "../artifact/FXArtifact.js";
import { meshPropertyKeyFor } from "../coreLayout.js";
import type { FXPackedAttribute } from "../render/FXAttributePacking.js";
import { packConsecutive } from "../render/FXAttributePacking.js";

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
 * kernel's input locations and output varyings, so a field's index is its attribute location -
 * which is why the runtime never reorders it: the editor lays the kernel's buffers out in
 * `packingOrder` (see `FXAttributePacking.ts`), and {@link packed} only groups over that.
 */
export interface FXSlotLayout {
  readonly stride: number;
  readonly fields: readonly FXSlotField[];
  /** Every field, as the render reads it: adjacent fields packed into views of up to four floats,
   *  each bound as `a_<view.name>` (`a_pack0`, ...). */
  readonly packed: readonly FXPackedAttribute[];
}

/** Lays `buffers` out back to back, in order, and packs the result. */
export function slotLayout(
  buffers: readonly { readonly name: string; readonly components: number }[],
): FXSlotLayout {
  let stride = 0;
  const fields = buffers.map((buffer) => {
    const field = { name: buffer.name, components: buffer.components, offset: stride };
    stride += buffer.components;
    return field;
  });
  return { stride, fields, packed: packConsecutive(fields, (index) => `pack${String(index)}`) };
}

/**
 * @internal The interleaved slot a kernel with these `buffers` writes: in order, under the mesh's
 * property keys. A kernel's `buffers[].name` is the raw kernel name (`velocity`); the mesh keys a
 * non-core buffer as `fx_velocity`, the same mapping the JS backend uses (`meshPropertyKeyFor`).
 * The simulation holder lays its slot out by this, and the render budget does too.
 */
export function kernelSlotLayout(buffers: readonly FXBufferLayout[]): FXSlotLayout {
  return slotLayout(
    buffers.map((buffer) => ({
      name: meshPropertyKeyFor(buffer.name),
      components: buffer.stride,
    })),
  );
}

/**
 * @internal One packed view of the interleaved slot, as three's renderer reads it: per instance, at
 * its own offset, with the slot as stride, straight from our raw `WebGLBuffer`. No three class does
 * that - a `GLBufferAttribute` is always bound tightly packed, and an `InterleavedBufferAttribute`
 * needs a CPU array three uploads itself - so this duck-types both: `isGLBufferAttribute` makes
 * `WebGLAttributes` register `buffer` as is, and `isInterleavedBufferAttribute` over an
 * `isInstancedInterleavedBuffer` makes `WebGLBindingStates` bind it with `stride`/`offset` and a
 * divisor. Its `data` is itself, because three looks the buffer up through `data` - before or
 * after checking `isGLBufferAttribute`, depending on the version; this works in either order
 * (checked against three 0.157, 0.165 and 0.179 on real WebGL2).
 */
export class FXInterleavedGLAttribute {
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

/** An attribute three binds over one of our buffers: interleaved over a CPU array, or over a raw
 *  `WebGLBuffer` ({@link FXInterleavedGLAttribute}). */
export type FXMountableAttribute = InterleavedBufferAttribute | FXInterleavedGLAttribute;

/**
 * @internal Sets one attribute per packed view onto `geometry` - `name(view)`, made by
 * `makeView(view)` - the one mounting loop the CPU and GPU trail histories and the GPU particle
 * mesh share, so what is bound is always exactly the views the layout lists (and the material
 * declares). `InstancedBufferGeometry.setAttribute` is typed only for three's own attribute
 * classes, though its renderer takes {@link FXInterleavedGLAttribute} too: a narrow escape hatch
 * for a gap in three's typings, not in its behavior.
 */
export function mountPacked(
  geometry: InstancedBufferGeometry,
  packed: readonly FXPackedAttribute[],
  name: (view: FXPackedAttribute) => string,
  makeView: (view: FXPackedAttribute) => FXMountableAttribute,
): void {
  for (const view of packed) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (geometry as any).setAttribute(name(view), makeView(view));
  }
}

/**
 * @internal GPU-resident sibling of `FXInstancedParticle`: the same instanced-mesh shape (one base
 * primitive drawn `capacity` times), but its state lives in one **ping-pong pair** of raw
 * `WebGLBuffer`s that the transform-feedback simulation holder writes directly, each particle one
 * interleaved slot of {@link FXSlotLayout} - never a `Float32Array` three uploads itself. The render
 * reads the slot through its packed views (`FXSlotLayout.packed`), several fields per attribute. A
 * field the kernel does not write (an attribute only the render graph reads) has no buffer here at
 * all: the material declares it as the constant zero (`FXParticleLayout.missing`).
 *
 * Capacity is fixed at construction, no growth - the same ring as `FXInstancedParticle`.
 * Every particle slot is always drawn (`instanceCount` is always `capacity`) - the CPU never knows
 * the true live count for a GPU-driven emitter, so dead slots are hidden by the render shader's
 * own age/lifetime test, not by shrinking the draw range.
 */
export class FXTransformFeedbackParticle extends Mesh {
  public readonly capacity: number;

  public readonly layout: FXSlotLayout;
  private readonly instancedGeometry: InstancedBufferGeometry;
  private readonly gl: WebGL2RenderingContext;

  // `currentIndex` is which half of the pair is the valid, renderable side; the other is what the
  // next transform-feedback pass writes. Never read and written in the same pass.
  private readonly slotBuffers: readonly [WebGLBuffer, WebGLBuffer];
  private currentIndex: 0 | 1 = 0;

  constructor(
    gl: WebGL2RenderingContext,
    layout: FXSlotLayout,
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
   * every packed view a fresh attribute object on the new half - never the same object retargeted. Three
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
    for (const buffer of this.slotBuffers) {
      this.gl.deleteBuffer(buffer);
    }
  }

  /** Points every packed view's `a_<view.name>` attribute at the current half. */
  private mountSlotAttributes(): void {
    const buffer = this.readBuffer();
    mountPacked(
      this.instancedGeometry,
      this.layout.packed,
      (view) => `a_${view.name}`,
      (view) =>
        new FXInterleavedGLAttribute(
          this.gl,
          buffer,
          view.components,
          view.offset,
          this.layout.stride,
          this.capacity,
        ),
    );
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
}

import type { BufferGeometry, Material } from "three";
import { InstancedBufferGeometry, Mesh } from "three";

import type { FXPackedAttribute } from "../render/FXAttributePacking.js";
import {
  attachBaseGeometry,
  detachBaseGeometry,
  remountParticleViews,
} from "./FXMeshGeometry.Internal.js";
import type { FXSlotLayout } from "./FXParticleSlot.js";

/**
 * @internal One packed view of the interleaved slot, bound over a raw `WebGLBuffer`. Three's
 * `GLBufferAttribute` is always tightly packed and `InterleavedBufferAttribute` needs a CPU array,
 * so this object duck-types both: `isGLBufferAttribute` registers `buffer` as is,
 * `isInterleavedBufferAttribute` and `isInstancedInterleavedBuffer` bind it with `stride`, `offset`
 * and a divisor (three >= 0.187 takes `stride` only from an `isInterleavedBuffer`, else
 * `itemSize`). `data` is the attribute itself because three looks the buffer up through `data`,
 * before or after checking `isGLBufferAttribute` depending on the version.
 */
export class FXInterleavedGLAttribute {
  public readonly isGLBufferAttribute = true;
  public readonly isInterleavedBufferAttribute = true;
  public readonly isInterleavedBuffer = true;
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

/**
 * @internal GPU sibling of `FXInstancedParticle`: the same fixed-capacity ring, but the state lives
 * in a ping-pong pair of `WebGLBuffer`s written by the transform-feedback holder, each particle one
 * interleaved slot of {@link FXSlotLayout}. The render reads the slot through the views its layout
 * packs (`FXParticleLayout.packed`). A field the kernel does not write has no buffer: the material
 * declares it as a zero constant (`FXParticleLayout.missing`).
 *
 * Once a birth is seeded every slot is drawn (`instanceCount` is `capacity`) and the render
 * shader's age test hides dead ones. Before the first birth, and after {@link drop}, nothing is
 * drawn.
 */
export class FXTransformFeedbackParticle extends Mesh {
  public readonly capacity: number;

  public readonly slot: FXSlotLayout;
  private readonly instancedGeometry: InstancedBufferGeometry;
  private readonly gl: WebGL2RenderingContext;

  // `currentIndex` is which half of the pair is the valid, renderable side; the other is what the
  // next transform-feedback pass writes. Never read and written in the same pass.
  private readonly slotBuffers: readonly [WebGLBuffer, WebGLBuffer];
  private currentIndex: 0 | 1 = 0;
  // The slot the next birth takes, mod capacity: the same cursor as `FXInstancedParticle`'s.
  private cursor = 0;
  // The views bound over the current half - the current render's (see `particleLayout`).
  private views: readonly FXPackedAttribute[] = [];

  constructor(
    gl: WebGL2RenderingContext,
    slot: FXSlotLayout,
    views: readonly FXPackedAttribute[],
    capacity: number,
    material: Material,
    baseGeometry: BufferGeometry,
  ) {
    const instancedGeometry = new InstancedBufferGeometry();
    attachBaseGeometry(instancedGeometry, baseGeometry);

    super(instancedGeometry, material);

    this.frustumCulled = false;
    this.gl = gl;
    this.instancedGeometry = instancedGeometry;
    this.capacity = capacity;
    this.slot = slot;
    this.instancedGeometry.instanceCount = 0;

    // WebGL zero-fills a new buffer: every slot reads as dead (age 0 >= lifetime 0).
    this.slotBuffers = [this.gl.createBuffer(), this.gl.createBuffer()];
    this.zeroSlotBuffers();
    this.mountViews(views);
  }

  /**
   * The slot the next birth takes: in birth order, the ring runs from it (the oldest particle once
   * the ring has gone round, a never-claimed dead slot before) to the slot before it (the newest).
   */
  public get nextSlot(): number {
    return this.cursor;
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
    this.mountViews(this.views);
  }

  /**
   * Claims `count` slots at the cursor, overwriting whatever occupies them, and draws every slot
   * from now on; returns the first. The cursor advances by `count` mod capacity, as
   * `FXInstancedParticle.claim`'s does: a claim larger than the ring takes every slot once from
   * the old cursor.
   */
  public claim(count: number): number {
    const start = this.cursor;
    this.cursor = (this.cursor + count) % this.capacity;
    this.instancedGeometry.instanceCount = this.capacity;
    return start;
  }

  /** Kills every particle at once: zeroes both halves (all dead), rewinds the cursor and draws
   *  nothing until the next {@link claim}. */
  public drop(): void {
    this.zeroSlotBuffers();
    this.cursor = 0;
    this.instancedGeometry.instanceCount = 0;
  }

  /**
   * Swaps the mounted material, base geometry and views in place for a render-only structural edit -
   * the state buffers and `capacity` are left completely untouched, so playback never resets; only
   * the views bound over them follow the new render's reads.
   */
  public replaceMaterialAndBaseGeometry(
    material: Material,
    baseGeometry: BufferGeometry,
    views: readonly FXPackedAttribute[],
  ): void {
    detachBaseGeometry(this.instancedGeometry);
    attachBaseGeometry(this.instancedGeometry, baseGeometry);

    this.mountViews(views);

    // The mounted material IS disposable here (unlike the base geometry attributes above) - it was
    // built exclusively for this mesh, never shared.
    (this.material as Material | undefined)?.dispose();
    this.material = material;
  }

  // Disposes the instanced geometry, the currently mounted material, and every raw buffer this
  // instance owns - never the base geometry's borrowed position/uv/normal/index.
  public destroy(): void {
    detachBaseGeometry(this.instancedGeometry);
    this.instancedGeometry.dispose();
    (this.material as Material | undefined)?.dispose();
    for (const buffer of this.slotBuffers) {
      this.gl.deleteBuffer(buffer);
    }
  }

  /** Binds `views` over the current half, in place of the views bound so far. */
  private mountViews(views: readonly FXPackedAttribute[]): void {
    const buffer = this.readBuffer();
    remountParticleViews(
      this.instancedGeometry,
      this.views,
      views,
      (view) =>
        new FXInterleavedGLAttribute(
          this.gl,
          buffer,
          view.components,
          view.offset,
          this.slot.stride,
          this.capacity,
        ),
    );
    this.views = views;
  }

  // Reallocating is the cheapest zero-fill: WebGL guarantees a new data store reads as zeros.
  private zeroSlotBuffers(): void {
    const bytes = this.slot.stride * this.capacity * Float32Array.BYTES_PER_ELEMENT;
    for (const buffer of this.slotBuffers) {
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
      this.gl.bufferData(this.gl.ARRAY_BUFFER, bytes, this.gl.DYNAMIC_DRAW);
    }
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, null);
  }
}

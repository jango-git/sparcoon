import type { Vector3, WebGLRenderer } from "three";

import { FX_AGE, FX_LIFETIME, FX_POSITION_X, FX_POSITION_Y, FX_POSITION_Z } from "../coreLayout.js";
import {
  coreOffsets,
  type FXCoreOffsets,
  type FXSlotLayout,
} from "../instancedParticle/FXParticleSlot.js";
import {
  createDataTexture,
  dataTextureRows,
  dataTextureSize,
  type FXDataTextureSize,
  prepareDataUpload,
  threeTextureOf,
} from "../render/FXDataTexture.Internal.js";
import { deferStateReset } from "../render/FXDeferredStateReset.Internal.js";
import {
  FX_PARTICLE_SLOTS_GLSL,
  FX_PARTICLE_SLOTS_UNIFORM,
  type FXParticleTextures,
} from "../render/FXParticleTextures.Internal.js";
import { type FXContextLease, FXContextLeases } from "./FXContextLeases.Internal.js";
import { linkProgram } from "./FXProgramLink.Internal.js";

const ERROR_PREFIX = "FXGPUParticleOrder";

const RANK_UNIFORMS = [
  FX_PARTICLE_SLOTS_UNIFORM,
  "u_capacity",
  "u_stride",
  "u_position",
  "u_lifecycle",
  "u_camera",
  "u_orderSize",
] as const;

type FXRankUniform = (typeof RANK_UNIFORMS)[number];

const slotFloat = (offset: string, component: number): string =>
  `fxParticleSlotFloat(start + ${offset} + ${String(component)})`;

// One point per slot, drawn into the order texture at the slot's rank: how many slots are drawn
// before it.
const RANK_VERTEX_SOURCE = [
  "#version 300 es",
  "precision highp float;",
  "precision highp int;",
  "uniform int u_capacity;",
  "uniform int u_stride;",
  "uniform int u_position;",
  "uniform int u_lifecycle;",
  "uniform vec3 u_camera;",
  "uniform ivec2 u_orderSize;",
  "flat out highp uint v_slot;",
  FX_PARTICLE_SLOTS_GLSL,
  // The squared distance from the camera, -1 for a dead slot.
  "float fxSortKey(int slot) {",
  "  int start = slot * u_stride;",
  `  if (${slotFloat("u_lifecycle", FX_AGE)} >= ${slotFloat("u_lifecycle", FX_LIFETIME)}) {`,
  "    return -1.0;",
  "  }",
  `  vec3 delta = vec3(${slotFloat("u_position", FX_POSITION_X)}, ` +
    `${slotFloat("u_position", FX_POSITION_Y)}, ${slotFloat("u_position", FX_POSITION_Z)}) - u_camera;`,
  "  return dot(delta, delta);",
  "}",
  "void main() {",
  "  float key = fxSortKey(gl_VertexID);",
  "  int rank = 0;",
  "  for (int other = 0; other < u_capacity; other++) {",
  "    float otherKey = fxSortKey(other);",
  // Farther first; of two at one distance the lower slot, so no two slots share a rank.
  "    if (otherKey > key || (otherKey == key && other < gl_VertexID)) {",
  "      rank++;",
  "    }",
  "  }",
  "  vec2 texel = vec2(fxParticleTexel(u_orderSize, rank)) + 0.5;",
  "  gl_Position = vec4(texel / vec2(u_orderSize) * 2.0 - 1.0, 0.0, 1.0);",
  "  gl_PointSize = 1.0;",
  "  v_slot = uint(gl_VertexID);",
  "}",
].join("\n");

const RANK_FRAGMENT_SOURCE = [
  "#version 300 es",
  "precision highp float;",
  "precision highp int;",
  "flat in highp uint v_slot;",
  "layout(location = 0) out highp uint fxSlot;",
  "void main() {",
  "  fxSlot = v_slot;",
  "}",
].join("\n");

// One program for every order on a context: what differs between emitters is uniforms.
const rankPrograms = new FXContextLeases<"rank", WebGLProgram>((gl, program) => {
  gl.deleteProgram(program);
});

/**
 * @internal The back-to-front order of a sorted GPU emitter's particles, kept on the GPU, and the
 * {@link textures} its material draws them from. Before a draw, {@link prepare} copies the slots
 * into the slots texture if a pass wrote them since ({@link slotsWritten}), and on a frame that
 * sorts draws one point per slot into the order texture at the slot's rank. Ranking compares every slot with every
 * other in one draw - capacity squared comparisons, against a sorting network's dozens of passes,
 * each a render pass of its own on a tiled GPU. The order always lists every slot once, so a frame
 * between two sorts draws the last one's order; until the first, the slots in turn.
 */
export class FXGPUParticleOrder {
  public readonly textures: FXParticleTextures;

  private readonly gl: WebGL2RenderingContext;
  private readonly programLease: FXContextLease<WebGLProgram>;
  private readonly locations: Record<FXRankUniform, WebGLUniformLocation | null>;
  // Bound for the rank draw, which reads no attribute, instead of a VAO three manages.
  private readonly vao: WebGLVertexArrayObject;
  private readonly slotsTexture: WebGLTexture;
  private readonly orderTexture: WebGLTexture;
  private readonly framebuffer: WebGLFramebuffer;
  private readonly floats: number;
  private readonly slotsSize: FXDataTextureSize;
  private readonly orderSize: FXDataTextureSize;
  private readonly stride: number;
  private readonly core: FXCoreOffsets;
  // Whether a pass wrote the slots since they were last copied.
  private written = false;

  /**
   * The order of an emitter of `capacity` slots laid out as `slot`.
   * @throws When the program fails to link, the textures do not fit this GPU or the slot lacks a
   *   core field.
   */
  constructor(
    private readonly renderer: WebGLRenderer,
    slot: FXSlotLayout,
    private readonly capacity: number,
  ) {
    const gl = renderer.getContext() as WebGL2RenderingContext;
    this.gl = gl;
    this.core = coreOffsets(slot);
    this.stride = slot.stride;
    this.floats = slot.stride * capacity;
    this.slotsSize = dataTextureSize(gl, this.floats, `${ERROR_PREFIX}: the slots texture`);
    this.orderSize = dataTextureSize(gl, capacity, `${ERROR_PREFIX}: the order texture`);

    this.programLease = rankPrograms.acquire(gl, "rank", () =>
      linkProgram(gl, RANK_VERTEX_SOURCE, RANK_FRAGMENT_SOURCE, [], ERROR_PREFIX),
    );
    const program = this.programLease.resource;
    this.locations = Object.fromEntries(
      RANK_UNIFORMS.map((name) => [name, gl.getUniformLocation(program, name)]),
    ) as Record<FXRankUniform, WebGLUniformLocation | null>;
    this.vao = gl.createVertexArray();
    this.slotsTexture = createDataTexture(gl, gl.R32F, this.slotsSize);
    this.orderTexture = createDataTexture(gl, gl.R32UI, this.orderSize);
    this.framebuffer = gl.createFramebuffer();
    try {
      this.writeSlotsInTurn();
      this.attachOrder();
    } catch (error) {
      this.destroy();
      throw error;
    } finally {
      // Built outside the world's tick, possibly right before a draw.
      renderer.resetState();
    }
    this.textures = {
      slots: { value: threeTextureOf(renderer, this.slotsTexture) },
      order: { value: threeTextureOf(renderer, this.orderTexture) },
    };
  }

  /** Call after every pass that wrote the slots. */
  public slotsWritten(): void {
    this.written = true;
  }

  /**
   * Readies the draw: copies the slots from `buffer` (the half the mesh draws) when written since,
   * then, given `camera`, orders them back to front from it (world space, as the slots are).
   */
  public prepare(buffer: WebGLBuffer, camera: Vector3 | undefined): void {
    if (this.written) {
      this.capture(buffer);
      this.written = false;
    }
    if (camera !== undefined) {
      this.rank(camera);
    }
  }

  public destroy(): void {
    const gl = this.gl;
    gl.deleteFramebuffer(this.framebuffer);
    gl.deleteTexture(this.slotsTexture);
    gl.deleteTexture(this.orderTexture);
    gl.deleteVertexArray(this.vao);
    this.programLease.release();
  }

  private capture(buffer: WebGLBuffer): void {
    const gl = this.gl;
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, buffer);
    gl.bindTexture(gl.TEXTURE_2D, this.slotsTexture);
    prepareDataUpload(gl);
    for (const rows of dataTextureRows(this.floats, this.slotsSize)) {
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        rows.y,
        rows.width,
        rows.height,
        gl.RED,
        gl.FLOAT,
        rows.first * Float32Array.BYTES_PER_ELEMENT,
      );
    }
    // Left bound, it would be the source of three's next texture upload.
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
    deferStateReset(this.renderer);
  }

  private rank(camera: Vector3): void {
    const gl = this.gl;
    const locations = this.locations;
    this.renderer.state.useProgram(this.programLease.resource);
    gl.bindVertexArray(this.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, this.orderSize.width, this.orderSize.height);
    // Whatever three's last draw left set.
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.slotsTexture);
    gl.uniform1i(locations[FX_PARTICLE_SLOTS_UNIFORM], 0);
    gl.uniform1i(locations.u_capacity, this.capacity);
    gl.uniform1i(locations.u_stride, this.stride);
    gl.uniform1i(locations.u_position, this.core.position);
    gl.uniform1i(locations.u_lifecycle, this.core.lifecycle);
    gl.uniform3f(locations.u_camera, camera.x, camera.y, camera.z);
    gl.uniform2i(locations.u_orderSize, this.orderSize.width, this.orderSize.height);
    gl.drawArrays(gl.POINTS, 0, this.capacity);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    deferStateReset(this.renderer);
  }

  private writeSlotsInTurn(): void {
    const gl = this.gl;
    const slots = new Uint32Array(this.capacity);
    for (let slot = 0; slot < this.capacity; slot += 1) {
      slots[slot] = slot;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.orderTexture);
    for (const rows of dataTextureRows(this.capacity, this.orderSize)) {
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        rows.y,
        rows.width,
        rows.height,
        gl.RED_INTEGER,
        gl.UNSIGNED_INT,
        slots,
        rows.first,
      );
    }
  }

  private attachOrder(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.orderTexture,
      0,
    );
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(
        `${ERROR_PREFIX}: the order texture cannot be drawn into (${String(status)})`,
      );
    }
  }
}

import type { Material } from "three";
import { BufferAttribute, InstancedBufferGeometry, Mesh, type Texture } from "three";
import type { FXRenderArtifact } from "../artifact/FXArtifact.js";
import { FXArtifactMaterial } from "../render/FXArtifactMaterial.js";
import {
  createTrailUniforms,
  FX_TRAIL_MAX_FRAMES,
  type FXTrailUniforms,
} from "../render/FXArtifactMaterial.Internal.js";
import { type FXRenderBudget, trailMaterialBudget } from "../render/FXRenderBudget.js";
import type { FXTrailHistory } from "./FXTrailHistory.Internal.js";

/**
 * A trail behind every particle of an emitter: its render artifact (compiled against the editor's
 * trail target) and how much of each particle's path it keeps - `frames` recorded points, one
 * every `sampleInterval` seconds (at most one per tick), so the trail spans about
 * `(frames - 1) * max(sampleInterval, the time between two ticks)` seconds.
 */
export interface FXTrailOptions {
  readonly render: FXRenderArtifact;
  /** Recorded points per particle, 2..{@link FX_TRAIL_MAX_FRAMES}. */
  readonly frames: number;
  /** Seconds between two recorded points (at most one per tick); greater than zero. */
  readonly sampleInterval: number;
}

export { FX_TRAIL_MAX_FRAMES };

/**
 * Validates the trail options - in every build, not only in development: a trail is built once,
 * so the check costs nothing per frame, and a bad value would otherwise surface as a NaN clock
 * (`sampleInterval: 0`) or a typed-array `RangeError` far from its cause.
 */
export function assertValidTrailOptions(options: FXTrailOptions, context: string): void {
  const { frames, sampleInterval } = options;
  if (!Number.isInteger(frames) || frames < 2 || frames > FX_TRAIL_MAX_FRAMES) {
    throw new RangeError(
      `${context}.frames: expected an integer 2..${String(FX_TRAIL_MAX_FRAMES)}, got ${String(frames)}`,
    );
  }
  if (!Number.isFinite(sampleInterval) || sampleInterval <= 0) {
    throw new RangeError(
      `${context}.sampleInterval: expected a finite number > 0, got ${String(sampleInterval)}`,
    );
  }
}

/** The base quad of one segment: `x` along it (0 -> 1), `y` across it (-1 -> 1). */
function segmentQuad(): { position: BufferAttribute; index: BufferAttribute } {
  return {
    position: new BufferAttribute(new Float32Array([0, -1, 0, 0, 1, 0, 1, -1, 0, 1, 1, 0]), 3),
    index: new BufferAttribute(new Uint16Array([0, 2, 1, 1, 2, 3]), 1),
  };
}

/** How fast the measured time between two head moves follows a change (per move). */
const GAP_SMOOTHING = 0.2;

/**
 * @internal The trail of one emitter: a single instanced draw of `frames * capacity` ribbon
 * segments over an {@link FXTrailHistory}, plus the head bookkeeping that decides which history
 * frame each tick records into. Owned by an `FXEmitter`, which records after every simulated tick.
 *
 * Drawn after the emitter's particles at the same depth (three breaks a transparent tie by object
 * id, and the trail is built after them), so with plain blending the ribbon lies over a particle.
 */
export class FXTrail {
  public readonly mesh: Mesh;
  /** What this trail's material takes of a GPU's attributes and varyings, as built. */
  public readonly budget: FXRenderBudget;

  private readonly geometry: InstancedBufferGeometry;
  private readonly material: FXArtifactMaterial;
  private readonly uniforms: FXTrailUniforms;
  private readonly frames: number;
  private readonly sampleInterval: number;
  // Simulated seconds since this trail was built or last reset, and when each frame was recorded.
  private clock = 0;
  private readonly recordedAt: Float64Array;
  private head = 0;
  // When the head frame was last recorded one lap ago, before the head moved back onto it.
  private lapAgoHeadTime = 0;
  private sinceAdvance = 0;
  private recordedOnce = false;
  // The seconds between two head moves, as measured: the head moves at most once per tick, so a
  // sample interval shorter than a tick stretches the trail to the frame rate.
  private advanceGap: number;
  private lastAdvanceAt = 0;

  /**
   * @param history - Its `layout` is what the material reads: the recorded fields' packed views,
   *   and the reads it does not hold (zero).
   * @throws A `RangeError` for invalid `options` (see {@link assertValidTrailOptions}).
   */
  constructor(
    private readonly history: FXTrailHistory,
    options: FXTrailOptions,
    textures: Readonly<Record<string, Texture>> = {},
  ) {
    assertValidTrailOptions(options, "FXTrail.constructor.options");
    this.frames = options.frames;
    this.sampleInterval = options.sampleInterval;
    this.advanceGap = options.sampleInterval;
    this.recordedAt = new Float64Array(this.frames);
    this.uniforms = createTrailUniforms(this.frames, (this.frames - 1) * this.sampleInterval);

    this.material = new FXArtifactMaterial(options.render, textures);
    const threeMaterial = this.material.buildThreeTrailMaterial(history.layout, this.uniforms);
    this.budget = trailMaterialBudget(
      threeMaterial,
      options.render.options?.renderMode === "alphaHash",
    );

    const geometry = new InstancedBufferGeometry();
    const quad = segmentQuad();
    geometry.setIndex(quad.index);
    geometry.setAttribute("position", quad.position);
    history.mount(geometry);
    geometry.instanceCount = this.frames * history.capacity;
    this.geometry = geometry;

    this.mesh = new Mesh(geometry, threeMaterial);
    this.mesh.frustumCulled = false;
    this.mesh.name = "FXTrail";
  }

  /** The per-emitter material driver, for the clock, motion and parameter values. */
  public get artifactMaterial(): FXArtifactMaterial {
    return this.material;
  }

  /**
   * Records the emitter's state after a simulated tick of `deltaTime` seconds. The head moves on
   * to the next frame at most once per tick, once `sampleInterval` has passed since it last did;
   * otherwise the head frame is overwritten, so the trail's newest point follows the particle.
   */
  public record(deltaTime: number): void {
    this.clock += deltaTime;
    let advanced = false;
    if (this.recordedOnce) {
      this.sinceAdvance += deltaTime;
      if (this.sinceAdvance >= this.sampleInterval) {
        this.sinceAdvance %= this.sampleInterval;
        this.head = (this.head + 1) % this.frames;
        this.lapAgoHeadTime = this.recordedAt[this.head];
        advanced = true;
        const gap = this.clock - this.lastAdvanceAt;
        this.advanceGap += (gap - this.advanceGap) * GAP_SMOOTHING;
        this.lastAdvanceAt = this.clock;
      }
    } else {
      this.lastAdvanceAt = this.clock;
    }
    this.recordedOnce = true;
    this.history.record(this.head, advanced, this.clock);
    this.recordedAt[this.head] = this.clock;

    this.uniforms.head.value = this.head;
    this.uniforms.now.value = this.clock;
    // Halfway between the tail's time and the point the head frame held a lap ago, which is
    // older (it was recorded before the tail frame was): robust to float32 rounding either way.
    const tailTime = this.recordedAt[(this.head + 1) % this.frames];
    this.uniforms.tail.value = (this.lapAgoHeadTime + tailTime) / 2;
    this.uniforms.span.value = (this.frames - 1) * Math.max(this.sampleInterval, this.advanceGap);
    const ages = this.uniforms.ages.value;
    for (let i = 0; i < this.frames; i++) {
      ages[i] = this.clock - this.recordedAt[i];
    }
  }

  /** Forgets the whole recorded path: the trail is empty until the next tick records. */
  public reset(): void {
    this.history.clear();
    // Restarted along with it, so the recorded times stay small for float precision.
    this.clock = 0;
    this.head = 0;
    this.lapAgoHeadTime = 0;
    this.sinceAdvance = 0;
    this.recordedOnce = false;
    this.advanceGap = this.sampleInterval;
    this.lastAdvanceAt = 0;
    this.recordedAt.fill(0);
    this.uniforms.head.value = 0;
    this.uniforms.now.value = 0;
    this.uniforms.tail.value = 0;
    this.uniforms.span.value = (this.frames - 1) * this.sampleInterval;
    this.uniforms.ages.value.fill(0);
  }

  public destroy(): void {
    this.mesh.removeFromParent();
    // Releases three's GPU copies of every attribute, the history's included.
    this.geometry.dispose();
    (this.mesh.material as Material).dispose();
    this.material.destroy();
    this.history.destroy();
  }
}

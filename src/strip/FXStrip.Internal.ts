import type { ShaderMaterial } from "three";
import { BufferAttribute, InstancedBufferGeometry, Mesh } from "three";

import type { FXEmitterTransform } from "../artifact/FXArtifact.js";
import type { FXArtifactMaterial } from "../render/FXArtifactMaterial.js";
import { type FXRenderBudget, stripMaterialBudget } from "../render/FXRenderBudget.js";

/** @internal The pose and inheritance a birth from the emitter would take now. */
export interface FXStripBirth {
  readonly transform: FXEmitterTransform;
  readonly inherited: Float32Array;
}

/** @internal What an emitter's tick hands its strips to record. */
export interface FXStripFrame {
  /** Seconds the tick simulated, 0 on a paused tick. */
  readonly deltaTime: number;
  /** Set while a play emits from the emitter's pose: where its next birth would come from. */
  readonly birth: FXStripBirth | undefined;
}

/**
 * @internal A band an emitter draws through its particles, beside them - a trail (`FXTrail`) or a
 * ribbon (`FXRibbon`), each with its own render artifact and material. The emitter owns at most
 * one of each kind and drives every one the same way.
 */
export interface FXParticleStrip {
  readonly mesh: Mesh;
  /** What its material takes of a GPU's attributes and varyings, as built. */
  readonly budget: FXRenderBudget;
  /** The per-emitter material driver, for the clock, motion and parameter values. */
  readonly artifactMaterial: FXArtifactMaterial;
  /** Takes the emitter's state after a tick. */
  record(frame: FXStripFrame): void;
  /** Forgets everything recorded: it draws nothing until the next record. */
  reset(): void;
  /** Whether it draws nothing from before the emitter's last particle died, `sinceDeath` seconds
   *  ago - so the emitter can settle without cutting anything visible. */
  fadedBy(sinceDeath: number): boolean;
  destroy(): void;
}

/**
 * @internal What every strip draws with: one instanced draw of a base quad per segment - `x` along
 * the segment (0 -> 1), `y` across it (-1 -> 1) - over the attributes `mount` sets, in its own
 * material. The strip decides how many segments to draw.
 */
export class FXStripMesh {
  public readonly mesh: Mesh;
  /** What the material takes of a GPU, as built (see `stripMaterialBudget`). */
  public readonly budget: FXRenderBudget;

  private readonly geometry: InstancedBufferGeometry;
  private readonly threeMaterial: ShaderMaterial;

  constructor(
    name: string,
    public readonly material: FXArtifactMaterial,
    threeMaterial: ShaderMaterial,
    mount: (geometry: InstancedBufferGeometry) => void,
  ) {
    this.threeMaterial = threeMaterial;
    this.budget = stripMaterialBudget(
      threeMaterial,
      material.artifact.options?.renderMode === "alphaHash",
    );
    const geometry = new InstancedBufferGeometry();
    geometry.setIndex(new BufferAttribute(new Uint16Array([0, 2, 1, 1, 2, 3]), 1));
    geometry.setAttribute(
      "position",
      new BufferAttribute(new Float32Array([0, -1, 0, 0, 1, 0, 1, -1, 0, 1, 1, 0]), 3),
    );
    mount(geometry);
    geometry.instanceCount = 0;
    this.geometry = geometry;
    this.mesh = new Mesh(geometry, threeMaterial);
    this.mesh.frustumCulled = false;
    this.mesh.name = name;
  }

  /** How many segments the draw covers. */
  public set segments(count: number) {
    this.geometry.instanceCount = count;
  }

  public destroy(): void {
    this.mesh.removeFromParent();
    // Releases three's GPU copies of every attribute, those over the strip's own points included.
    this.geometry.dispose();
    this.threeMaterial.dispose();
    this.material.destroy();
  }
}

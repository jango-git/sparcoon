import type { InstancedBufferAttribute } from "three";
import { assertValidNumber } from "../../miscellaneous/asserts";
import type { Vector3Like } from "../../miscellaneous/math";
import type { FXVector3Config } from "../../miscellaneous/miscellaneous";
import {
  BUILTIN_OFFSET_POSITION_X,
  BUILTIN_OFFSET_POSITION_Y,
  BUILTIN_OFFSET_POSITION_Z,
  BUILTIN_OFFSET_VELOCITY_X,
  BUILTIN_OFFSET_VELOCITY_Y,
  BUILTIN_OFFSET_VELOCITY_Z,
  resolveFXVector3Config,
} from "../../miscellaneous/miscellaneous";
import { FXBehavior } from "./FXBehavior";

/**
 * Applies attraction or repulsion toward a point
 *
 * @remarks
 * Particles closer than `threshold` are unaffected.
 */
export class FXBehaviorPointForce extends FXBehavior<{ builtin: "Matrix4" }> {
  /** @internal */
  public readonly requiredProperties = { builtin: "Matrix4" } as const;
  private centerInternal: Vector3Like;
  private strengthInternal: number;
  private exponentInternal: number;
  private thresholdInternal: number;

  /**
   * @param center - Force center position
   * @param strength - Force multiplier
   * @param exponent - Distance power exponent
   * @param threshold - Minimum distance
   */
  constructor(center: Vector3Like, strength: number, exponent = 2, threshold = 0.1) {
    super();
    this.centerInternal = resolveFXVector3Config(center);
    assertValidNumber(this.centerInternal.x, "FXBehaviorPointForce.constructor.center.x");
    assertValidNumber(this.centerInternal.y, "FXBehaviorPointForce.constructor.center.y");
    assertValidNumber(this.centerInternal.z, "FXBehaviorPointForce.constructor.center.z");

    assertValidNumber(strength, "FXBehaviorPointForce.constructor.strength");
    this.strengthInternal = strength;

    assertValidNumber(exponent, "FXBehaviorPointForce.constructor.exponent");
    this.exponentInternal = exponent;

    assertValidNumber(threshold, "FXBehaviorPointForce.constructor.threshold");
    this.thresholdInternal = threshold;
  }

  /** Force center position */
  public get center(): Vector3Like {
    return this.centerInternal;
  }

  /** Force multiplier */
  public get strength(): number {
    return this.strengthInternal;
  }

  /** Distance power exponent */
  public get exponent(): number {
    return this.exponentInternal;
  }

  /** Minimum distance */
  public get threshold(): number {
    return this.thresholdInternal;
  }

  public set center(value: FXVector3Config) {
    this.centerInternal = resolveFXVector3Config(value);
    assertValidNumber(this.centerInternal.x, "FXBehaviorPointForce.center.x");
    assertValidNumber(this.centerInternal.y, "FXBehaviorPointForce.center.y");
    assertValidNumber(this.centerInternal.z, "FXBehaviorPointForce.center.z");
  }

  public set strength(value: number) {
    assertValidNumber(value, "FXBehaviorPointForce.strength");
    this.strengthInternal = value;
  }

  public set exponent(value: number) {
    assertValidNumber(value, "FXBehaviorPointForce.exponent");
    this.exponentInternal = value;
  }

  public set threshold(value: number) {
    assertValidNumber(value, "FXBehaviorPointForce.threshold");
    this.thresholdInternal = value;
  }

  /** @internal */
  public update(
    properties: { builtin: InstancedBufferAttribute },
    instanceCount: number,
    deltaTime: number,
  ): void {
    const { builtin } = properties;
    const { array, itemSize } = builtin;

    const thresholdSquared = this.thresholdInternal * this.thresholdInternal;

    for (let i = 0; i < instanceCount; i++) {
      const itemOffset = i * itemSize;

      const dx = this.centerInternal.x - array[itemOffset + BUILTIN_OFFSET_POSITION_X];
      const dy = this.centerInternal.y - array[itemOffset + BUILTIN_OFFSET_POSITION_Y];
      const dz = this.centerInternal.z - array[itemOffset + BUILTIN_OFFSET_POSITION_Z];

      const distanceSquared = dx * dx + dy * dy + dz * dz;
      if (distanceSquared < thresholdSquared) {
        continue;
      }

      const distance = Math.sqrt(distanceSquared);
      const forceMagnitude = this.strengthInternal / Math.pow(distance, this.exponentInternal);

      const directionX = dx / distance;
      const directionY = dy / distance;
      const directionZ = dz / distance;

      array[itemOffset + BUILTIN_OFFSET_VELOCITY_X] += directionX * forceMagnitude * deltaTime;
      array[itemOffset + BUILTIN_OFFSET_VELOCITY_Y] += directionY * forceMagnitude * deltaTime;
      array[itemOffset + BUILTIN_OFFSET_VELOCITY_Z] += directionZ * forceMagnitude * deltaTime;
    }

    builtin.needsUpdate = true;
  }
}

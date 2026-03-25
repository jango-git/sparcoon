import type { InstancedBufferAttribute } from "three";
import { Vector3 } from "three";
import { assertValidNumber } from "../../miscellaneous/asserts";
import { EPSILON, type Vector3Like } from "../../miscellaneous/math";
import type { FXVector3Config } from "../../miscellaneous/miscellaneous";
import {
  BUILTIN_OFFSET_VELOCITY_X,
  BUILTIN_OFFSET_VELOCITY_Y,
  BUILTIN_OFFSET_VELOCITY_Z,
  resolveFXVector3Config,
} from "../../miscellaneous/miscellaneous";
import { FXBehavior } from "./FXBehavior";

/**
 * Applies constant acceleration to all particles
 */
export class FXBehaviorDirectionalForce extends FXBehavior<{ builtin: "Matrix4" }> {
  /** @internal */
  public readonly requiredProperties = { builtin: "Matrix4" } as const;
  private readonly directionInternal: Vector3;
  private magnitudeInternal: number;

  /**
   * @param direction - Direction vector (will be normalized)
   * @param magnitude - Acceleration magnitude in units/second²
   */
  constructor(direction: Vector3Like, magnitude: number) {
    super();
    const resolvedDirection = resolveFXVector3Config(direction);
    assertValidNumber(resolvedDirection.x, "FXBehaviorDirectionalForce.direction.x");
    assertValidNumber(resolvedDirection.y, "FXBehaviorDirectionalForce.direction.y");
    assertValidNumber(resolvedDirection.z, "FXBehaviorDirectionalForce.direction.z");
    assertValidNumber(magnitude, "FXBehaviorDirectionalForce.constructor.magnitude");

    this.directionInternal = new Vector3(
      resolvedDirection.x,
      resolvedDirection.y,
      resolvedDirection.z,
    );
    if (this.directionInternal.lengthSq() <= EPSILON) {
      throw new Error("FXBehaviorDirectionalForce.direction: vector cannot be zero");
    }
    this.directionInternal.normalize();
    this.magnitudeInternal = magnitude;
  }

  /** Direction vector (normalized) */
  public get direction(): Vector3Like {
    return this.directionInternal;
  }

  /** Acceleration magnitude in units/second² */
  public get magnitude(): number {
    return this.magnitudeInternal;
  }

  public set direction(value: FXVector3Config) {
    const resolved = resolveFXVector3Config(value);
    assertValidNumber(resolved.x, "FXBehaviorDirectionalForce.direction.x");
    assertValidNumber(resolved.y, "FXBehaviorDirectionalForce.direction.y");
    assertValidNumber(resolved.z, "FXBehaviorDirectionalForce.direction.z");

    this.directionInternal.set(resolved.x, resolved.y, resolved.z);
    if (this.directionInternal.lengthSq() < EPSILON) {
      throw new Error("FXBehaviorDirectionalForce.direction: vector cannot be zero");
    }
    this.directionInternal.normalize();
  }

  public set magnitude(value: number) {
    assertValidNumber(value, "FXBehaviorDirectionalForce.magnitude");
    this.magnitudeInternal = value;
  }

  /** @internal */
  public update(
    properties: { builtin: InstancedBufferAttribute },
    instanceCount: number,
    deltaTime: number,
  ): void {
    const { builtin } = properties;
    const { array, itemSize } = builtin;

    const scale = this.magnitudeInternal * deltaTime;
    const offsetX = this.directionInternal.x * scale;
    const offsetY = this.directionInternal.y * scale;
    const offsetZ = this.directionInternal.z * scale;

    for (let i = 0; i < instanceCount; i++) {
      const itemOffset = i * itemSize;
      array[itemOffset + BUILTIN_OFFSET_VELOCITY_X] += offsetX;
      array[itemOffset + BUILTIN_OFFSET_VELOCITY_Y] += offsetY;
      array[itemOffset + BUILTIN_OFFSET_VELOCITY_Z] += offsetZ;
    }

    builtin.needsUpdate = true;
  }
}

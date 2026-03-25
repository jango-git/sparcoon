import type { InstancedBufferAttribute } from "three";
import { MathUtils, Vector3 } from "three";
import { assertValidNumber } from "../../miscellaneous/asserts";
import type { FXRange, FXRangeConfig } from "../../miscellaneous/miscellaneous";
import {
  BUILTIN_OFFSET_VELOCITY_X,
  BUILTIN_OFFSET_VELOCITY_Y,
  BUILTIN_OFFSET_VELOCITY_Z,
  resolveFXRangeConfig,
} from "../../miscellaneous/miscellaneous";
import { FXSpawn } from "./FXSpawn";

const TEMP_TANGENT = new Vector3();
const TEMP_BITANGENT = new Vector3();
const TEMP_VELOCITY = new Vector3();

/**
 * Assigns a random initial velocity to each spawned particle within a cone around a direction axis
 */
export class FXSpawnVelocity extends FXSpawn<{ builtin: "Matrix4" }> {
  /** @internal */
  public readonly requiredProperties = { builtin: "Matrix4" } as const;

  private angleInternal: FXRange;
  private magnitudeInternal: FXRange;
  private readonly directionInternal: Vector3;

  /**
   * @param direction - Cone axis; normalized automatically. Defaults to `(0, 1, 0)`
   * @param angle - Cone half-angle range in radians; `{ min: 0, max: 0 }` fires in a straight line.
   * Defaults to `{ min: 0, max: Math.PI }`
   * @param magnitude - Speed range in units/second. Defaults to `{ min: -1, max: 1 }`
   */
  constructor(
    direction: Vector3 = new Vector3(0, 1, 0),
    angle: FXRangeConfig = { min: 0, max: Math.PI },
    magnitude: FXRangeConfig = { min: -1, max: 1 },
  ) {
    super();

    this.directionInternal = direction.clone().normalize();
    this.angleInternal = resolveFXRangeConfig(angle);
    this.magnitudeInternal = resolveFXRangeConfig(magnitude);

    assertValidNumber(this.angleInternal.min, "FXSpawnVelocity.constructor.angle.min");
    assertValidNumber(this.angleInternal.max, "FXSpawnVelocity.constructor.angle.max");
    assertValidNumber(this.magnitudeInternal.min, "FXSpawnVelocity.constructor.magnitude.min");
    assertValidNumber(this.magnitudeInternal.max, "FXSpawnVelocity.constructor.magnitude.max");
  }

  /** Cone axis (always normalized) */
  public get direction(): Vector3 {
    return this.directionInternal;
  }

  /** Cone half-angle range in radians */
  public get angle(): FXRange {
    return this.angleInternal;
  }

  /** Speed range in units/second */
  public get magnitude(): FXRange {
    return this.magnitudeInternal;
  }

  public set direction(value: Vector3) {
    this.directionInternal.copy(value).normalize();
  }

  public set angle(value: FXRangeConfig) {
    this.angleInternal = resolveFXRangeConfig(value);
    assertValidNumber(this.angleInternal.min, "FXSpawnVelocity.angle.min");
    assertValidNumber(this.angleInternal.max, "FXSpawnVelocity.angle.max");
  }

  public set magnitude(value: FXRangeConfig) {
    this.magnitudeInternal = resolveFXRangeConfig(value);
    assertValidNumber(this.magnitudeInternal.min, "FXSpawnVelocity.magnitude.min");
    assertValidNumber(this.magnitudeInternal.max, "FXSpawnVelocity.magnitude.max");
  }

  /** @internal */
  public spawn(
    properties: { builtin: InstancedBufferAttribute },
    instanceBegin: number,
    instanceEnd: number,
  ): void {
    const { builtin } = properties;
    const { array, itemSize } = builtin;

    const { min: angleMin, max: angleMax } = this.angleInternal;
    const { min: magnitudeMin, max: magnitudeMax } = this.magnitudeInternal;

    const dir = this.directionInternal;

    if (Math.abs(dir.y) < 0.999) {
      TEMP_TANGENT.set(0, 1, 0).cross(dir).normalize();
    } else {
      TEMP_TANGENT.set(1, 0, 0).cross(dir).normalize();
    }
    TEMP_BITANGENT.crossVectors(dir, TEMP_TANGENT);

    const cosMin = Math.cos(angleMax);
    const cosMax = Math.cos(angleMin);

    for (let i = instanceBegin; i < instanceEnd; i++) {
      const itemOffset = i * itemSize;

      const cosTheta = MathUtils.lerp(cosMin, cosMax, Math.random());
      const sinTheta = Math.sqrt(1 - cosTheta * cosTheta);
      const phi = Math.random() * Math.PI * 2;

      const magnitude = MathUtils.randFloat(magnitudeMin, magnitudeMax);

      TEMP_VELOCITY.copy(dir)
        .multiplyScalar(cosTheta)
        .addScaledVector(TEMP_TANGENT, Math.cos(phi) * sinTheta)
        .addScaledVector(TEMP_BITANGENT, Math.sin(phi) * sinTheta)
        .multiplyScalar(magnitude);

      array[itemOffset + BUILTIN_OFFSET_VELOCITY_X] = TEMP_VELOCITY.x;
      array[itemOffset + BUILTIN_OFFSET_VELOCITY_Y] = TEMP_VELOCITY.y;
      array[itemOffset + BUILTIN_OFFSET_VELOCITY_Z] = TEMP_VELOCITY.z;
    }

    builtin.needsUpdate = true;
  }
}

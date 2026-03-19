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

export class FXSpawnRandomVelocity extends FXSpawn<{ builtin: "Matrix4" }> {
  /** @internal */
  public readonly requiredProperties = { builtin: "Matrix4" } as const;

  private angleInternal: FXRange;
  private magnitudeInternal: FXRange;
  private readonly directionInternal: Vector3;

  constructor(
    direction: Vector3 = new Vector3(0, 1, 0),
    angle: FXRangeConfig = { min: 0, max: Math.PI },
    magnitude: FXRangeConfig = { min: -50, max: 50 },
  ) {
    super();

    this.directionInternal = direction.clone().normalize();
    this.angleInternal = resolveFXRangeConfig(angle);
    this.magnitudeInternal = resolveFXRangeConfig(magnitude);

    assertValidNumber(this.angleInternal.min, "FXSpawnRandomVelocity.constructor.angle.min");
    assertValidNumber(this.angleInternal.max, "FXSpawnRandomVelocity.constructor.angle.max");
    assertValidNumber(
      this.magnitudeInternal.min,
      "FXSpawnRandomVelocity.constructor.magnitude.min",
    );
    assertValidNumber(
      this.magnitudeInternal.max,
      "FXSpawnRandomVelocity.constructor.magnitude.max",
    );
  }

  public get angle(): FXRange {
    return this.angleInternal;
  }

  public get magnitude(): FXRange {
    return this.magnitudeInternal;
  }

  public get direction(): Vector3 {
    return this.directionInternal;
  }

  public set angle(value: FXRangeConfig) {
    this.angleInternal = resolveFXRangeConfig(value);
    assertValidNumber(this.angleInternal.min, "FXSpawnRandomVelocity.angle.min");
    assertValidNumber(this.angleInternal.max, "FXSpawnRandomVelocity.angle.max");
  }

  public set magnitude(value: FXRangeConfig) {
    this.magnitudeInternal = resolveFXRangeConfig(value);
    assertValidNumber(this.magnitudeInternal.min, "FXSpawnRandomVelocity.magnitude.min");
    assertValidNumber(this.magnitudeInternal.max, "FXSpawnRandomVelocity.magnitude.max");
  }

  public set direction(value: Vector3) {
    this.directionInternal.copy(value).normalize();
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

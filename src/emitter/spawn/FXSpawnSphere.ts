import type { InstancedBufferAttribute } from "three";
import { MathUtils } from "three";
import { assertValidNonNegativeNumber, assertValidNumber } from "../../miscellaneous/asserts";
import {
  BUILTIN_OFFSET_POSITION_X,
  BUILTIN_OFFSET_POSITION_Y,
  BUILTIN_OFFSET_POSITION_Z,
} from "../../miscellaneous/miscellaneous";
import { FXSpawn } from "./FXSpawn";

/**
 * Spawns particles at random positions within a spherical shell.
 *
 * The `angle` parameter controls the polar spread from the equatorial plane:
 * - `0` - flat disk (XZ plane only)
 * - `Math.PI / 2` - full sphere
 * - Values in between produce a spherical band/zone
 */
export class FXSpawnSphere extends FXSpawn<{ builtin: "Matrix4" }> {
  /** @internal */
  public readonly requiredProperties = { builtin: "Matrix4" } as const;
  private innerRadiusInternal: number;
  private outerRadiusInternal: number;
  private angleInternal: number;

  /**
   * @param innerRadius - Minimum spawn radius (0 = spawn from center)
   * @param outerRadius - Maximum spawn radius
   * @param angle - Polar half-angle from equatorial plane: 0 = disk, Math.PI/2 = full sphere
   */
  constructor(innerRadius = 0, outerRadius = 1, angle: number = Math.PI / 2) {
    super();
    this.innerRadiusInternal = innerRadius;
    this.outerRadiusInternal = outerRadius;
    this.angleInternal = angle;
    assertValidNonNegativeNumber(innerRadius, "FXSpawnSphere.constructor.innerRadius");
    assertValidNonNegativeNumber(outerRadius, "FXSpawnSphere.constructor.outerRadius");
    assertValidNumber(angle, "FXSpawnSphere.constructor.angle");
  }

  /**
   * Polar half-angle from the equatorial plane.
   * - `0` - flat disk
   * - `Math.PI / 2` - full sphere
   */
  public get angle(): number {
    return this.angleInternal;
  }

  /** Minimum spawn radius */
  public get innerRadius(): number {
    return this.innerRadiusInternal;
  }

  /** Maximum spawn radius */
  public get outerRadius(): number {
    return this.outerRadiusInternal;
  }

  /** Minimum spawn radius */
  public set innerRadius(value: number) {
    assertValidNonNegativeNumber(value, "FXSpawnSphere.innerRadius");
    this.innerRadiusInternal = value;
  }

  /** Maximum spawn radius */
  public set outerRadius(value: number) {
    assertValidNonNegativeNumber(value, "FXSpawnSphere.outerRadius");
    this.outerRadiusInternal = value;
  }

  /** @see {@link angle} */
  public set angle(value: number) {
    assertValidNumber(value, "FXSpawnSphere.angle");
    this.angleInternal = value;
  }

  /** @internal */
  public spawn(
    properties: { builtin: InstancedBufferAttribute },
    instanceBegin: number,
    instanceEnd: number,
  ): void {
    const { builtin } = properties;
    const { array, itemSize } = builtin;
    const inner = this.innerRadiusInternal;
    const outer = this.outerRadiusInternal;
    const sinAngle = Math.sin(this.angleInternal);

    // Volume-uniform radius sampling within the shell
    const inner3 = inner * inner * inner;
    const outer3 = outer * outer * outer;

    for (let i = instanceBegin; i < instanceEnd; i++) {
      // Uniform volume-weighted radius
      const r = Math.cbrt(MathUtils.randFloat(inner3, outer3));

      // Uniform sampling on spherical zone:
      // cosTheta in [-sinAngle, sinAngle] gives latitude range [-angle, +angle]
      const cosTheta = MathUtils.randFloat(-sinAngle, sinAngle);
      const sinTheta = Math.sqrt(1 - cosTheta * cosTheta);
      const phi = MathUtils.randFloat(0, Math.PI * 2);

      const itemOffset = i * itemSize;
      array[itemOffset + BUILTIN_OFFSET_POSITION_X] = r * sinTheta * Math.cos(phi);
      array[itemOffset + BUILTIN_OFFSET_POSITION_Y] = r * cosTheta;
      array[itemOffset + BUILTIN_OFFSET_POSITION_Z] = r * sinTheta * Math.sin(phi);
    }

    builtin.needsUpdate = true;
  }
}

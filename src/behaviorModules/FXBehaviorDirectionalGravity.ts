import type { InstancedBufferAttribute } from "three";
import { assertValidNumber } from "../miscellaneous/asserts";
import type { Vector3Like } from "../miscellaneous/math";
import {
  BUILTIN_OFFSET_VELOCITY_X,
  BUILTIN_OFFSET_VELOCITY_Y,
  resolveFXVector2Config,
  type FXVector3Config,
} from "../miscellaneous/miscellaneous";
import { FXBehaviorModule } from "./FXBehaviorModule";

/**
 * Applies constant acceleration to all particles.
 *
 * Adds the direction vector to particle velocity each frame.
 */
export class FXBehaviorDirectionalGravity extends FXBehaviorModule<{ builtin: "Matrix4" }> {
  /** @internal */
  public readonly requiredProperties = { builtin: "Matrix4" } as const;
  private directionInternal: Vector3Like;

  /**
   * @param direction - Acceleration vector in units/second²
   */
  constructor(direction: Vector3Like) {
    super();
    this.directionInternal = resolveFXVector2Config(direction);
    assertValidNumber(
      this.directionInternal.x,
      "UIBehaviorDirectionalGravity.constructor.direction.x",
    );
    assertValidNumber(
      this.directionInternal.y,
      "UIBehaviorDirectionalGravity.constructor.direction.y",
    );
  }

  /** Acceleration vector in units/second² */
  public get direction(): Vector3Like {
    return this.directionInternal;
  }

  /** Acceleration vector in units/second² */
  public set direction(value: FXVector3Config) {
    this.directionInternal = resolveFXVector2Config(value);
    assertValidNumber(this.directionInternal.x, "UIBehaviorDirectionalGravity.direction.x");
    assertValidNumber(this.directionInternal.y, "UIBehaviorDirectionalGravity.direction.y");
  }

  /** @internal */
  public update(
    properties: { builtin: InstancedBufferAttribute },
    instanceCount: number,
    deltaTime: number,
  ): void {
    const { builtin } = properties;
    const { array, itemSize } = builtin;

    const offsetX = this.directionInternal.x * deltaTime;
    const offsetY = this.directionInternal.y * deltaTime;

    for (let i = 0; i < instanceCount; i++) {
      const itemOffset = i * itemSize;
      array[itemOffset + BUILTIN_OFFSET_VELOCITY_X] += offsetX;
      array[itemOffset + BUILTIN_OFFSET_VELOCITY_Y] += offsetY;
    }

    builtin.needsUpdate = true;
  }
}

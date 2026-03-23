import { assertValidNumber } from "../asserts";
import type { FXCurve1DAnchor, FXCurve1DConfig, FXCurve1DPoint } from "./FXCurve1D.Internal";

export type { FXCurve1DAnchor, FXCurve1DConfig, FXCurve1DPoint };

/**
 * 1D curve defined by anchor points at explicit normalized positions.
 *
 * Anchors must be strictly ascending by `value`, first must be `0`, last must be `1`.
 * Output at each anchor is a value of type `T` - interpolation is left to the caller.
 */
export class FXCurve1D<T> {
  private readonly anchorsInternal: FXCurve1DAnchor<T>[];

  /**
   * @param config - Explicit anchor points, a uniform shorthand array, or another {@link FXCurve1D} to copy
   */
  constructor(config: FXCurve1DConfig<T>) {
    if (config instanceof FXCurve1D) {
      this.anchorsInternal = config.anchorsInternal.map((anchor) => ({ ...anchor }));
      return;
    }

    const isPointArray =
      config.length > 0 &&
      typeof config[0] === "object" &&
      !Array.isArray(config[0]) &&
      "value" in (config[0] as object);

    const points: FXCurve1DPoint<T>[] = isPointArray
      ? (config as FXCurve1DPoint<T>[])
      : (config as T[]).map((value, index) => ({
          value,
          position: index / (config.length - 1),
        }));

    if (points.length < 2) {
      throw new Error("FXCurve1D: at least 2 anchor points are required");
    }

    if (points[0].position !== 0) {
      throw new Error(`FXCurve1D: first anchor value must be 0, got ${points[0].position}`);
    }

    if (points[points.length - 1].position !== 1) {
      throw new Error(
        `FXCurve1D: last anchor value must be 1, got ${points[points.length - 1].position}`,
      );
    }

    this.anchorsInternal = [];

    for (let index = 0; index < points.length; index++) {
      const { value, position } = points[index];

      if (position < 0 || position > 1) {
        throw new Error(`FXCurve1D: anchor[${index}].value must be in [0, 1], got ${position}`);
      }

      if (index > 0 && position <= points[index - 1].position) {
        throw new Error(
          `FXCurve1D: anchor[${index}].value (${position}) must be strictly greater than anchor[${index - 1}].value (${points[index - 1].position})`,
        );
      }

      this.anchorsInternal.push({ value, position });
    }
  }

  /** Resolved anchor points ordered ascending by `value`. */
  public get anchors(): readonly FXCurve1DAnchor<T>[] {
    return this.anchorsInternal;
  }

  /**
   * Samples the curve at normalized position `t`.
   *
   * Returns the two bracketing anchor values and the local interpolation factor `t` in [0, 1].
   * The caller is responsible for interpolating between `a` and `b` using `t`.
   *
   * @param t - Normalized position in [0, 1]
   * @internal
   */
  public sample(t: number): { a: T; b: T; t: number } {
    assertValidNumber(t, "FXCurve1D.sample.t");
    const anchors = this.anchorsInternal;
    const anchorCount = anchors.length;

    let segmentIndex: number;

    if (anchorCount < 10) {
      segmentIndex = 0;
      while (segmentIndex < anchorCount - 2 && anchors[segmentIndex + 1].position <= t) {
        segmentIndex++;
      }
    } else {
      let low = 0;
      let high = anchorCount - 2;
      while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (anchors[mid].position <= t) {
          low = mid;
        } else {
          high = mid - 1;
        }
      }
      segmentIndex = low;
    }

    const anchorA = anchors[segmentIndex];
    const anchorB = anchors[segmentIndex + 1];
    const localT = (t - anchorA.position) / (anchorB.position - anchorA.position);

    return { a: anchorA.value, b: anchorB.value, t: localT };
  }
}

import type { FXCurve1D } from "./FXCurve1D";

/** Input point for {@link FXCurve1D}. */
export interface FXCurve1DPoint<T> {
  /** Output value at this position. */
  value: T;
  /** Normalized position in [0, 1]. */
  position: number;
}

/**
 * Accepts either:
 * - Explicit anchor points ({@link FXCurve1DPoint}\<T>[])
 * - A uniform shorthand (`T[]`) where anchors are distributed evenly across [0, 1]
 * - Another {@link FXCurve1D}\<T> instance to copy anchors from
 */
export type FXCurve1DConfig<T> = FXCurve1DPoint<T>[] | T[] | FXCurve1D<T>;

/** Resolved anchor stored internally by {@link FXCurve1D}. */
export interface FXCurve1DAnchor<T> {
  readonly value: T;
  readonly position: number;
}

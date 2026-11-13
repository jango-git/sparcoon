import type { FXInheritLayout } from "../artifact/FXArtifact.js";
import { assertValidNumber } from "../miscellaneous/asserts.js";

/**
 * Inheritance: what a newborn takes from the particle whose death spawned it. A behavior's
 * {@link FXInheritLayout} says how many floats its births inherit and what a birth no death spawned
 * gets; a death reaction's {@link FXInheritCopies} say which floats of the dying particle's slot
 * fill which of them. The runtime only checks and copies - which float is which is the editor's.
 */

/**
 * What a death reaction copies from the dying particle into what its births inherit: triples
 * `[from, to, count]` back to back - `count` floats of the particle's slot from `from` on, into the
 * target's inherit layout from `to` on. Every float no triple writes keeps the target's default.
 */
export type FXInheritCopies = readonly number[];

const COPY_STRIDE = 3;

/**
 * Throws unless `copies` are whole triples that read inside a slot of `slotStride` floats and
 * write inside an inherit layout of `inheritStride`.
 */
export function assertValidInheritCopies(
  copies: FXInheritCopies,
  slotStride: number,
  inheritStride: number,
  subject: string,
): void {
  if (copies.length % COPY_STRIDE !== 0) {
    throw new Error(
      `${subject}: expected [from, to, count] triples, got ${String(copies.length)} numbers`,
    );
  }
  for (let index = 0; index < copies.length; index += COPY_STRIDE) {
    const from = copies[index];
    const to = copies[index + 1];
    const count = copies[index + 2];
    const whole = [from, to, count].every((value) => Number.isInteger(value) && value >= 0);
    if (!whole || count === 0 || from + count > slotStride || to + count > inheritStride) {
      throw new Error(
        `${subject}: [${String(from)}, ${String(to)}, ${String(count)}] does not copy within a ` +
          `slot of ${String(slotStride)} floats into an inherit layout of ${String(inheritStride)}`,
      );
    }
  }
}

/** Fills `into` with `defaults`, then with what `copies` (already checked) take of `slot`. */
export function inheritFrom(
  slot: Float32Array,
  copies: FXInheritCopies,
  defaults: Float32Array,
  into: Float32Array,
): void {
  into.set(defaults);
  for (let index = 0; index < copies.length; index += COPY_STRIDE) {
    const from = copies[index];
    const to = copies[index + 1];
    const count = copies[index + 2];
    for (let field = 0; field < count; field += 1) {
      into[to + field] = slot[from + field];
    }
  }
}

/**
 * The defaults `inherit` hands a birth no death spawned - nothing without a layout.
 * @throws When `inherit` is not a whole layout: a negative or fractional stride, or defaults of
 *   another length or not finite.
 */
export function inheritDefaultsOf(
  inherit: FXInheritLayout | undefined,
  subject: string,
): Float32Array {
  if (inherit === undefined) {
    return new Float32Array(0);
  }
  if (!Number.isInteger(inherit.stride) || inherit.stride < 0) {
    throw new RangeError(
      `${subject}.stride: expected an integer >= 0, got ${String(inherit.stride)}`,
    );
  }
  assertValidInherited(inherit.defaults, inherit.stride, `${subject}.defaults`);
  return Float32Array.from(inherit.defaults);
}

/** Throws unless `values` are `stride` finite numbers - what a birth of that layout inherits. */
export function assertValidInherited(
  values: ArrayLike<number>,
  stride: number,
  subject: string,
): void {
  if (values.length !== stride) {
    throw new RangeError(
      `${subject}: expected ${String(stride)} values, got ${String(values.length)}`,
    );
  }
  for (const value of Array.from(values)) {
    assertValidNumber(value, subject);
  }
}

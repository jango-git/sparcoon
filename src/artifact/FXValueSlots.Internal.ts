import type { FXValueSlot } from "./FXArtifact.js";

/**
 * @internal A copy of an artifact slot's `value` no later write can reach into: an artifact is
 * module-scoped and shared by every instance built from it, so an instance that wrote into the
 * artifact's values would write into all of them. A plain array is copied; a typed array (a curve
 * LUT) is shared, as it is only ever replaced, never written in place.
 */
export function ownValue<T>(value: T): T {
  return Array.isArray(value) ? ([...value] as T) : value;
}

/** @internal An instance's own slot seeded from `slot` (see {@link ownValue}). */
export function ownSlot<T>(slot: FXValueSlot<T>): FXValueSlot<T> {
  return { value: ownValue(slot.value) };
}

/** @internal {@link ownSlot} of every slot of `slots`, by name. */
export function ownSlots<T>(
  slots: Readonly<Record<string, FXValueSlot<T>>>,
): Record<string, FXValueSlot<T>> {
  const own: Record<string, FXValueSlot<T>> = {};
  for (const name in slots) {
    own[name] = ownSlot(slots[name]);
  }
  return own;
}

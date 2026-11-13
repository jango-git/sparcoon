/**
 * @internal How old a run of newborns already is at the end of the tick that seeds them: newborn
 * `k` of the run (0-based, in birth order) was born `first + k * step` seconds before the tick's
 * end. Seeded with that age, from where the emitter stood then - its pose moved back along its
 * velocity by that age - births spread over the tick instead of piling up at its end.
 */
export interface FXBirthAges {
  readonly first: number;
  readonly step: number;
}

/** `count` births, as old as `ages` says: the aged tail of a pass's births on the GPU. */
export interface FXAgedBirths {
  readonly count: number;
  readonly ages: FXBirthAges;
}

/** How old newborn `index` of a run is (see {@link FXBirthAges}). */
export function birthAgeAt(ages: FXBirthAges, index: number): number {
  return ages.first + index * ages.step;
}

/**
 * The ages of the births a play gained over a tick of `deltaTime` seconds, emitting
 * through the first `window` seconds of it: its accumulator held `carried` (below one birth) when
 * the tick began and gained `gained`, so birth `k` (1-based) fell where the accumulator crossed
 * `k` - `(k - carried) / gained` of the way through the window.
 */
export function playBirthAges(
  carried: number,
  gained: number,
  window: number,
  deltaTime: number,
): FXBirthAges {
  const spacing = window / gained;
  return { first: deltaTime - (1 - carried) * spacing, step: -spacing };
}

/** `count` births spread evenly over a tick of `deltaTime` seconds, oldest first. */
export function spreadBirthAges(count: number, deltaTime: number): FXBirthAges {
  const spacing = deltaTime / count;
  return { first: deltaTime - spacing / 2, step: -spacing };
}

/**
 * Single-entry argument cache of the vector-result noise functions: a compiled kernel requests
 * each component in a separate call with identical arguments, so one evaluation serves all.
 * Returns true (and stores the arguments) when they differ from the cached ones.
 */
export function argumentsChanged(
  key: Float64Array,
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
): boolean {
  if (
    a === key[0] &&
    b === key[1] &&
    c === key[2] &&
    d === key[3] &&
    e === key[4] &&
    f === key[5]
  ) {
    return false;
  }
  key[0] = a;
  key[1] = b;
  key[2] = c;
  key[3] = d;
  key[4] = e;
  key[5] = f;
  return true;
}

export function createKey(): Float64Array {
  return new Float64Array(6).fill(Number.NaN);
}

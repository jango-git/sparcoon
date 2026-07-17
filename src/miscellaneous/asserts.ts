import { EPSILON } from "./math.js";

// `typeof process` short-circuits before `process.env`, so the published ESM never throws a
// ReferenceError under import maps / a CDN (no bundler `process` shim). Bundlers still inline
// `process.env.NODE_ENV`, so DEV validation drops out of production builds.
const DEV = typeof process === "undefined" || process.env.NODE_ENV !== "production";

export function assertValidNumber(value: number, subject: string): void {
  if (DEV) {
    if (!Number.isFinite(value)) {
      throw new Error(`${subject}: value must be a finite number`);
    }

    if (Math.abs(value) > Number.MAX_SAFE_INTEGER) {
      throw new Error(`${subject}: value exceeds maximum safe integer range`);
    }
  }
}

export function assertValidPositiveNumber(value: number, subject: string): void {
  if (DEV) {
    assertValidNumber(value, subject);
    if (value < EPSILON) {
      throw new Error(`${subject}: value must be greater than or equal to ${EPSILON}`);
    }
  }
}

export function assertValidNonNegativeNumber(value: number, subject: string): void {
  if (DEV) {
    assertValidNumber(value, subject);
    if (value < 0) {
      throw new Error(`${subject}: value must be greater than or equal to 0`);
    }
  }
}

// Guards counts/capacities that reach `instanceCount` or a `Float32Array` length, where a
// fractional value would draw a truncated instance count or throw a `RangeError`.
export function assertValidPositiveInteger(value: number, subject: string): void {
  if (DEV) {
    assertValidPositiveNumber(value, subject);
    if (!Number.isInteger(value)) {
      throw new Error(`${subject}: value must be an integer`);
    }
  }
}

import { EPSILON } from "./math";

/**
 * Validates value is finite number within safe range.
 * @param value Number to validate
 * @param subject Value name for error messages
 * @throws If value is not finite or exceeds safe range
 */
export function assertValidNumber(value: number, subject: string): void {
  if (process.env.NODE_ENV !== "production") {
    if (!Number.isFinite(value)) {
      throw new Error(`${subject}: value must be a finite number`);
    }

    if (Math.abs(value) > Number.MAX_SAFE_INTEGER) {
      throw new Error(`${subject}: value exceeds maximum safe integer range`);
    }
  }
}

/**
 * Validates value is positive (>= EPSILON).
 * @param value Number to validate
 * @param subject Value name for error messages
 * @throws If value is invalid or below EPSILON
 */
export function assertValidPositiveNumber(value: number, subject: string): void {
  if (process.env.NODE_ENV !== "production") {
    assertValidNumber(value, subject);
    if (value < EPSILON) {
      throw new Error(`${subject}: value must be greater than or equal to ${EPSILON}`);
    }
  }
}

/**
 * Validates value is non-negative (>= 0).
 * @param value Number to validate
 * @param subject Value name for error messages
 * @throws If value is invalid or negative
 */
export function assertValidNonNegativeNumber(value: number, subject: string): void {
  if (process.env.NODE_ENV !== "production") {
    assertValidNumber(value, subject);
    if (value < 0) {
      throw new Error(`${subject}: value must be greater than or equal to 0`);
    }
  }
}

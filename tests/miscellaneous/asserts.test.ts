import { describe, expect, it } from "vitest";
import {
  assertValidNonNegativeNumber,
  assertValidNumber,
  assertValidPositiveInteger,
  assertValidPositiveNumber,
} from "../../src/miscellaneous/asserts";

// These guards run under DEV (NODE_ENV !== "production"), which is the case in the test run. They
// protect values that flow into instanceCount / Float32Array lengths, where a bad value would draw
// wrong or throw a RangeError deep in the render loop.

describe("assertValidNumber", () => {
  it("accepts a finite number", () => {
    expect(() => assertValidNumber(42, "x")).not.toThrow();
  });

  it("rejects a non-finite number", () => {
    expect(() => assertValidNumber(Infinity, "x")).toThrow(/finite/);
    expect(() => assertValidNumber(NaN, "x")).toThrow(/finite/);
  });

  it("rejects a magnitude beyond the safe integer range", () => {
    expect(() => assertValidNumber(Number.MAX_SAFE_INTEGER + 10, "x")).toThrow(/safe integer/);
  });
});

describe("assertValidPositiveNumber", () => {
  it("accepts a positive number", () => {
    expect(() => assertValidPositiveNumber(0.5, "x")).not.toThrow();
  });

  it("rejects a value below epsilon (zero or negative)", () => {
    expect(() => assertValidPositiveNumber(0, "x")).toThrow();
    expect(() => assertValidPositiveNumber(-1, "x")).toThrow();
  });
});

describe("assertValidNonNegativeNumber", () => {
  it("accepts zero and positive values", () => {
    expect(() => assertValidNonNegativeNumber(0, "x")).not.toThrow();
    expect(() => assertValidNonNegativeNumber(3, "x")).not.toThrow();
  });

  it("rejects a negative value", () => {
    expect(() => assertValidNonNegativeNumber(-0.1, "x")).toThrow(/greater than or equal to 0/);
  });
});

describe("assertValidPositiveInteger", () => {
  it("accepts a positive integer", () => {
    expect(() => assertValidPositiveInteger(4, "x")).not.toThrow();
  });

  it("rejects a fractional value", () => {
    expect(() => assertValidPositiveInteger(2.5, "x")).toThrow(/integer/);
  });

  it("rejects zero (not positive)", () => {
    expect(() => assertValidPositiveInteger(0, "x")).toThrow();
  });
});

import { describe, expect, it } from "vitest";

import { FX_AGE, FX_POSITION_X } from "../../src/coreLayout";
import type { FXBirthAges } from "../../src/emitter/FXBirthAges.Internal";
import { birthAgeAt, playBirthAges, spreadBirthAges } from "../../src/emitter/FXBirthAges.Internal";
import { FXEmitter } from "../../src/emitter/FXEmitter";
import { placingBehavior, unlitArtifact } from "../helpers/artifacts";
import { particlesOf, tickEmitter } from "../helpers/internals";
import { splitFields } from "../helpers/slots";

// Times below are exact binary fractions, so every expected age and position is exact.

function agesOf(ages: FXBirthAges, count: number): number[] {
  return [...Array(count).keys()].map((k) => birthAgeAt(ages, k));
}

describe("playBirthAges", () => {
  it("ages each birth by where its accumulator crossed a whole birth in the tick", () => {
    // Half a birth carried, 2.5 gained over a 0.25 s tick: births at 0.2, 0.6 and 1.0 of it.
    expect(agesOf(playBirthAges(0.5, 2.5, 0.25, 0.25), 3)).toEqual([0.2, 0.1, 0]);
  });

  it("ages births of a window shorter than the tick from the window's own span", () => {
    // A play ending 0.125 s into a 0.25 s tick: its one birth falls at 0.8 of the window.
    expect(agesOf(playBirthAges(0, 1.25, 0.125, 0.25), 1)).toEqual([0.15]);
  });
});

describe("spreadBirthAges", () => {
  it("spreads births evenly over the tick, oldest first", () => {
    expect(agesOf(spreadBirthAges(4, 0.5), 4)).toEqual([0.4375, 0.3125, 0.1875, 0.0625]);
  });
});

/** A still-standing emitter: births stay where they land. */
function placingEmitter(): FXEmitter {
  return FXEmitter.fromArtifacts(unlitArtifact(), placingBehavior(100, [], 0), {
    expectedCapacity: 32,
  });
}

/** Slot `row`'s age and x, as the emitter's JS particles hold them now. */
function rowOf(emitter: FXEmitter, row: number): { age: number; x: number } {
  const particles = particlesOf(emitter);
  const fields = splitFields(particles.slot, particles.slots);
  return { age: fields.lifecycle[row * 3 + FX_AGE], x: fields.position[row * 3 + FX_POSITION_X] };
}

function rowsOf(emitter: FXEmitter, rows: readonly number[]): { age: number; x: number }[] {
  return rows.map((row) => rowOf(emitter, row));
}

function moveTo(emitter: FXEmitter, x: number): void {
  emitter.position.set(x, 0, 0);
  emitter.updateMatrixWorld();
}

describe("FXEmitter births spread over the tick", () => {
  it("places a moving play's births along the way it came, as old as they were born early", () => {
    const emitter = placingEmitter();
    try {
      emitter.play(8);
      tickEmitter(emitter, 0.25); // 2 births where the emitter stands, at x 0.
      moveTo(emitter, 2);
      tickEmitter(emitter, 0.25); // 8 units/s: births at 0.125 and 0.25 s into the tick.

      expect(rowsOf(emitter, [2, 3])).toEqual([
        { age: 0.125, x: 1 },
        { age: 0, x: 2 },
      ]);
    } finally {
      emitter.destroy();
    }
  });

  it("leaves an even trail behind a play over distance, a birth per unit travelled", () => {
    const emitter = placingEmitter();
    try {
      emitter.play(1, { over: "distance" });
      tickEmitter(emitter, 0.25); // Standing still: nothing yet.
      moveTo(emitter, 4);
      tickEmitter(emitter, 0.25);

      expect(rowsOf(emitter, [0, 1, 2, 3]).map((row) => row.x)).toEqual([1, 2, 3, 4]);
    } finally {
      emitter.destroy();
    }
  });

  it("bears a play's first emitting tick at its end, wherever the emitter stood before", () => {
    const emitter = placingEmitter();
    try {
      tickEmitter(emitter, 0.25); // The motion baseline, at x 0.
      moveTo(emitter, 10); // A host moving its emitter into place, then starting it.
      emitter.play(8);
      tickEmitter(emitter, 0.25);

      expect(rowsOf(emitter, [0, 1])).toEqual([
        { age: 0, x: 10 },
        { age: 0, x: 10 },
      ]);
    } finally {
      emitter.destroy();
    }
  });

  it("spreads two plays of one tick evenly between them, after the tick's bursts", () => {
    const emitter = placingEmitter();
    try {
      emitter.play(4);
      emitter.play(4);
      tickEmitter(emitter, 0.5); // 2 + 2 births, at x 0.
      moveTo(emitter, 4);
      emitter.burst(1);
      tickEmitter(emitter, 0.5);

      // The burst first, at the tick's end; then the plays' 4 births, 1/8 s apart.
      expect(rowsOf(emitter, [4, 5, 6, 7, 8])).toEqual([
        { age: 0, x: 4 },
        { age: 0.4375, x: 0.5 },
        { age: 0.3125, x: 1.5 },
        { age: 0.1875, x: 2.5 },
        { age: 0.0625, x: 3.5 },
      ]);
    } finally {
      emitter.destroy();
    }
  });

  it("ages the births of a standing emitter's play without moving them", () => {
    const emitter = placingEmitter();
    try {
      emitter.play(8);
      tickEmitter(emitter, 0.25);
      tickEmitter(emitter, 0.25);

      expect(rowsOf(emitter, [2, 3])).toEqual([
        { age: 0.125, x: 0 },
        { age: 0, x: 0 },
      ]);
    } finally {
      emitter.destroy();
    }
  });
});

import { describe, expect, it, vi } from "vitest";
import { PerspectiveCamera } from "three";
import { FXEmitter } from "../../src/emitter/FXEmitter";
import { FX_POSITION_X, FX_POSITION_Z } from "../../src/coreLayout";
import { behaviorArtifact, unlitArtifact } from "../helpers/artifacts";
import { landBirths, particlesOf, renderFrame } from "../helpers/internals";
import { fieldOf, setField } from "../helpers/slots";

/** A behavior artifact: long lifetime, no motion, so positions stay put. */
function staticBehavior(): ReturnType<typeof behaviorArtifact> {
  return behaviorArtifact({ lifetime: 100 });
}

describe("FXEmitter depth sort order", () => {
  /**
   * Two particles, A at (0,0,1) and B at (10,0,5), a camera at (0,0,100) and the emitter posed by
   * `pose`; sorts once and returns row 0's (x, z) - A's whole row, not a partial swap, when A sorts
   * first. Untransformed, A is the farther one (99^2 vs 10^2 + 95^2), so back-to-front puts A first.
   */
  function frontRow(pose: (emitter: FXEmitter) => void): [number, number] {
    const emitter = FXEmitter.fromArtifacts(unlitArtifact(), staticBehavior(), {
      sortFraction: 1, // sort every frame
    });
    try {
      emitter.burst(2);
      landBirths(emitter);
      expect(emitter.particleCount).toBe(2);
      const mesh = particlesOf(emitter);
      const writeRow = (row: number, x: number, z: number): void => {
        setField(mesh, "position", row, FX_POSITION_X, x);
        setField(mesh, "position", row, 1, 0);
        setField(mesh, "position", row, FX_POSITION_Z, z);
      };
      // B in row 0, so only a sort that puts A first moves anything.
      writeRow(0, 10, 5);
      writeRow(1, 0, 1);

      pose(emitter);
      const camera = new PerspectiveCamera();
      camera.position.set(0, 0, 100);
      camera.updateMatrixWorld();
      emitter.sortCamera = camera;

      renderFrame(emitter, 0); // dt=0: no aging/integration, positions preserved

      const position = fieldOf(mesh, "position");
      return [position[FX_POSITION_X], position[FX_POSITION_Z]];
    } finally {
      emitter.destroy();
    }
  }

  it("sorts an untransformed emitter back-to-front by camera distance", () => {
    expect(frontRow(() => undefined)).toEqual([0, 1]);
  });

  // The shader draws positions as they are (no modelMatrix), so the emitter's own transform moves
  // nothing on screen - and must not reorder the sort either. Each pose here would put B first if
  // the sort transformed positions by the emitter's world matrix.
  it.each([
    ["rotated 180 degrees about Y", (emitter: FXEmitter) => emitter.rotation.set(0, Math.PI, 0)],
    ["moved past the camera", (emitter: FXEmitter) => emitter.position.set(0, 0, 200)],
    ["squashed 10x along z", (emitter: FXEmitter) => emitter.scale.set(1, 1, 0.1)],
  ])("sorts the drawn positions whatever the emitter's pose: %s", (_name, pose) => {
    expect(frontRow(pose)).toEqual([0, 1]);
  });
});

describe("FXEmitter depth sort cadence", () => {
  /** An emitter with live particles and a sort camera, and a spy on the sorts it runs. */
  function sortingEmitter(sortFraction?: number): {
    emitter: FXEmitter;
    sorts: () => number;
  } {
    const emitter = FXEmitter.fromArtifacts(
      unlitArtifact(),
      staticBehavior(),
      sortFraction === undefined ? {} : { sortFraction },
    );
    emitter.burst(2);
    landBirths(emitter);
    emitter.sortCamera = new PerspectiveCamera();
    const sort = vi.spyOn(particlesOf(emitter), "sortByDistance");
    return { emitter, sorts: () => sort.mock.calls.length };
  }

  /** The frames (1-based) of `count` frames that ran a sort. */
  function sortedFrames(emitter: FXEmitter, sorts: () => number, count: number): number[] {
    const frames: number[] = [];
    for (let frame = 1; frame <= count; frame++) {
      const before = sorts();
      renderFrame(emitter, 0);
      if (sorts() > before) {
        frames.push(frame);
      }
    }
    return frames;
  }

  it("sorts on one frame in 1 / sortFraction", () => {
    const half = sortingEmitter(0.5);
    const quarter = sortingEmitter(0.25);
    try {
      expect(sortedFrames(half.emitter, half.sorts, 6)).toEqual([2, 4, 6]);
      expect(sortedFrames(quarter.emitter, quarter.sorts, 8)).toEqual([4, 8]);
    } finally {
      half.emitter.destroy();
      quarter.emitter.destroy();
    }
  });

  it("defaults to about one frame in ten", () => {
    const { emitter, sorts } = sortingEmitter();
    try {
      expect(emitter.sortFraction).toBe(0.1);
      // 0.1 has no exact binary form: ten of them sum a hair short of 1, so the first sort lands
      // on frame 11, every tenth frame after it.
      expect(sortedFrames(emitter, sorts, 31)).toEqual([11, 21, 31]);
    } finally {
      emitter.destroy();
    }
  });

  it("clamps sortFraction above 1 to 1, as an option and as a direct assignment", () => {
    const { emitter, sorts } = sortingEmitter(5);
    try {
      expect(emitter.sortFraction).toBe(1);
      emitter.sortFraction = 5;
      expect(sortedFrames(emitter, sorts, 3)).toEqual([1, 2, 3]);
      // Nothing carried over from the oversized fraction: the next sort waits two frames.
      emitter.sortFraction = 0.5;
      expect(sortedFrames(emitter, sorts, 2)).toEqual([2]);
    } finally {
      emitter.destroy();
    }
  });

  it("never sorts at a sortFraction of 0 or below", () => {
    const { emitter, sorts } = sortingEmitter(0);
    try {
      expect(sortedFrames(emitter, sorts, 20)).toEqual([]);
      emitter.sortFraction = -1;
      expect(sortedFrames(emitter, sorts, 20)).toEqual([]);
    } finally {
      emitter.destroy();
    }
  });
});

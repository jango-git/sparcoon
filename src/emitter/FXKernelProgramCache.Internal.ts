import type { WebGLRenderer } from "three";

import type { FXParticleKernelArtifact } from "../artifact/FXArtifact.js";
import { type FXContextLease, FXContextLeases } from "./FXContextLeases.Internal.js";
import { FXLinkedProgram } from "./FXLinkedProgram.Internal.js";

const ERROR_PREFIX = "FXKernelProgramCache";

/**
 * Every holder of the same kernel on the same context shares one program. One that failed stays
 * until its last holder lets it go: the same sources fail the same way on the same context.
 */
const programs = new FXContextLeases<string, FXLinkedProgram>((gl, program) => {
  program.delete();
});

/** The exact sources, not a hash of them: a collision would hand a holder another kernel. */
function kernelKey(artifact: FXParticleKernelArtifact): string {
  return [
    artifact.vertexSource,
    artifact.fragmentSource,
    artifact.transformFeedbackVaryings.join(","),
  ].join("\0");
}

/**
 * @internal A claim on the program for `artifact` on `gl`, sent off to link on the first claim.
 * Its varyings come in buffer order, so the interleaved capture writes exactly the slot layout.
 */
export function acquireKernelProgram(
  gl: WebGL2RenderingContext,
  artifact: FXParticleKernelArtifact,
): FXContextLease<FXLinkedProgram> {
  return programs.acquire(
    gl,
    kernelKey(artifact),
    () =>
      new FXLinkedProgram(
        gl,
        artifact.vertexSource,
        artifact.fragmentSource,
        artifact.transformFeedbackVaryings,
        ERROR_PREFIX,
      ),
  );
}

/** A claim on a GPU kernel's program, sent off to build ahead of the emitter that runs it. */
export interface FXKernelPreparation {
  /**
   * Whether the program is still building on a context that can tell when the build ends. An
   * emitter built from the kernel meanwhile waits for the build on its first simulation step.
   */
  readonly building: boolean;
  /** Gives the claim up; an emitter built from the kernel holds its own. A second call is a no-op. */
  release(): void;
}

/**
 * Sends the program of `kernel` off to build on `renderer`'s WebGL2 context, so an emitter built
 * from it once {@link FXKernelPreparation.building} turns false finds it built.
 */
export function fxPrepareKernel(
  renderer: WebGLRenderer,
  kernel: FXParticleKernelArtifact,
): FXKernelPreparation {
  const lease = acquireKernelProgram(renderer.getContext() as WebGL2RenderingContext, kernel);
  return {
    get building(): boolean {
      return lease.resource.building;
    },
    release: (): void => {
      lease.release();
    },
  };
}

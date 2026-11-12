import type { Mesh, ShaderMaterial } from "three";

import type { FXEffect } from "../../src/effect/FXEffect";
import type { FXEmitter } from "../../src/emitter/FXEmitter";
import type { FXInstancedParticle } from "../../src/instancedParticle/FXInstancedParticle";
import type { FXTransformFeedbackParticle } from "../../src/instancedParticle/FXTransformFeedbackParticle";
import type { FXTrailLayout } from "../../src/render/FXArtifactMaterial.Internal";
import type { FXRangedBuffer } from "../../src/render/FXBufferUpload.Internal";
import type { FXWorld } from "../../src/world/FXWorld";

/**
 * Every reach into a runtime object's private state the tests need, in one place: a renamed private
 * member breaks here, not across the suite. TypeScript's `private` is not enforced at runtime, so
 * each is a typed cast over the member's real name.
 */

interface EmitterInternals {
  readonly mesh: FXInstancedParticle | FXTransformFeedbackParticle;
  readonly driver: {
    readonly simulation: { readonly bindings: Record<string, { readonly value: unknown }> };
  };
  readonly trail: TrailInternals | undefined;
  readonly emitterTransform: { readonly velocity: readonly number[] };
  tick(deltaTime: number): void;
  onRendering(deltaTime: number): void;
}

function internalsOf(emitter: FXEmitter): EmitterInternals {
  return emitter as unknown as EmitterInternals;
}

/** One simulated tick of `emitter` alone - no world, no depth sort, no frame uniforms. */
export function tickEmitter(emitter: FXEmitter, deltaTime: number): void {
  internalsOf(emitter).tick(deltaTime);
}

/**
 * Seeds the births `burst()` queued without simulating anything: a paused (zero-delta) tick, which
 * lands due births and does nothing else. Births land in a tick, never at the call.
 */
export function landBirths(emitter: FXEmitter): void {
  tickEmitter(emitter, 0);
}

/** One frame of `emitter` as its world drives it: the tick, then the depth sort. */
export function renderFrame(emitter: FXEmitter, deltaTime: number): void {
  internalsOf(emitter).onRendering(deltaTime);
}

/** The instanced mesh of a JS-driven emitter, holding one property buffer per particle field. */
export function particlesOf(emitter: FXEmitter): FXInstancedParticle {
  return internalsOf(emitter).mesh as FXInstancedParticle;
}

/** The live value of uniform `name` in `mesh`'s own material - the instance's slot, not the
 *  artifact's initial value. */
export function uniformValue(mesh: Mesh, name: string): unknown {
  return (mesh.material as ShaderMaterial).uniforms[name]?.value;
}

/** {@link uniformValue} in the particle material of a JS-driven `emitter`. */
export function emitterUniform(emitter: FXEmitter, name: string): unknown {
  return uniformValue(particlesOf(emitter), name);
}

/** The live value of behavior binding `name` in `emitter`'s own simulation - not the artifact's. */
export function bindingValue(emitter: FXEmitter, name: string): unknown {
  return internalsOf(emitter).driver.simulation.bindings[name]?.value;
}

/** The transform-feedback mesh of a GPU-driven emitter. */
export function gpuParticlesOf(emitter: FXEmitter): FXTransformFeedbackParticle {
  return internalsOf(emitter).mesh as FXTransformFeedbackParticle;
}

/** Whether `emitter` runs on the GPU driver: only its mesh has a ping-pong read buffer. */
export function isGPUDriven(emitter: FXEmitter): boolean {
  const mesh = internalsOf(emitter).mesh as Partial<FXTransformFeedbackParticle>;
  return typeof mesh.readBuffer === "function";
}

/** The world-space velocity `emitter` measured on its last tick. */
export function emitterVelocityOf(emitter: FXEmitter): readonly number[] {
  return internalsOf(emitter).emitterTransform.velocity;
}

/** What the tests read of an emitter's trail and its history. */
export interface TrailInternals {
  readonly mesh: Mesh;
  readonly head: number;
  readonly advanceGap: number;
  readonly history: {
    readonly array: Float32Array;
    readonly stride: number;
    readonly capacity: number;
    readonly frames: number;
    readonly layout: FXTrailLayout;
    readonly buffer: FXRangedBuffer;
  };
  readonly uniforms: {
    readonly head: { value: number };
    readonly ages: { value: Float32Array };
    readonly span: { value: number };
    readonly tail: { value: number };
  };
}

/** `emitter`'s trail; fails the test when it has none. */
export function trailOf(emitter: FXEmitter): TrailInternals {
  const trail = internalsOf(emitter).trail;
  if (trail === undefined) {
    throw new Error("trailOf: the emitter has no trail");
  }
  return trail;
}

/** Drives emitter `index` of `effect` with one frame's sampled parameter values. */
export function driveEmitterValues(
  effect: FXEffect,
  index: number,
  values: Map<string, number>,
): void {
  (
    effect as unknown as { driveEmitterValues(index: number, values: Map<string, number>): void }
  ).driveEmitterValues(index, values);
}

/** How many objects (emitters, meshes) `world` ticks. */
export function registeredObjectCount(world: FXWorld): number {
  return (world as unknown as { objects: readonly unknown[] }).objects.length;
}

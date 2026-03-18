import { FXParticleNormalsMode } from "../instancedParticle/FXParticleNormalsMode";
import { FXParticleRenderingMode } from "../instancedParticle/FXParticleRenderingMode";

export interface FXEmitterPlayOptions {
  duration: number;
}

export const EMITTER_DEFAULT_EXPECTED_CAPACITY = 32;
export const EMITTER_DEFAULT_CAPACITY_STEP = 32;
export const EMITTER_DEFAULT_AUTOMATICALLY_DESTROY_MODULES = true;
export const EMITTER_DEFAULT_CAST_SHADOW = false;
export const EMITTER_DEFAULT_RECEIVE_SHADOW = false;
export const EMITTER_DEFAULT_RENDERING_MODE = FXParticleRenderingMode.Unlit;
export const EMITTER_DEFAULT_NORMALS_MODE = FXParticleNormalsMode.Flat;

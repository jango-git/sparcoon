export interface FXEmitterOptions {
  expectedCapacity: number;
  capacityStep: number;
}

export interface FXEmitterPlayOptions {
  duration: number;
}

export const EMITTER_DEFAULT_EXPECTED_CAPACITY = 32;
export const EMITTER_DEFAULT_CAPACITY_STEP = 32;
export const EMITTER_DEFAULT_AUTOMATICALLY_DESTROY_MODULES = true;

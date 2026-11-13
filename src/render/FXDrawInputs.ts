/**
 * What a render's draw stage reads of the tick ({@link FXRenderArtifact.compute}): the values that
 * are one for the whole draw and known before it - the clock, the pose the tick sampled and the
 * object's motion. The camera is not among them: it differs per draw (the shadow pass's included),
 * so what reads it stays on the GPU.
 */
export interface FXDrawInputs {
  /** Seconds since the clock started (`u_time`). */
  readonly time: number;
  /** This tick's seconds (`u_deltaTime`). */
  readonly deltaTime: number;
  /** The drawn object's world matrix, column-major (`modelMatrix`), as the tick posed it. */
  readonly modelMatrix: ArrayLike<number>;
  /** World-space velocity, units per second (`objectVelocity`). */
  readonly objectVelocity: readonly [number, number, number];
  /** World-space angular velocity, radians per second about its axis (`objectAngularVelocity`). */
  readonly objectAngularVelocity: readonly [number, number, number];
  /**
   * The drawn object's own random seed (`RANDOM_SEED`): one number per object, the same every
   * frame, another for every object built - so two copies of one effect draw different randoms.
   * A particle seeds by its id instead, which its shaders read under the same name.
   */
  readonly seed: number;
}

/** One draw input: the GLSL name the shaders read it as, its {@link FXDrawInputs} field and type. */
export interface FXDrawInput {
  readonly name: string;
  readonly field: keyof FXDrawInputs;
  readonly type: string;
}

/** The one list of draw inputs: the editor's compiler takes the names, the runtime fills the fields. */
export const FX_DRAW_INPUTS: readonly FXDrawInput[] = [
  { name: "u_time", field: "time", type: "float" },
  { name: "u_deltaTime", field: "deltaTime", type: "float" },
  { name: "modelMatrix", field: "modelMatrix", type: "mat4" },
  { name: "objectVelocity", field: "objectVelocity", type: "vec3" },
  { name: "objectAngularVelocity", field: "objectAngularVelocity", type: "vec3" },
  { name: "RANDOM_SEED", field: "seed", type: "float" },
];

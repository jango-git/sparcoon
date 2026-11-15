import type { IUniform, Texture } from "three";

/**
 * @internal How a sorted GPU emitter's particles reach its material: two data textures (see
 * `FXDataTexture.Internal`), the floats of its slots back to back, and the slot each instance
 * draws, in draw order.
 */

export const FX_PARTICLE_SLOTS_UNIFORM = "fxParticleSlots";
export const FX_PARTICLE_ORDER_UNIFORM = "fxParticleOrder";

/** The two textures, as a material's uniforms hold them. */
export interface FXParticleTextures {
  readonly slots: IUniform<Texture>;
  readonly order: IUniform<Texture>;
}

/** GLSL ES 3.00: the slots texture, the texel of value `index` of a data texture, and float
 *  `index` of the slots. */
export const FX_PARTICLE_SLOTS_GLSL = [
  `uniform highp sampler2D ${FX_PARTICLE_SLOTS_UNIFORM};`,
  "ivec2 fxParticleTexel(ivec2 size, int index) {",
  "  return ivec2(index % size.x, index / size.x);",
  "}",
  "float fxParticleSlotFloat(int index) {",
  `  return texelFetch(${FX_PARTICLE_SLOTS_UNIFORM}, fxParticleTexel(textureSize(${FX_PARTICLE_SLOTS_UNIFORM}, 0), index), 0).r;`,
  "}",
].join("\n");

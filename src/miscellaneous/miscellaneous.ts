import type { Vector3Tuple } from "three";
import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  RGBAFormat,
  SRGBColorSpace,
  Texture,
  UnsignedByteType,
  UVMapping,
} from "three";
import type { Vector3Like } from "../miscellaneous/math";
import type { FXTextureConfig } from "../miscellaneous/texture/FXTextureView.Internal";
import type { FXColor } from "./color/FXColor";

export interface FXRange {
  min: number;
  max: number;
}

export type FXRangeConfig = FXRange | [number, number, number] | number;
export type FXVector3Config = Vector3Like | Vector3Tuple | number;
export type FXAspectConfig = number | FXTextureConfig;

export function resolveFXRangeConfig(config: FXRangeConfig): FXRange {
  if (typeof config === "number") {
    return { min: config, max: config };
  }

  if (Array.isArray(config)) {
    return { min: config[0], max: config[1] };
  }

  return config;
}

export function resolveFXVector3Config(config: FXVector3Config): Vector3Like {
  if (typeof config === "number") {
    return { x: config, y: config, z: config };
  }

  if (Array.isArray(config)) {
    return { x: config[0], y: config[1], z: config[2] };
  }

  return config;
}

export function resolveAspect(config: number | FXTextureConfig): number {
  if (typeof config === "number") {
    return config;
  }

  if (config instanceof Texture) {
    return config.image.naturalWidth / config.image.naturalHeight;
  }

  return config.sourceSize.w / config.sourceSize.h;
}

export function buildGradientTexture(colors: FXColor[]): DataTexture {
  const width = colors.length;
  const height = 1;
  const data = new Uint8Array(width * height * 4);

  for (let i = 0; i < width; i++) {
    const color = colors[i];

    const index = i * 4;
    data[index] = Math.round(color.r * 255);
    data[index + 1] = Math.round(color.g * 255);
    data[index + 2] = Math.round(color.b * 255);
    data[index + 3] = Math.round(color.a * 255);
  }

  const texture = new DataTexture(
    data,
    width,
    height,
    RGBAFormat,
    UnsignedByteType,
    UVMapping,
    ClampToEdgeWrapping,
    ClampToEdgeWrapping,
    LinearFilter,
    LinearFilter,
    1,
    SRGBColorSpace,
  );

  texture.needsUpdate = true;
  return texture;
}

export const BUILTIN_OFFSET_POSITION_X = 0;
export const BUILTIN_OFFSET_POSITION_Y = 1;
export const BUILTIN_OFFSET_POSITION_Z = 2;
export const BUILTIN_OFFSET_VELOCITY_X = 3;
export const BUILTIN_OFFSET_VELOCITY_Y = 4;
export const BUILTIN_OFFSET_VELOCITY_Z = 5;
export const BUILTIN_OFFSET_SCALE_X = 6;
export const BUILTIN_OFFSET_SCALE_Y = 7;
export const BUILTIN_OFFSET_SCALE_Z = 8;
export const BUILTIN_OFFSET_ROTATION = 9;
export const BUILTIN_OFFSET_TORQUE = 10;
export const BUILTIN_OFFSET_LIFETIME = 11;
export const BUILTIN_OFFSET_AGE = 12;
export const BUILTIN_OFFSET_RANDOM_A = 13;
export const BUILTIN_OFFSET_RANDOM_B = 14;
export const BUILTIN_OFFSET_RANDOM_C = 15;

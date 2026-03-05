export const EPSILON = 1e-6;

export interface Vector3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export function srgbToLinear(color: number): number {
  return color < 0.04045
    ? color * 0.0773993808
    : Math.pow(color * 0.9478672986 + 0.0521327014, 2.4);
}

export function linearToSRGB(color: number): number {
  return color < 0.0031308 ? color * 12.92 : 1.055 * Math.pow(color, 0.41666) - 0.055;
}

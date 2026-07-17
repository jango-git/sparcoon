export const EPSILON = 1e-6;

// sRGB <-> linear transfer matching three's GLSL curve (constants are the piecewise sRGB coefficients).
export function srgbToLinear(channel: number): number {
  return channel < 0.04045
    ? channel * 0.0773993808
    : Math.pow(channel * 0.9478672986 + 0.0521327014, 2.4);
}

export function linearToSRGB(channel: number): number {
  return channel < 0.0031308 ? channel * 12.92 : 1.055 * Math.pow(channel, 0.41666) - 0.055;
}

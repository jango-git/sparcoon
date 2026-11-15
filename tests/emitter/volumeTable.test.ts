import { Data3DTexture, RedFormat, RGBAFormat, UnsignedByteType } from "three";
import { describe, expect, it } from "vitest";

import { volumeTablesOf } from "../../src/emitter/FXVolumeTable.Internal";
import { FX_VOLUME_HEADER_FLOATS } from "../../src/volumeTableLayout";

/** A 2x2x2 R8 texture whose texel `i` holds `i * 30`. */
function field(): Data3DTexture {
  const texture = new Data3DTexture(
    Uint8Array.from({ length: 8 }, (_, i) => i * 30),
    2,
    2,
    2,
  );
  texture.format = RedFormat;
  texture.type = UnsignedByteType;
  return texture;
}

describe("volumeTablesOf", () => {
  it("lays the texels out after the size, as the GPU's sampler reads them", () => {
    const { v } = volumeTablesOf({ v: "field" }, { field: field() });
    expect([...v.data.subarray(0, FX_VOLUME_HEADER_FLOATS)]).toEqual([2, 2, 2]);
    expect(v.data[FX_VOLUME_HEADER_FLOATS + 5]).toBeCloseTo(150 / 255, 6);
    expect([v.width, v.height, v.depth]).toEqual([2, 2, 2]);
  });

  it("builds a texture's table once, and anew after it is updated", () => {
    const texture = field();
    const first = volumeTablesOf({ v: "field" }, { field: texture }).v;
    expect(volumeTablesOf({ w: "field" }, { field: texture }).w).toBe(first);
    texture.needsUpdate = true;
    expect(volumeTablesOf({ v: "field" }, { field: texture }).v).not.toBe(first);
  });

  it("requires the texture, as R8 with its texels on the CPU", () => {
    expect(() => volumeTablesOf({ v: "field" }, {})).toThrow(/no 3D texture "field"/);

    const rgba = field();
    rgba.format = RGBAFormat;
    expect(() => volumeTablesOf({ v: "field" }, { field: rgba })).toThrow(/RedFormat/);

    const short = new Data3DTexture(new Uint8Array(7), 2, 2, 2);
    short.format = RedFormat;
    expect(() => volumeTablesOf({ v: "field" }, { field: short })).toThrow(/8 texels/);
  });
});

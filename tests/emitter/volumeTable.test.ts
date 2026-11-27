import { Data3DTexture, RedFormat, RGBAFormat, UnsignedByteType } from "three";
import { describe, expect, it } from "vitest";

import { kernelResourcesOf } from "../../src/emitter/FXKernelResources.Internal";
import { volumeTableOf } from "../../src/emitter/FXVolumeTable.Internal";
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

describe("volumeTableOf", () => {
  it("lays the texels out after the size, as the GPU's sampler reads them", () => {
    const v = volumeTableOf(field(), "field");
    expect([...v.data.subarray(0, FX_VOLUME_HEADER_FLOATS)]).toEqual([2, 2, 2]);
    expect(v.data[FX_VOLUME_HEADER_FLOATS + 5]).toBeCloseTo(150 / 255, 6);
    expect([v.width, v.height, v.depth]).toEqual([2, 2, 2]);
  });

  it("builds a texture's table once, and anew after it is updated", () => {
    const texture = field();
    const first = volumeTableOf(texture, "field");
    expect(volumeTableOf(texture, "field")).toBe(first);
    texture.needsUpdate = true;
    expect(volumeTableOf(texture, "field")).not.toBe(first);
  });

  it("requires the texture, as R8 with its texels on the CPU", () => {
    expect(() =>
      kernelResourcesOf({ volumes: { v: "field" } }, { geometries: {}, meshes: {}, volumes: {} }),
    ).toThrow(/no 3D texture "field"/);

    const rgba = field();
    rgba.format = RGBAFormat;
    expect(() => volumeTableOf(rgba, "field")).toThrow(/RedFormat/);

    const short = new Data3DTexture(new Uint8Array(7), 2, 2, 2);
    short.format = RedFormat;
    expect(() => volumeTableOf(short, "field")).toThrow(/8 texels/);
  });
});

import type { Data3DTexture } from "three";
import { RedFormat, UnsignedByteType } from "three";

import { FX_VOLUME_HEADER_FLOATS } from "../volumeTableLayout.js";

/**
 * @internal A 3D texture as a behavior kernel samples it - `data` is the table the JS kernel reads
 * (see `volumeTableLayout.ts`), `bytes` the texels the GPU kernel's texture holds.
 */
export interface FXVolumeTable {
  readonly data: Float32Array;
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
}

interface FXVolumeTableEntry {
  readonly version: number;
  readonly table: FXVolumeTable;
}

// Built once per texture and shared by every emitter sampling it, rebuilt when the texture was
// updated since.
const tables = new WeakMap<Data3DTexture, FXVolumeTableEntry>();

/**
 * @internal The table of `texture`, the asset `name`.
 * @throws When it is not R8 (`RedFormat`, `UnsignedByteType`) with its texels on the CPU.
 */
export function volumeTableOf(texture: Data3DTexture, name: string): FXVolumeTable {
  const known = tables.get(texture);
  if (known?.version === texture.version) {
    return known.table;
  }
  const table = buildVolumeTable(texture, name);
  tables.set(texture, { version: texture.version, table });
  return table;
}

function buildVolumeTable(texture: Data3DTexture, name: string): FXVolumeTable {
  const subject = `FXEmitter.fromArtifacts: the 3D texture "${name}"`;
  if (texture.format !== RedFormat || texture.type !== UnsignedByteType) {
    throw new Error(`${subject} must be RedFormat with UnsignedByteType (R8)`);
  }
  const { data, width, height, depth } = texture.image as {
    readonly data: unknown;
    readonly width: number;
    readonly height: number;
    readonly depth: number;
  };
  const count = width * height * depth;
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(
      `${subject} has no texels (${String(width)}x${String(height)}x${String(depth)})`,
    );
  }
  if (!(data instanceof Uint8Array) || data.length !== count) {
    throw new Error(`${subject} must hold its ${String(count)} texels in image.data, a Uint8Array`);
  }
  const values = new Float32Array(FX_VOLUME_HEADER_FLOATS + count);
  values[0] = width;
  values[1] = height;
  values[2] = depth;
  for (let i = 0; i < count; i++) {
    values[FX_VOLUME_HEADER_FLOATS + i] = data[i] / 255;
  }
  return { data: values, bytes: data, width, height, depth };
}

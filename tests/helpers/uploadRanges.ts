import type { FXRangedBuffer } from "../../src/render/FXBufferUpload.Internal";

/** One range of floats a buffer uploads. */
export interface FXUploadRange {
  readonly start: number;
  readonly count: number;
}

/**
 * The ranges `buffer` uploads on its next render, whichever three it runs on: newer three's list,
 * or three 0.157's single range (`count: -1` when nothing is pending).
 */
export function pendingRanges(buffer: FXRangedBuffer): FXUploadRange[] {
  if (buffer.updateRanges !== undefined) {
    return buffer.updateRanges.map((range) => ({ start: range.start, count: range.count }));
  }
  const range = buffer.updateRange;
  return range === undefined || range.count < 0
    ? []
    : [{ start: range.offset, count: range.count }];
}

/** Clears what `buffer` has pending, as three does once it uploads it. */
export function clearRanges(buffer: FXRangedBuffer): void {
  if (buffer.updateRanges !== undefined) {
    buffer.updateRanges.length = 0;
  } else if (buffer.updateRange !== undefined) {
    buffer.updateRange.count = -1;
  }
  buffer.needsUpdate = false;
}

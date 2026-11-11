/** The update-range API of three's `InterleavedBuffer`, across the supported three versions. */
export interface FXRangedBuffer {
  // three >= 0.159 (and the only form left after 0.169).
  addUpdateRange?: (start: number, count: number) => void;
  updateRanges?: { start: number; count: number }[];
  // three 0.157 / 0.158.
  updateRange?: { offset: number; count: number };
  needsUpdate: boolean;
}

/**
 * @internal Marks `[start, start + count)` floats of `buffer` for upload, on top of whatever is
 * still pending (several ticks can pass between two renders - a prewarm is hundreds). Either way
 * the pending upload stays one range, widened to cover both: three 0.157 has a single range (reset
 * to `count: -1` once uploaded), and newer three's list (emptied once uploaded) would otherwise
 * grow by one range - one `bufferSubData` call - per tick. An empty range is skipped: WebGL2 reads
 * a zero `bufferSubData` length as "to the end of the array".
 */
export function markRange(buffer: FXRangedBuffer, start: number, count: number): void {
  if (count <= 0) {
    return;
  }
  if (typeof buffer.addUpdateRange === "function") {
    let first = start;
    let end = start + count;
    const pending = buffer.updateRanges;
    if (pending !== undefined && pending.length > 0) {
      for (const range of pending) {
        first = Math.min(first, range.start);
        end = Math.max(end, range.start + range.count);
      }
      pending.length = 0;
    }
    buffer.addUpdateRange(first, end - first);
  } else if (buffer.updateRange !== undefined) {
    const range = buffer.updateRange;
    if (range.count < 0) {
      range.offset = start;
      range.count = count;
    } else {
      const end = Math.max(range.offset + range.count, start + count);
      range.offset = Math.min(range.offset, start);
      range.count = end - range.offset;
    }
  }
  buffer.needsUpdate = true;
}

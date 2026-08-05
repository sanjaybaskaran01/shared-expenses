export interface UploadRange {
  start: number;
  endExclusive: number;
}

export function resumableUploadRanges(
  missingRanges: readonly UploadRange[] | undefined,
  received: number,
  total: number,
): readonly UploadRange[] {
  if (missingRanges) return missingRanges;
  return received < total ? [{ start: received, endExclusive: total }] : [];
}

export function uploadChunkOffsets(ranges: readonly UploadRange[], total: number, chunkSize = 250): number[] {
  const offsets = new Set<number>();
  for (const range of ranges) {
    for (let offset = Math.floor(range.start / chunkSize) * chunkSize; offset < Math.min(total, range.endExclusive); offset += chunkSize) {
      offsets.add(offset);
    }
  }
  return [...offsets].sort((left, right) => left - right);
}

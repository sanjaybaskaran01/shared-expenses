import { describe, expect, test } from "bun:test";
import { resumableUploadRanges, uploadChunkOffsets } from "../src/lib/import-upload";

describe("resumable import uploads", () => {
  test("uploads only the sparse ranges reported when a staged import resumes", () => {
    const ranges = resumableUploadRanges([
      { start: 250, endExclusive: 500 },
      { start: 750, endExclusive: 1_000 },
    ], 500, 1_000);
    expect(uploadChunkOffsets(ranges, 1_000)).toEqual([250, 750]);
  });

  test("falls back to the remaining suffix for older chunk acknowledgements", () => {
    expect(uploadChunkOffsets(resumableUploadRanges(undefined, 501, 1_000), 1_000)).toEqual([500, 750]);
    expect(resumableUploadRanges(undefined, 1_000, 1_000)).toEqual([]);
  });
});

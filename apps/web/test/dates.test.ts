import { describe, expect, test } from "bun:test";
import { isLocalToday, localDateValue } from "../src/lib/dates";

describe("local date values", () => {
  test("uses the user's calendar day instead of UTC", () => {
    const lateEveningInNewYork = new Date("2026-07-27T02:04:00.000Z");
    lateEveningInNewYork.getTimezoneOffset = () => 240;

    expect(localDateValue(lateEveningInNewYork)).toBe("2026-07-26");
    expect(isLocalToday("2026-07-26", lateEveningInNewYork)).toBe(true);
    expect(isLocalToday("2026-07-27", lateEveningInNewYork)).toBe(false);
  });
});

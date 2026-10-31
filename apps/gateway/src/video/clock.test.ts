import { describe, expect, it } from "vitest";
import { nextLocal } from "./clock.ts";

const NY = "America/New_York";

describe("nextLocal", () => {
  it("finds 03:00 on the US fall-back night (EST, 08:00 UTC), not an hour off", () => {
    // Saturday 2026-10-31, 23:00 EDT
    const from = Date.parse("2026-11-01T03:00:00Z");
    expect(new Date(nextLocal("03:00", NY, from)).toISOString()).toBe("2026-11-01T08:00:00.000Z");
  });

  it("returns the first of the two 01:30s that night", () => {
    const from = Date.parse("2026-11-01T03:00:00Z");
    expect(new Date(nextLocal("01:30", NY, from)).toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });

  it("rolls to tomorrow once today's time has passed, and rejects a bad time", () => {
    const from = Date.parse("2026-10-30T12:00:00Z"); // 08:00 EDT
    expect(new Date(nextLocal("03:00", NY, from)).toISOString()).toBe("2026-10-31T07:00:00.000Z");
    expect(() => nextLocal("3am", NY, from)).toThrow(/HH:MM/);
    expect(() => nextLocal("25:00", NY, from)).toThrow(/HH:MM/);
  });
});

import { describe, expect, it } from "vitest";
import { createFixedClock, systemClock } from "./clock.ts";
import { ulid } from "./ids.ts";

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function decodeTime(id: string): number {
  return [...id.slice(0, 10)].reduce((acc, ch) => acc * 32 + ALPHABET.indexOf(ch), 0);
}

describe("createFixedClock", () => {
  it("stands still until advanced", () => {
    const clock = createFixedClock(1_000);
    expect(clock.now()).toBe(1_000);
    expect(clock.now()).toBe(1_000);
    clock.advance(250);
    expect(clock.now()).toBe(1_250);
    expect(() => clock.advance(-1)).toThrow(RangeError);
  });

  it("systemClock follows Date.now", () => {
    const before = Date.now();
    const now = systemClock.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });
});

describe("ulid", () => {
  it("is 26 Crockford base32 characters encoding the clock time", () => {
    const clock = createFixedClock(Date.UTC(2026, 9, 27, 12, 0, 0));
    const id = ulid(clock);
    expect(id).toMatch(ULID_RE);
    expect(decodeTime(id)).toBe(clock.now());
  });

  it("is strictly increasing while the clock stands still", () => {
    const clock = createFixedClock(1_700_000_000_000);
    const ids = Array.from({ length: 2_000 }, () => ulid(clock));
    expect(new Set(ids).size).toBe(ids.length);
    for (let i = 1; i < ids.length; i++) expect((ids[i] ?? "") > (ids[i - 1] ?? "")).toBe(true);
    expect(ids.every((id) => decodeTime(id) === 1_700_000_000_000)).toBe(true);
  });

  it("moves the time part forward when the clock advances", () => {
    const clock = createFixedClock(1_700_000_000_000);
    const a = ulid(clock);
    clock.advance(1);
    const b = ulid(clock);
    expect(decodeTime(b)).toBe(1_700_000_000_001);
    expect(b > a).toBe(true);
  });

  it("stays monotonic when the clock goes backwards", () => {
    let t = 1_700_000_000_500;
    const clock = { now: () => t };
    const a = ulid(clock);
    t -= 400;
    const b = ulid(clock);
    expect(b > a).toBe(true);
    expect(decodeTime(b)).toBe(1_700_000_000_500);
  });

  it("keeps one sequence per clock", () => {
    const late = createFixedClock(2_000_000_000_000);
    const early = createFixedClock(1_000);
    ulid(late);
    expect(decodeTime(ulid(early))).toBe(1_000);
  });

  it("uses the system clock by default and stays sortable across rapid calls", () => {
    const ids = Array.from({ length: 500 }, () => ulid());
    expect(ids.every((id) => ULID_RE.test(id))).toBe(true);
    expect([...ids].sort()).toEqual(ids);
  });
});

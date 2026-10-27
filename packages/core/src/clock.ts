import type { Clock } from "./contracts/base.ts";

export const systemClock: Clock = { now: () => Date.now() };

/** A clock that only moves when told to (tests, evals, goldens). */
export function createFixedClock(startMs: number): Clock & { advance(ms: number): void } {
  if (!Number.isFinite(startMs))
    throw new RangeError(`createFixedClock needs a finite start time, got ${startMs}`);
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance(ms: number) {
      if (!Number.isFinite(ms) || ms < 0)
        throw new RangeError(`advance(ms) needs a finite, non-negative number, got ${ms}`);
      nowMs += ms;
    },
  };
}

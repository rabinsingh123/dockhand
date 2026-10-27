import { getRandomValues } from "node:crypto";
import { systemClock } from "./clock.ts";
import type { Clock } from "./contracts/base.ts";

// ULID: 48-bit millisecond timestamp (10 chars) + 80 bits of randomness (16 chars), Crockford base32.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
const MAX_TIME = 2 ** 48 - 1;

interface Sequence {
  time: number;
  random: number[]; // RANDOM_CHARS base-32 digits
}

// One monotonic sequence per clock object, so a fixed test clock never inherits the system clock's position.
const sequences = new WeakMap<Clock, Sequence>();

/**
 * Monotonic ULID: within one millisecond (or when the clock stands still or goes backwards) the random
 * part of the previous id is incremented, so ids from the same clock always sort in creation order.
 */
export function ulid(clock: Clock = systemClock): string {
  const now = Math.floor(clock.now());
  if (!Number.isFinite(now) || now < 0 || now > MAX_TIME)
    throw new RangeError(`ulid: clock time out of range: ${now}`);
  const last = sequences.get(clock);
  const next: Sequence =
    last && now <= last.time
      ? { time: last.time, random: increment(last.random) }
      : { time: now, random: randomDigits() };
  sequences.set(clock, next);
  return encodeTime(next.time) + next.random.map((d) => ALPHABET.charAt(d)).join("");
}

function encodeTime(ms: number): string {
  let out = "";
  let rest = ms;
  for (let i = 0; i < TIME_CHARS; i++) {
    out = ALPHABET.charAt(rest % 32) + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

function randomDigits(): number[] {
  // 256 is a multiple of 32, so masking a random byte gives a uniform base-32 digit.
  return Array.from(getRandomValues(new Uint8Array(RANDOM_CHARS)), (byte) => byte & 31);
}

function increment(digits: number[]): number[] {
  const next = digits.slice();
  for (let i = next.length - 1; i >= 0; i--) {
    const digit = next[i] ?? 0;
    if (digit < 31) {
      next[i] = digit + 1;
      return next;
    }
    next[i] = 0;
  }
  throw new Error("ulid: random component overflowed within one millisecond");
}

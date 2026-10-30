import { describe, expect, it } from "vitest";
import {
  alignPhone,
  type Change,
  changesFromSignal,
  EMULATOR_LAGS,
  PHONE_LAGS,
  parseSignalstats,
  type SyncEvent,
} from "./sync.ts";

/** A synthetic session: events every 4-20 s, the phone shows each with a realistic lag, plus noise. */
function session(seed: number, startAt: number, n = 40) {
  let x = seed;
  const rnd = () => {
    x = (x * 1103515245 + 12345) % 2 ** 31;
    return x / 2 ** 31;
  };
  const events: SyncEvent[] = [];
  const changes: Change[] = [];
  let t = startAt + 5000;
  for (let i = 0; i < n; i++) {
    t += 4000 + rnd() * 16000;
    const dir = rnd() < 0.45 ? "in" : "out";
    events.push({ at: t, dir });
    const lag = dir === "out" ? 0.4 + rnd() * 2 : -(0.3 + rnd() * 3);
    changes.push({ t: (t - startAt) / 1000 + lag, mag: 5 });
  }
  // unrelated screen changes (typing, scrolling): about one per 15 s
  const duration = (t - startAt) / 1000 + 10;
  for (let s = 0; s < duration; s += 15) changes.push({ t: s + rnd() * 10, mag: 3 });
  return { events, changes, duration };
}

describe("alignPhone", () => {
  it("finds the recording's start within half a second from a 2.5-minute-off metadata guess", () => {
    const startAt = Date.UTC(2026, 9, 31, 15, 0, 0);
    const { events, changes, duration } = session(7, startAt);
    const r = alignPhone(changes, events, { duration, priors: [startAt + 150_000], lags: PHONE_LAGS });
    expect(Math.abs(r.startAt - startAt)).toBeLessThan(500);
    expect(r.confidence).toBe("high");
    expect(r.matched).toBe(events.length);
  });

  it("searches every overlap when there is no metadata", () => {
    const startAt = Date.UTC(2026, 9, 31, 15, 0, 0);
    const { events, changes, duration } = session(11, startAt, 30);
    const r = alignPhone(changes, events, { duration, lags: PHONE_LAGS });
    expect(Math.abs(r.startAt - startAt)).toBeLessThan(500);
  });

  it("says low confidence when the recording does not belong to these events", () => {
    const startAt = Date.UTC(2026, 9, 31, 15, 0, 0);
    const { events } = session(3, startAt, 30);
    const unrelated = Array.from({ length: 60 }, (_, i) => ({ t: i * 9.7 + (i % 3), mag: 4 }));
    const r = alignPhone(unrelated, events, { duration: 600, priors: [startAt], lags: EMULATOR_LAGS });
    expect(r.confidence).not.toBe("high");
  });
});

describe("changesFromSignal", () => {
  it("keeps peaks well above the noise and merges the frames of one change", () => {
    const samples = Array.from({ length: 200 }, (_, i) => ({ t: i / 10, v: 0.2 + (i % 5) * 0.02 }));
    samples[50] = { t: 5.0, v: 9 };
    samples[51] = { t: 5.1, v: 12 };
    samples[120] = { t: 12.0, v: 4 };
    expect(changesFromSignal(samples)).toEqual([
      { t: 5.0, mag: 12 },
      { t: 12.0, mag: 4 },
    ]);
  });

  it("parses ffmpeg's metadata print", () => {
    const text =
      "frame:0    pts:0       pts_time:0\nlavfi.signalstats.YAVG=0.5\nframe:1    pts:1       pts_time:0.1\nlavfi.signalstats.YAVG=7.25\n";
    expect(parseSignalstats(text)).toEqual([
      { t: 0, v: 0.5 },
      { t: 0.1, v: 7.25 },
    ]);
  });
});

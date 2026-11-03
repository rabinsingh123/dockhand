// "Still working" lines on a first run: what the rep's phone shows while computer use fills a long form.

import { describe, expect, it } from "vitest";
import { progressReporter } from "./browser.ts";

function reporter() {
  let now = 0;
  const sent: string[] = [];
  const r = progressReporter({
    portalName: "Supplier Portal",
    startedAt: 0,
    now: () => now,
    send: (text) => sent.push(text),
  });
  return {
    sent,
    r,
    /** One progress event at second `s` with `count` actions (the loop's per-action report or its heartbeat). */
    at(s: number, count: number) {
      now = s * 1000;
      r.progress({ action: count, note: "" });
    },
  };
}

describe("progress lines", () => {
  it("never repeats a count (the model-wait heartbeat reports the same one)", () => {
    const p = reporter();
    p.at(30, 10);
    p.at(100, 28);
    p.at(170, 28); // waiting for the model: nothing new happened
    p.at(240, 28);
    expect(p.sent).toEqual([
      "Still working on Supplier Portal: 10 actions so far.",
      "Still working on Supplier Portal: 28 actions so far.",
    ]);
  });

  it("sends a few lines on a 5-minute run, not ten", () => {
    const p = reporter();
    // The live supplier run (live-sim-4): an action every few seconds, and heartbeats in between.
    for (let s = 1, count = 0; s <= 300; s++) {
      if (s % 3 === 0) count++;
      p.at(s, count);
    }
    expect(p.sent.length).toBeGreaterThanOrEqual(3);
    expect(p.sent.length).toBeLessThanOrEqual(5);
    const counts = p.sent.map((line) => Number(/: (\d+) actions/.exec(line)?.[1]));
    expect(counts).toEqual([...new Set(counts)].sort((a, b) => a - b));
  });

  it("stays quiet once the submit card is out (after the rep's last tap)", () => {
    const p = reporter();
    p.at(40, 20);
    p.r.commitGateOpened();
    p.at(200, 28);
    p.at(300, 31);
    expect(p.sent).toEqual(["Still working on Supplier Portal: 20 actions so far."]);
  });

  it("says nothing on a short run", () => {
    const p = reporter();
    for (let s = 1; s <= 25; s++) p.at(s, s);
    expect(p.sent).toEqual([]);
  });
});

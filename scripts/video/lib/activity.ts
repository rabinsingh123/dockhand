// Where a clip's picture changes: ffmpeg frame differences (10 fps, small grayscale) over a window, kept as
// ranges padded a little and merged across short pauses. Idle stretches (an unchanged page, a static chat, a
// slow pulse) fall out, so the edit can skip them.

import { parseSignalstats } from "../../../apps/gateway/src/video/sync.ts";
import { run } from "./media.ts";

export interface ActivityOptions {
  /** Mean per-pixel difference (0-255 scale, 160 px wide gray) that counts as a change. */
  threshold?: number;
  /** Seconds kept before and after each change. */
  pad?: number;
  /** Pauses shorter than this stay in. */
  minGap?: number;
}

/** Active ranges of `file` between `from` and `to` (seconds in the file), in file time. */
export async function activeRanges(
  file: string,
  from: number,
  to: number,
  o: ActivityOptions = {},
): Promise<[number, number][]> {
  const threshold = o.threshold ?? 0.35;
  const pad = o.pad ?? 0.35;
  const minGap = o.minGap ?? 1.2;
  const start = Math.max(0, from);
  if (to - start <= 0.2) return [];
  const log = await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostats",
      "-loglevel",
      "info",
      "-ss",
      start.toFixed(3),
      "-t",
      (to - start).toFixed(3),
      "-i",
      file,
      "-vf",
      "fps=10,scale=160:-2,format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG",
      "-an",
      "-f",
      "null",
      "-",
    ],
    { stderr: true },
  );
  const changes = parseSignalstats(log)
    .filter((s) => s.v >= threshold)
    .map((s) => start + s.t);
  const ranges: [number, number][] = [];
  for (const t of changes) {
    const a = Math.max(start, t - pad);
    const b = Math.min(to, t + pad);
    const last = ranges.at(-1);
    if (last && a - last[1] < minGap) last[1] = Math.max(last[1], b);
    else ranges.push([a, b]);
  }
  return ranges;
}

/** Total seconds in a list of ranges. */
export const span = (r: [number, number][]) => r.reduce((s, [a, b]) => s + (b - a), 0);

/** Maps a time in the source to a time in the cut made of `ranges` played back to back (null if cut out). */
export function mapTime(ranges: [number, number][], t: number): number | null {
  let acc = 0;
  for (const [a, b] of ranges) {
    if (t >= a && t <= b) return acc + (t - a);
    acc += b - a;
  }
  return null;
}

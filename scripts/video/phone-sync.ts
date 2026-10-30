// `pnpm video:sync`: places Rabin's phone screen recording on the gateway's clock, so the cut can put the phone
// next to the filmed browser in sync. Visual changes come from ffmpeg (frame differences); the events are every
// message of the session (cutlist.json). Writes <session>/phone-sync.json.
//
//   pnpm video:sync --session 2026-10-31-live [--phone path.mp4]     newest .mp4/.mov in <session>/phone by default
//   pnpm video:sync --session rh-cassette-1 --test                   rehearsal check: the filmed emulator chat
//                                                                     stands in for the phone, its true start hidden

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  alignPhone,
  changesFromSignal,
  EMULATOR_LAGS,
  PHONE_LAGS,
  parseSignalstats,
  type SyncEvent,
} from "../../apps/gateway/src/video/sync.ts";
import { workspaceRoot } from "../../packages/core/src/index.ts";
import { probe, run } from "./lib/media.ts";
import type { CutList } from "./session.ts";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const root = workspaceRoot();
const session = opt("--session");
if (!session) throw new Error("--session <name> is required");
const sessionDir = join(root, "var", "recordings", session);
const cut = JSON.parse(readFileSync(join(sessionDir, "cutlist.json"), "utf8")) as CutList;
const test = args.includes("--test");

let file = opt("--phone");
let trueStart: number | null = null;
if (test) {
  if (!cut.phoneSim) throw new Error("no emulator chat capture in this session (rehearsals only)");
  const folder = join(root, cut.phoneSim.folder);
  file = join(folder, "clip.mkv");
  trueStart = cut.phoneSim.startedAt;
} else if (!file) {
  const dir = join(sessionDir, "phone");
  const found = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => /\.(mp4|mov|m4v)$/i.test(f))
        .map((f) => join(dir, f))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    : [];
  file = found[0];
}
if (!file || !existsSync(file))
  throw new Error(`no phone recording found (pass --phone, or copy it into ${sessionDir}\\phone)`);

const p = await probe(file);
// Metadata guesses: creation time as the start or as the end, the file time as the end.
const priors = test
  ? [(trueStart as number) + 37_000] // a deliberately wrong guess: the search must find the truth
  : [
      ...(p.creationTime ? [p.creationTime, p.creationTime - p.duration * 1000] : []),
      p.mtime - p.duration * 1000,
    ];

// Frame differences at 10 fps on a small grayscale copy: a new bubble or a scroll is a spike.
const log = await run(
  "ffmpeg",
  [
    "-hide_banner",
    "-nostats",
    "-loglevel",
    "info",
    "-i",
    file,
    "-vf",
    "fps=10,scale=180:-2,format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG",
    "-an",
    "-f",
    "null",
    "-",
  ],
  { stderr: true },
);
const changes = changesFromSignal(parseSignalstats(log));

const seen = new Set<string>();
const events: SyncEvent[] = [];
for (const t of cut.takes)
  for (const m of t.events.msgs) {
    if (seen.has(m.waId)) continue;
    seen.add(m.waId);
    events.push({
      at: m.at,
      dir: m.dir,
      label: `${t.id}: ${m.kind} ${m.text.split("\n")[0]?.slice(0, 50) ?? ""}`,
    });
  }
const startGuess = priors[0] ?? 0;
const inRange = events.filter(
  (e) => e.at >= startGuess - 600_000 && e.at <= startGuess + p.duration * 1000 + 600_000,
);
const r = alignPhone(changes, inRange.length >= 5 ? inRange : events, {
  duration: p.duration,
  priors,
  searchS: test ? 120 : 600,
  lags: test ? EMULATOR_LAGS : PHONE_LAGS,
});
const out = {
  file: relative(root, file),
  profile: test ? "emulator (rehearsal stand-in)" : "phone",
  startAt: r.startAt,
  startIso: new Date(r.startAt).toISOString(),
  confidence: r.confidence,
  matched: r.matched,
  total: r.total,
  margin: r.margin,
  residualMs: r.residualMs,
  changes: changes.length,
  priors,
  ...(trueStart !== null ? { trueStartAt: trueStart, errorMs: r.startAt - trueStart } : {}),
};
writeFileSync(
  join(sessionDir, test ? "phone-sync-test.json" : "phone-sync.json"),
  `${JSON.stringify({ ...out, lags: r.lags }, null, 2)}\n`,
);
process.stdout.write(
  `phone recording starts at ${out.startIso} (${r.confidence} confidence: ${r.matched}/${r.total} events matched, margin ${r.margin}, residual ${r.residualMs} ms; ${changes.length} visual changes)` +
    (trueStart !== null
      ? `\nrehearsal check: true start ${new Date(trueStart).toISOString()}, error ${out.errorMs} ms`
      : "") +
    "\n",
);

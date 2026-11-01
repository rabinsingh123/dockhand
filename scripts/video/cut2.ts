// `pnpm video:cut2`: the 3:00 film from recorded sessions, beat by beat (docs/internal/NARRATION.md v3).
//
//   pnpm video:cut2 --session rh-cassette-2 --also rh-fake-2      takes come from the first session that has them
//      [--race <race.json>] [--hook <lock-screen.mp4>] [--narration docs/internal/NARRATION.md]
//
// One subject full-bleed per beat (the phone at full height, or the browser filling the frame); a split screen
// only for the race. Idle stretches (an unchanged page or chat) are cut; whatever is still too long is sped up,
// and every speed-up is labeled. Push-ins follow the heal: a 600 ms ease-out to at most 1.12x, done with ffmpeg's
// perspective filter (sub-pixel, bicubic), which moves smoothly where zoompan's whole-pixel crop jitters. Type is
// rendered in Geist by a headless Chromium (lib/overlay.ts) and laid over by ffmpeg: no new dependency (Remotion
// would add React, its renderer and its own Chromium). Captions are the narration's lines; no dev captions, no
// clock. A rehearsal's emulator chat is labeled "Simulated chat (rehearsal)" wherever it appears.
//
// Output: <first session>/cuts-v2/rough-cut-v2.mp4 (1920x1080, 30 fps, 3:00) and contact-sheet.png.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { workspaceRoot } from "../../packages/core/src/index.ts";
import { activeRanges, mapTime, span } from "./lib/activity.ts";
import { ffmpeg, probe } from "./lib/media.ts";
import {
  captionChunks,
  captionHtml,
  labelHtml,
  lowerThirdHtml,
  type Overlay,
  renderOverlays,
  slateHtml,
  terminalHtml,
} from "./lib/overlay.ts";
import {
  type Clip,
  cameraShot,
  clipOfRun,
  healOf,
  loadSession,
  mainRun,
  type Session,
  takeIn,
} from "./lib/sessions.ts";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const root = workspaceRoot();
const names = [opt("--session"), ...(opt("--also")?.split(",") ?? [])].filter(Boolean) as string[];
if (names.length === 0) throw new Error("--session <name> is required");
const sessions: Session[] = [];
for (const n of names) sessions.push(await loadSession(n));
const first = sessions[0] as Session;
const outDir = join(first.dir, "cuts-v2");
const work = join(outDir, "work");
const png = join(work, "png");
mkdirSync(png, { recursive: true });
const FPS = 30;
const PAPER = "0xF6F5F1";
const t0 = Date.now();
const say = (s: string) =>
  process.stdout.write(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s] ${s}\n`);
const x264 = ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-an"];

// ---------- pieces ----------

type Fit = "phone" | "browser" | "camera";
interface Push {
  /** Source time (s, in the file) the push starts; it eases in over 600 ms. */
  at: number;
  /** Center in source pixels. */
  cx: number;
  cy: number;
}
interface VideoPiece {
  kind: "video";
  file: string;
  ranges: [number, number][];
  fit: Fit;
  target: number;
  /** Fixed playback speed (0.25 for the slowed pick); otherwise as fast as needed to fit, at least 1. */
  speed?: number;
  push?: Push;
  labels?: string[];
}
interface StillPiece {
  kind: "still";
  png: string;
  target: number;
}
interface SplitPiece {
  kind: "split";
  /** The left pane's states (opaque full frames) and how long each shows. */
  left: { png: string; dur: number }[];
  right: VideoPiece;
  target: number;
}
type Piece = VideoPiece | StillPiece | SplitPiece;

interface Beat {
  n: number;
  name: string;
  /** Seconds in the film. */
  dur: number;
  pieces: Piece[];
  /** Extra overlays over the whole beat (the lower-third stat). */
  extra?: { png: string; from: number; to: number }[];
}

const overlays: Overlay[] = [];
let ovN = 0;
function overlay(html: string, opaque = false): string {
  const name = `o${String(++ovN).padStart(3, "0")}.png`;
  overlays.push({ name, html, opaque });
  return join(png, name);
}
const labelCache = new Map<string, string>();
function label(text: string, right = false): string {
  const key = `${right ? "R" : "L"}${text}`;
  const known = labelCache.get(key);
  if (known) return known;
  const p = overlay(labelHtml(text, { right }));
  labelCache.set(key, p);
  return p;
}
function slate(title: string, sub: string, target: number, note?: string): StillPiece {
  return { kind: "still", png: overlay(slateHtml(title, sub, note ? { note } : {}), true), target };
}

const fmtSpeed = (s: number) =>
  (s >= 10 ? `${Math.round(s)}` : `${Math.round(s * 10) / 10}`).replace(/\.0$/, "");

/** The piece's speed: fixed, or the least that fits the target (never slower than real time). */
function speedOf(p: VideoPiece): number {
  return p.speed ?? Math.max(1, span(p.ranges) / p.target);
}

/** Perspective corners (source sense) for an eased push-in to `zmax` at output time `ts`, over `d` seconds. */
function pushFilter(push: Push, ts: number, w: number, h: number, zmax = 1.12, d = 0.6): string {
  const e = `clip((on/${FPS}-${ts.toFixed(3)})/${d},0,1)`;
  const z = `(1+${(zmax - 1).toFixed(3)}*(1-pow(1-${e},3)))`;
  const ww = `(W/${z})`;
  const hh = `(H/${z})`;
  const x0 = `clip(${push.cx.toFixed(1)}-${ww}/2,0,W-${ww})`;
  const y0 = `clip(${push.cy.toFixed(1)}-${hh}/2,0,H-${hh})`;
  const x1 = `${x0}+${ww}`;
  const y2 = `${y0}+${hh}`;
  const esc = (s: string) => s.replace(/,/g, "\\,");
  void w;
  void h;
  return `perspective=x0=${esc(x0)}:y0=${esc(y0)}:x1=${esc(x1)}:y1=${esc(y0)}:x2=${esc(x0)}:y2=${esc(y2)}:x3=${esc(x1)}:y3=${esc(y2)}:interpolation=cubic:eval=frame`;
}

/** Trim to the ranges, set the speed and the push: the filter chain from input 0, ending in [v]. */
function sourceChain(p: VideoPiece, seekFrom: number): string {
  const n = p.ranges.length;
  const speed = speedOf(p);
  const parts: string[] = [];
  const outs = p.ranges.map((_, i) => `[s${i}]`).join("");
  parts.push(`[0:v]split=${n}${outs}`);
  p.ranges.forEach(([a, b], i) => {
    parts.push(
      `[s${i}]trim=start=${(a - seekFrom).toFixed(3)}:end=${(b - seekFrom).toFixed(3)},setpts=PTS-STARTPTS[t${i}]`,
    );
  });
  const chain = [`${p.ranges.map((_, i) => `[t${i}]`).join("")}concat=n=${n}:v=1:a=0`];
  chain.push(`setpts=PTS/${speed.toFixed(4)}`, `fps=${FPS}`);
  if (p.push) {
    const at = mapTime(p.ranges, p.push.at);
    if (at !== null) chain.push(pushFilter(p.push, Math.max(0, at / speed - 0.1), 0, 0));
  }
  parts.push(`${chain.join(",")}[v]`);
  return parts.join(";");
}

function fitChain(fit: Fit): string {
  if (fit === "phone") return `[v]scale=-2:1000:flags=lanczos[fv];[bg][fv]overlay=x=(W-w)/2:y=40[f]`;
  if (fit === "browser") return `[v]scale=1920:1200:flags=lanczos,crop=1920:1080:0:60[f]`;
  return `[v]scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos[fv];[bg][fv]overlay=x=(W-w)/2:y=(H-h)/2[f]`;
}

/** A video piece's labels: its own, plus the speed-up it needed ("4× speed"). */
function labelsOf(p: Piece): string[] {
  if (p.kind === "still") return [];
  const v = p.kind === "split" ? p.right : p;
  const labels = [...(v.labels ?? [])];
  const speed = speedOf(v);
  if (v.speed === undefined && speed > 1.05) labels.push(`${fmtSpeed(speed)}× speed`);
  return labels;
}

let pieceN = 0;
async function renderPiece(p: Piece): Promise<string> {
  const out = join(work, `p${String(++pieceN).padStart(3, "0")}.mp4`);
  const frames = String(Math.round(p.target * FPS));
  if (p.kind === "still") {
    await ffmpeg(["-loop", "1", "-framerate", String(FPS), "-i", p.png, "-frames:v", frames, ...x264, out]);
    return out;
  }
  const v = p.kind === "split" ? p.right : p;
  const seek = Math.max(0, Math.min(...v.ranges.map((r) => r[0])) - 1);
  const labels = labelsOf(p);
  const inputs = ["-ss", seek.toFixed(3), "-i", v.file];
  let graph: string;
  if (p.kind === "split") {
    const list = join(work, `p${pieceN}-left.txt`);
    const entries = p.left.flatMap((l) => [
      `file '${l.png.replace(/\\/g, "/")}'`,
      `duration ${l.dur.toFixed(3)}`,
    ]);
    const lastLeft = p.left.at(-1);
    if (lastLeft) entries.push(`file '${lastLeft.png.replace(/\\/g, "/")}'`);
    writeFileSync(list, `ffconcat version 1.0\n${entries.join("\n")}\n`);
    inputs.push("-f", "concat", "-safe", "0", "-i", list);
    graph = [
      sourceChain(v, seek),
      `[1:v]fps=${FPS},scale=1920:1080,tpad=stop_mode=clone:stop_duration=${p.target}[bg]`,
      // 1.35x like every browser shot (HUD text 30 CSS px becomes 40 px); right-aligned beside the terminal
      `[v]scale=1728:1080:flags=lanczos,crop=1352:1080:376:0,tpad=stop_mode=clone:stop_duration=${p.target}[fv]`,
      `[bg][fv]overlay=x=568:y=0[f]`,
    ].join(";");
  } else {
    inputs.push("-f", "lavfi", "-i", `color=c=${PAPER}:s=1920x1080:r=${FPS}`);
    graph = [
      sourceChain(v, seek),
      `[v]tpad=stop_mode=clone:stop_duration=${p.target}[vh]`,
      fitChain(v.fit).replace("[v]", "[vh]").replace("[bg]", "[1:v]"),
    ].join(";");
  }
  // labels over the whole piece
  let last = "f";
  labels.forEach((l, i) => {
    inputs.push("-loop", "1", "-i", label(l, p.kind === "split"));
    const idx = p.kind === "split" ? 2 + i : 2 + i;
    graph += `;[${last}][${idx}:v]overlay=0:0:shortest=1[l${i}]`;
    last = `l${i}`;
  });
  await ffmpeg([...inputs, "-filter_complex", graph, "-map", `[${last}]`, "-frames:v", frames, ...x264, out]);
  return out;
}

// ---------- the beats ----------

const narration = readFileSync(opt("--narration") ?? join(root, "docs", "internal", "NARRATION.md"), "utf8");
/** Beat n's voiceover line from the narration table (| time | n Name | words | line |). */
function lineOf(n: number): string {
  for (const row of narration.split("\n")) {
    const cells = row.split("|").map((c) => c.trim());
    if (cells.length >= 5 && new RegExp(`^${n} `).test(cells[2] ?? "")) return cells[4] ?? "";
  }
  return `[caption placeholder for beat ${n}]`;
}

const sec = (clip: { start: number }, wall: number) => (wall - clip.start) / 1000;

async function trimmed(
  file: string,
  a: number,
  b: number,
  o?: { threshold?: number },
): Promise<[number, number][]> {
  const r = await activeRanges(file, a, b, o);
  return r.length ? r : [[a, Math.min(b, a + 1.5)]];
}

/** The phone track over a wall-clock window, idle stretches cut, labeled simulated if it is the emulator. */
async function phonePiece(
  s: Session,
  from: number,
  to: number,
  target: number,
  keepIdle = false,
): Promise<Piece> {
  const ph = s.phone;
  if (!ph) return slate("Phone footage", "the phone recording goes here", target, "placeholder");
  const a = sec(ph, from);
  const b = sec(ph, to);
  return {
    kind: "video",
    file: ph.file,
    ranges: keepIdle ? [[Math.max(0, a), b]] : await trimmed(ph.file, a, b),
    fit: "phone",
    target,
    labels: ph.simulated ? ["Simulated chat (rehearsal)"] : [],
  };
}

/** A run's filmed page, idle stretches cut, pushed in on its open-weights heal. */
async function runPiece(
  s: Session,
  runId: string,
  clip: Clip,
  target: number,
  o: { speed?: number; from?: number; to?: number } = {},
): Promise<VideoPiece> {
  const a = o.from ?? 0;
  const b = o.to ?? sec(clip, clip.end);
  const heal = healOf(s, runId);
  const box = heal?.bbox;
  return {
    kind: "video",
    file: clip.file,
    ranges: await trimmed(clip.file, a, b),
    fit: "browser",
    target,
    ...(o.speed ? { speed: o.speed } : {}),
    ...(heal
      ? {
          push: {
            at: sec(clip, heal.start) - 0.5,
            cx: box ? Math.min(1280, box.x + box.w / 2) : 640,
            cy: box ? Math.min(700, Math.max(100, box.y + box.h / 2)) : 400,
          },
        }
      : {}),
  };
}

function cameraPiece(s: Session, label: string, target: number): Piece {
  const c = cameraShot(s, label);
  if (!c) return slate("Close-up", label, target, "placeholder");
  const end = (c.end - c.start) / 1000;
  return { kind: "video", file: c.file, ranges: [[0, end]], fit: "camera", target };
}

async function assetPiece(file: string, target: number): Promise<Piece> {
  if (!existsSync(file)) return slate("Asset missing", relative(root, file), target, "placeholder");
  const p = await probe(file);
  return { kind: "video", file, ranges: [[0, p.duration]], fit: "camera", target, speed: 1 };
}

const msgs = (a: { events: { msgs: { dir: string; kind: string; text: string; at: number }[] } }) =>
  a.events.msgs;

async function buildBeats(): Promise<Beat[]> {
  const beats: Beat[] = [];

  // 1. Hook: the real lock screen at 3 AM.
  const hook = opt("--hook") ?? join(first.dir, "phone", "hook.mp4");
  beats.push({
    n: 1,
    name: "hook",
    dur: 5,
    pieces: [
      existsSync(hook)
        ? {
            kind: "video",
            file: hook,
            ranges: [[0, Math.min(5, (await probe(hook)).duration)]],
            fit: "phone",
            target: 5,
            speed: 1,
          }
        : slate(
            "Lock screen, 3 AM",
            "the real drift-watch notification",
            5,
            "placeholder: Rabin's lock-screen footage goes here",
          ),
    ],
  });

  // 2. The race: the recorded script dies (left), Dockhand repairs (right); then the pick at 0.25x.
  const hero = takeIn(sessions, "hero");
  const heroRun = hero && mainRun(hero.a);
  const heroClip = hero && heroRun ? clipOfRun(hero.s, heroRun.id) : undefined;
  // The recorded script's real run (scripts/video/race.ts): its stderr lines with run-relative times.
  const raceFile = opt("--race") ?? join(first.dir, "race", "race.json");
  const race = existsSync(raceFile)
    ? (JSON.parse(readFileSync(raceFile, "utf8")) as {
        lines?: { t: number; text: string; stream?: string }[];
        timeoutMs?: number;
        errorName?: string;
        run?: { ms: number };
      })
    : null;
  const split = 16.5;
  // Readable in 40 px: no blank lines, no Node internals, the local paths cut down to the script's file name.
  const realLines = (race?.lines ?? [])
    .filter((l) => l.text.trim() && !/node:internal|node_modules|race\.ts|^\s*[{}]|^Call log:/.test(l.text))
    .map((l) => ({
      t: l.t,
      text: l.text.replace(/\(?[A-Za-z]:\\[^)]*\\([^\\)]+)\)?/g, "($1)").replace(/^\s+/, ""),
    }))
    .slice(0, 3);
  const timeoutS = (race?.timeoutMs ?? 5000) / 1000;
  const failAt = (race?.run?.ms ?? 5285) / 1000;
  const title = race ? "Recorded Playwright script" : "Recorded Playwright script (placeholder)";
  const foot = `${timeoutS} s timeout for the video; Playwright's default is 30 s`;
  const left: { png: string; dur: number }[] = [];
  for (let k = 0; k < Math.floor(failAt); k++)
    left.push({
      png: overlay(terminalHtml({ title, status: `running · ${k} s`, lines: [], foot }), true),
      dur: 1,
    });
  left.push({
    png: overlay(terminalHtml({ title, status: `running · ${Math.floor(failAt)} s`, lines: [], foot }), true),
    dur: failAt - Math.floor(failAt),
  });
  left.push({
    png: overlay(
      terminalHtml({
        title,
        status: `stopped · ${failAt.toFixed(1)} s`,
        lines: race
          ? realLines.map((l, i) => ({ text: l.text, error: i === 0 }))
          : [{ text: "TimeoutError (placeholder until race.ts writes race/race.json)", error: true }],
        foot,
      }),
      true,
    ),
    dur: split - failAt,
  });
  const racePieces: Piece[] = [];
  if (hero && heroRun && heroClip) {
    const right = await runPiece(hero.s, heroRun.id, heroClip, split);
    racePieces.push({ kind: "split", left, right, target: split });
    const heal = healOf(hero.s, heroRun.id);
    if (heal) {
      const at = sec(heroClip, heal.start);
      racePieces.push({
        kind: "video",
        file: heroClip.file,
        ranges: [[Math.max(0, at - 0.4), Math.min(sec(heroClip, heroClip.end), at + 1.725)]],
        fit: "browser",
        target: 25 - split,
        speed: 0.25,
        push: right.push ?? { at, cx: 640, cy: 400 },
        labels: ["Replay 0.25×"],
      });
    } else
      racePieces.push(slate("Replay 0.25×", "no open-weights heal in this take", 25 - split, "placeholder"));
  } else racePieces.push(slate("The race", "hero take missing", 25, "placeholder"));
  beats.push({ n: 2, name: "race", dur: 25, pieces: racePieces });

  // 3. Why: a real WhatsApp thread, one sourced stat.
  const quote = takeIn(sessions, "quote") ?? takeIn(sessions, "supplier2");
  const stat = overlay(
    lowerThirdHtml(
      "91% of online adults in India chat with businesses weekly",
      "Kantar 2025, cited by Meta Newsroom, Sep 2025",
    ),
  );
  beats.push({
    n: 3,
    name: "why",
    dur: 15,
    pieces: [
      quote
        ? await phonePiece(
            quote.s,
            (quote.a.readyAt ?? quote.a.startedAt) - 2000,
            (quote.a.endedAt ?? quote.a.startedAt) + 6000,
            15,
            true,
          )
        : slate("A WhatsApp thread", "voice notes, photos, PDFs", 15, "placeholder"),
    ],
    extra: [{ png: stat, from: 2, to: 14.5 }],
  });

  // 4. Teach: the recording in, the teach card, the first run (sped up, labeled), the code.
  const teach = takeIn(sessions, "teach");
  const teachPieces: Piece[] = [];
  if (teach) {
    const m = msgs(teach.a);
    const card = m.find((x) => x.dir === "out" && x.kind === "interactive" && /^I learned/.test(x.text));
    const tapped = card ? m.find((x) => x.dir === "in" && x.kind === "button" && x.at > card.at) : undefined;
    const from = (teach.a.readyAt ?? teach.a.startedAt) - 500;
    teachPieces.push(await phonePiece(teach.s, from, (tapped?.at ?? from + 8000) + 1500, 7));
    // what Muse Wonder drafted from the recording (the recorder's teach view, focus mode)
    teachPieces.push(cameraPiece(teach.s, "__teach", 6));
    const run = mainRun(teach.a);
    const clip = run ? clipOfRun(teach.s, run.id) : undefined;
    teachPieces.push(
      clip && run
        ? await runPiece(teach.s, run.id, clip, 12)
        : slate("First run", "computer use", 12, "placeholder"),
    );
    teachPieces.push(cameraPiece(teach.s, "code-v1", 10));
  } else teachPieces.push(slate("Teach", "teach take missing", 35, "placeholder"));
  beats.push({ n: 4, name: "teach", dur: 35, pieces: teachPieces });

  // 5. Use: a voice note (live) or the photo, Approve, the 4 s replay at 1x, the receipt; a HubSpot deal beat.
  const use = takeIn(sessions, "use");
  const usePieces: Piece[] = [];
  if (use) {
    const m = msgs(use.a);
    const approve = m.find((x) => x.dir === "in" && x.kind === "button");
    const from = (use.a.readyAt ?? use.a.startedAt) - 500;
    usePieces.push(await phonePiece(use.s, from, (approve?.at ?? from + 4000) + 800, 5));
    const run = mainRun(use.a);
    const clip = run ? clipOfRun(use.s, run.id) : undefined;
    usePieces.push(
      clip && run
        ? await runPiece(use.s, run.id, clip, 9, { speed: 1 })
        : slate("Replay", "4 s at 1×", 9, "placeholder"),
    );
    const receipt = m.find((x) => x.dir === "out" && x.kind === "image" && /Replay ·/.test(x.text));
    usePieces.push(
      receipt
        ? await phonePiece(use.s, receipt.at - 500, receipt.at + 2500, 3, true)
        : slate("Receipt", "", 3, "placeholder"),
    );
  } else usePieces.push(slate("Use", "use take missing", 17, "placeholder"));
  usePieces.push(
    slate(
      "HubSpot",
      "the deal and the quote, through its API",
      3,
      "placeholder: a 3 s capture of the HubSpot deal",
    ),
  );
  beats.push({ n: 5, name: "use", dur: 20, pieces: usePieces });

  // 6. EspoCRM: its own admin changed it, the heal, the pick.
  const espo = takeIn(sessions, "espocrm");
  const espoPieces: Piece[] = [
    slate(
      "EspoCRM, open source, unmodified",
      "Its own admin renames 'First Name' to 'Given Name' and reorders the form",
      4,
    ),
  ];
  if (espo) {
    const run = mainRun(espo.a);
    const clip = run ? clipOfRun(espo.s, run.id) : undefined;
    espoPieces.push(
      clip && run
        ? await runPiece(espo.s, run.id, clip, 13)
        : slate("EspoCRM", "run missing", 13, "placeholder"),
    );
    espoPieces.push(cameraPiece(espo.s, "pick-espocrm", 8));
  } else espoPieces.push(slate("EspoCRM", "EspoCRM take missing", 21, "placeholder"));
  beats.push({ n: 6, name: "espocrm", dur: 25, pieces: espoPieces });

  // 7. Ask: the new required field, the rep taps Gold.
  const ask = takeIn(sessions, "ask");
  const askPieces: Piece[] = [];
  if (ask) {
    const q = ask.a.events.gates.find((g) => g.kind === "question");
    const run = mainRun(ask.a);
    const clip = run ? clipOfRun(ask.s, run.id) : undefined;
    askPieces.push(
      clip && run
        ? await runPiece(ask.s, run.id, clip, 9, q ? { to: sec(clip, q.at) + 1.5 } : {})
        : slate("Ask", "run missing", 9, "placeholder"),
    );
    askPieces.push(
      q
        ? await phonePiece(ask.s, q.at - 300, (q.resolvedAt ?? q.at + 3000) + 1500, 6)
        : slate("Ask", "", 6, "placeholder"),
    );
  } else askPieces.push(slate("Ask", "ask take missing", 15, "placeholder"));
  beats.push({ n: 7, name: "ask", dur: 15, pieces: askPieces });

  // 8. Proof: the baseline, heal rungs, cost curve.
  const assets = join(root, "assets", "video");
  beats.push({
    n: 8,
    name: "proof",
    dur: 30,
    pieces: [
      slate(
        "42 UI changes it had never seen",
        "A recorded script broke on 21. Dockhand handled all 42, with zero wrong writes.",
        10,
        "One selector per step, like a typical recording; with five stored selectors per step it broke on 9 of 42.",
      ),
      await assetPiece(join(assets, "chart-heals.mp4"), 9),
      await assetPiece(join(assets, "chart-cost.mp4"), 11),
    ],
  });

  // 9. End card.
  beats.push({ n: 9, name: "end", dur: 10, pieces: [await assetPiece(join(assets, "endcard.mp4"), 10)] });
  return beats;
}

// ---------- render ----------

/** Top when the piece on screen is a full-bleed browser shot pushing in on something in its lower part. */
function placeAt(b: Beat, t: number): "top" | "bottom" {
  let start = 0;
  for (const p of b.pieces) {
    if (t < start + p.target)
      return p.kind === "video" && p.fit === "browser" && (p.push?.cy ?? 0) > 440 ? "top" : "bottom";
    start += p.target;
  }
  return "bottom";
}

const beats = await buildBeats();
// captions: each beat's line in chunks of at most two lines, timed by words
const captionPlan = beats.map((b) => {
  const chunks = captionChunks(lineOf(b.n));
  const words = chunks.map((c) => c.split(/\s+/).length);
  const total = words.reduce((x, y) => x + y, 0) || 1;
  let at = 0.15;
  const usable = b.dur - 0.3;
  return chunks.map((c, i) => {
    const d = (usable * (words[i] as number)) / total;
    const item = { png: overlay(captionHtml(c, placeAt(b, at + d / 2))), from: at, to: at + d };
    at += d;
    return item;
  });
});
for (const b of beats) for (const p of b.pieces) for (const l of labelsOf(p)) label(l, p.kind === "split");
say(`rendering ${overlays.length} overlays (Geist, headless Chromium)`);
await renderOverlays(png, overlays);

const beatFiles: string[] = [];
for (const [i, b] of beats.entries()) {
  const sum = b.pieces.reduce((s, p) => s + p.target, 0);
  if (Math.abs(sum - b.dur) > 0.01) throw new Error(`beat ${b.n}: pieces last ${sum} s, the beat ${b.dur} s`);
  say(`beat ${b.n} ${b.name}: ${b.pieces.length} piece(s)`);
  const files: string[] = [];
  for (const p of b.pieces) files.push(await renderPiece(p));
  const list = join(work, `beat${b.n}.txt`);
  writeFileSync(list, `${files.map((f) => `file '${f.replace(/\\/g, "/")}'`).join("\n")}\n`);
  const joined = join(work, `beat${b.n}-joined.mp4`);
  await ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", joined]);
  // captions and extras over the beat
  const items = [...(b.extra ?? []), ...(captionPlan[i] ?? [])];
  const inputs = ["-i", joined];
  let graph = "";
  let last = "0:v";
  items.forEach((it, k) => {
    inputs.push("-loop", "1", "-i", it.png);
    graph += `${graph ? ";" : ""}[${last}][${k + 1}:v]overlay=0:0:shortest=1:enable='between(t,${it.from.toFixed(2)},${it.to.toFixed(2)})'[c${k}]`;
    last = `c${k}`;
  });
  const out = join(work, `beat${b.n}.mp4`);
  if (items.length)
    await ffmpeg([
      ...inputs,
      "-filter_complex",
      graph,
      "-map",
      `[${last}]`,
      "-frames:v",
      String(Math.round(b.dur * FPS)),
      ...x264,
      out,
    ]);
  else await ffmpeg(["-i", joined, "-frames:v", String(Math.round(b.dur * FPS)), ...x264, out]);
  beatFiles.push(out);
}

const filmList = join(work, "film.txt");
writeFileSync(filmList, `${beatFiles.map((f) => `file '${f.replace(/\\/g, "/")}'`).join("\n")}\n`);
const film = join(outDir, "rough-cut-v2.mp4");
rmSync(film, { force: true });
await ffmpeg(["-f", "concat", "-safe", "0", "-i", filmList, "-c", "copy", "-movflags", "+faststart", film]);
const sheet = join(outDir, "contact-sheet.png");
await ffmpeg([
  "-i",
  film,
  "-vf",
  `fps=1/5,scale=384:-1,tile=6x6:padding=8:margin=8:color=${PAPER}`,
  "-frames:v",
  "1",
  sheet,
]);
const p = await probe(film);
say(
  `rough cut v2: ${relative(root, film)} (${p.duration.toFixed(2)} s); contact sheet: ${relative(root, sheet)}`,
);

// `pnpm video:cut2`: the 3:00 film from recorded sessions, beat by beat (docs/internal/NARRATION.md v4, "The night
// shift").
//
//   pnpm video:cut2 --session live-1,live-sim-4      takes come from the first session that has them (--also adds more)
//      [--hands <clip>] [--founder <clip>] [--by-hand <clip> --by-hand-seconds <n>] [--voices <list.json>]
//      [--race <race.json>] [--hook <lock-screen.mp4>] [--overnight-card <clip>] [--hubspot <deal-capture.mp4>]
//      [--narration <file>] [--vo <dir>]
//      [--final]   fails if a placeholder, taped footage or an emulator chat would reach the film. A live-sim session
//                  may supply browser footage: its models were live, and only its rep was the emulator
//
//   --voices is a JSON list of { name, title, country, quote, clip? }: one quote card each in beat 2, shown only when
//   given. A clip plays its sound under the card; the picture stays the card.
//
//   --vo is a folder of Rabin's voiceover, one clip per beat: beat<n>.<wav|m4a|mp3|aac|ogg|flac> starts at the
//   beat's first spoken caption group, and beat<n>-<k> at group k (from 1) for a line with a silence in it (beat 3
//   waits for the replay). Each is leveled and loses its lead-in and tail silence. A part comes in on its cue, or a
//   breath after the part before when that one runs long; a line that still overruns its room plays up to 7% faster
//   instead of being cut, and past that the cut names the clip to record again. Captions follow the voice.
//
// One subject full-bleed per beat (the phone at full height, or the browser filling the frame); a split screen
// only for the race. Idle stretches (an unchanged page or chat) are cut; whatever is still too long is sped up,
// and every speed-up is labeled with what the viewer gets: the real time covered over the time on screen. The film
// carries sound only where a shot keeps its own (the hands, the founder, a voice clip); the rest is silence for the
// voiceover. Push-ins follow the heal: a 600 ms ease-out to at most 1.12x, done with ffmpeg's perspective filter
// (sub-pixel, bicubic) on the full-size frame before the downscale, which moves smoothly where zoompan's whole-pixel
// crop jitters. Type is rendered in Mona Sans by a headless Chromium (lib/overlay.ts) and laid over by ffmpeg: no new
// dependency (Remotion would add React, its renderer and its own Chromium). Captions are the narration's lines; no
// dev captions, no clock. A rehearsal's emulator chat is labeled "Simulated chat (rehearsal)" wherever it appears.
//
// Output: <first session>/cuts-v2/rough-cut-v2.mp4 (1920x1080, 30 fps, 3:00) and contact-sheet.png.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { workspaceRoot } from "../../packages/core/src/index.ts";
import { COLOR } from "../../packages/design/src/index.ts";
import { activeRanges, mapTime, span } from "./lib/activity.ts";
import { countFrames, ffmpeg, hasAudio, probe, speechOf } from "./lib/media.ts";
import {
  type CaptionPos,
  captionChunks,
  captionHtml,
  footnoteHtml,
  type LabelSlot,
  labelHtml,
  lowerThirdHtml,
  type Overlay,
  quoteHtml,
  renderOverlays,
  slateHtml,
  terminalHtml,
  timerHtml,
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
const names = [...(opt("--session")?.split(",") ?? []), ...(opt("--also")?.split(",") ?? [])].filter(Boolean);
if (names.length === 0) throw new Error("--session <name> is required");
const sessions: Session[] = [];
for (const n of names) sessions.push(await loadSession(n));
const first = sessions[0] as Session;
const outDir = join(first.dir, "cuts-v2");
const work = join(outDir, "work");
const png = join(work, "png");
mkdirSync(png, { recursive: true });
const FPS = 30;
/** Seconds on a whole frame, so a beat's pieces add up to it exactly. */
const onFrame = (s: number) => Math.round(s * FPS) / FPS;
const GROUND = COLOR.ground.replace("#", "0x");
const t0 = Date.now();
const say = (s: string) =>
  process.stdout.write(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s] ${s}\n`);
const x264 = [
  "-c:v",
  "libx264",
  "-preset",
  "medium",
  "-crf",
  "18",
  "-pix_fmt",
  "yuv420p",
  "-color_range",
  "tv",
  "-colorspace",
  "bt709",
  "-color_primaries",
  "bt709",
  "-color_trc",
  "bt709",
  "-an",
];
/**
 * Every piece ends in the same picture format. Sources differ (full-range browser frames, limited-range charts);
 * without this the pieces disagree at their seams, ffmpeg rebuilds the filter graph there and loses frames.
 */
const SAME_FORMAT =
  "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709,setsar=1";

// ---------- pieces ----------

/** code: a recorder page lifted clear of the caption, so its footer line stays whole. */
type Fit = "phone" | "browser" | "camera" | "code";
interface Push {
  /** Source time (s, in the file) the push starts; it eases in over 600 ms. */
  at: number;
  /** Center in source pixels. */
  cx: number;
  cy: number;
}
/** A timed run of full-frame overlays (the hand-timed clock). */
type Ticks = { png: string; dur: number }[];
/** The sound a piece keeps: the file's own from its start, at this gain. */
interface Sound {
  file: string;
  gain: number;
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
  ticks?: Ticks;
  sound?: Sound;
  /** Where the caption goes over this piece (default: bottom). */
  caption?: CaptionPos;
}
interface StillPiece {
  kind: "still";
  png: string;
  target: number;
  sound?: Sound;
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
  /** Extra overlays over the beat (the lower-third stat, the chart's footnote). */
  extra?: { png: string; from: number; to: number }[];
  /**
   * Where the line lands: each group starts at the caption matching `first` and runs up to the next group's,
   * spread over seconds `at` to `to` of the beat. A silence is the gap between two groups. Default: the whole
   * line over the whole beat.
   */
  captions?: CaptionGroup[];
  /** No captions from the one matching this on: the frame says the words itself. */
  captionsStop?: RegExp;
  /** The caption group the voiceover starts at; the groups before it are spoken on camera. Default 0. */
  voFrom?: number;
}
interface CaptionGroup {
  first: RegExp;
  at: number;
  to: number;
}

/** What would make this cut not the film: --final refuses to render it. */
const notFinal: string[] = [];
const overlays: Overlay[] = [];
let ovN = 0;
function overlay(html: string, opaque = false): string {
  const name = `o${String(++ovN).padStart(3, "0")}.png`;
  overlays.push({ name, html, opaque });
  return join(png, name);
}
const labelCache = new Map<string, string>();
function label(text: string, slot: LabelSlot): string {
  const key = `${slot}${text}`;
  const known = labelCache.get(key);
  if (known) return known;
  const p = overlay(labelHtml(text, { slot }));
  labelCache.set(key, p);
  return p;
}
function slate(title: string, sub: string, target: number, note?: string): StillPiece {
  if (note?.includes("placeholder")) notFinal.push(`${title}: ${note}`);
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
    // The start of the push can fall in a cut wait: it then lands where the picture comes back.
    const resume = p.ranges.find((r) => r[0] >= (p.push?.at ?? 0))?.[0];
    const at = mapTime(p.ranges, p.push.at) ?? (resume === undefined ? null : mapTime(p.ranges, resume));
    if (at !== null) chain.push(pushFilter(p.push, Math.max(0, at / speed - 0.1), 0, 0));
  }
  parts.push(`${chain.join(",")}[v]`);
  return parts.join(";");
}

function fitChain(fit: Fit): string {
  if (fit === "phone") return `[v]scale=-2:1000:flags=lanczos[fv];[bg][fv]overlay=x=(W-w)/2:y=40[f]`;
  if (fit === "browser") return `[v]scale=1920:1200:flags=lanczos,crop=1920:1080:0:60[f]`;
  if (fit === "code")
    return `[v]scale=1920:1080:flags=lanczos,crop=1920:1016:0:64,pad=1920:1080:0:0:color=${GROUND}[f]`;
  return `[v]scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos[fv];[bg][fv]overlay=x=(W-w)/2:y=(H-h)/2[f]`;
}

/**
 * A video piece's labels: its own, plus the speed-up the viewer gets ("4× speed"): the real time it covers, cut
 * stretches included, over its time on screen. The HUD's status panel is top right on a browser shot, so its labels
 * go top left; the race's goes in the band under the panes; on the phone and on close-ups the speed takes the top
 * right, since the simulated label has the top left.
 */
function labelsOf(p: Piece): { text: string; slot: LabelSlot }[] {
  if (p.kind === "still") return [];
  const v = p.kind === "split" ? p.right : p;
  const labels = (v.labels ?? []).map((text) => ({ text, slot: "tl" as LabelSlot }));
  const covered = (v.ranges.at(-1)?.[1] ?? 0) - (v.ranges[0]?.[0] ?? 0);
  const speed = v.speed ?? covered / v.target;
  if (speed > 1.05) {
    const slot: LabelSlot = p.kind === "split" ? "br" : v.fit === "browser" ? "tl" : "tr";
    labels.push({ text: `${fmtSpeed(speed)}× speed`, slot });
  }
  return labels;
}

/** An ffconcat list of full-frame PNGs, each held for its duration; the last one stays. */
function stillList(name: string, states: Ticks): string {
  const list = join(work, name);
  const entries = states.flatMap((l) => [
    `file '${l.png.replace(/\\/g, "/")}'`,
    `duration ${l.dur.toFixed(3)}`,
  ]);
  const last = states.at(-1);
  if (last) entries.push(`file '${last.png.replace(/\\/g, "/")}'`);
  writeFileSync(list, `ffconcat version 1.0\n${entries.join("\n")}\n`);
  return list;
}

let pieceN = 0;
async function renderPiece(p: Piece): Promise<string> {
  const out = join(work, `p${String(++pieceN).padStart(3, "0")}.mp4`);
  const frames = String(Math.round(p.target * FPS));
  if (p.kind === "still") {
    await ffmpeg([
      "-loop",
      "1",
      "-framerate",
      String(FPS),
      "-i",
      p.png,
      "-vf",
      SAME_FORMAT,
      "-frames:v",
      frames,
      ...x264,
      out,
    ]);
    return out;
  }
  const v = p.kind === "split" ? p.right : p;
  const seek = Math.max(0, Math.min(...v.ranges.map((r) => r[0])) - 1);
  const labels = labelsOf(p);
  const inputs = ["-ss", seek.toFixed(3), "-i", v.file];
  let graph: string;
  if (p.kind === "split") {
    inputs.push("-f", "concat", "-safe", "0", "-i", stillList(`p${pieceN}-left.txt`, p.left));
    graph = [
      sourceChain(v, seek),
      `[1:v]fps=${FPS},scale=1920:1080,${SAME_FORMAT},tpad=stop_mode=clone:stop_duration=${p.target}[bg]`,
      // A true split: the whole page, uncropped, beside the terminal (left 30%); the caption has the band below.
      `[v]${SAME_FORMAT},scale=1344:840:flags=lanczos,tpad=stop_mode=clone:stop_duration=${p.target}[fv]`,
      `[bg][fv]overlay=x=576:y=0[f]`,
    ].join(";");
  } else {
    inputs.push("-f", "lavfi", "-i", `color=c=${GROUND}:s=1920x1080:r=${FPS},${SAME_FORMAT}`);
    graph = [
      sourceChain(v, seek),
      `[v]${SAME_FORMAT},tpad=stop_mode=clone:stop_duration=${p.target}[vh]`,
      fitChain(v.fit).replace("[v]", "[vh]").replace("[bg]", "[1:v]"),
    ].join(";");
  }
  // labels over the whole piece
  let last = "f";
  labels.forEach((l, i) => {
    inputs.push("-loop", "1", "-i", label(l.text, l.slot));
    graph += `;[${last}][${2 + i}:v]overlay=0:0:shortest=1[l${i}]`;
    last = `l${i}`;
  });
  if (v.ticks) {
    inputs.push("-f", "concat", "-safe", "0", "-i", stillList(`p${pieceN}-ticks.txt`, v.ticks));
    graph += `;[${last}][${2 + labels.length}:v]overlay=0:0:eof_action=repeat[tk]`;
    last = "tk";
  }
  graph += `;[${last}]setsar=1[out]`;
  await ffmpeg([...inputs, "-filter_complex", graph, "-map", "[out]", "-frames:v", frames, ...x264, out]);
  return out;
}

// ---------- the beats ----------

const narration = readFileSync(opt("--narration") ?? join(root, "docs", "internal", "NARRATION.md"), "utf8");
const handSeconds = Number(opt("--by-hand-seconds"));
/** Beat n's voiceover line from the narration table (| time | n Name | picture | line |), as it is spoken. */
function lineOf(n: number): string {
  for (const row of narration.split("\n")) {
    const cells = row.split("|").map((c) => c.trim());
    if (cells.length >= 5 && new RegExp(`^${n} `).test(cells[2] ?? ""))
      return (cells[4] ?? "")
        .replace(/\*\[[^\]]*\]\*/g, " ") // stage directions: *[the orange card, 2 s, no voice]*
        .replace("[MEASURED]", handSeconds > 0 ? String(Math.round(handSeconds / 30) / 2) : "[MEASURED]")
        .replace(/\s+/g, " ")
        .trim();
  }
  notFinal.push(`no narration line for beat ${n}`);
  return `[caption placeholder for beat ${n}]`;
}

const sec = (clip: { start: number }, wall: number) => (wall - clip.start) / 1000;
const SIMULATED = "Simulated chat (rehearsal)";
/** Under the voice, not beside it. */
const HANDS_GAIN = 0.35;

async function trimmed(
  file: string,
  a: number,
  b: number,
  o?: { threshold?: number },
): Promise<[number, number][]> {
  const r = await activeRanges(file, a, b, o);
  return r.length ? r : [[a, Math.min(b, a + 1.5)]];
}

/** The phone track over a wall-clock window: idle stretches cut, labeled simulated if it is the emulator. */
async function phonePiece(
  s: Session,
  from: number,
  to: number,
  target: number,
  keepIdle = false,
): Promise<Piece> {
  const ph = s.phone;
  if (ph?.simulated) notFinal.push(`${s.name}: the phone track is the emulator ("${SIMULATED}")`);
  if (!ph) return slate("Phone footage", "the phone recording goes here", target, "placeholder");
  const a = sec(ph, from);
  const b = sec(ph, to);
  const whole: [number, number][] = [[Math.max(0, a), b]];
  const cut = keepIdle ? whole : await trimmed(ph.file, a, b);
  return {
    kind: "video",
    file: ph.file,
    // A chat that would freeze once cut plays through instead, when that stays close to real time.
    ranges: span(cut) < target && b - a <= target * 2 ? whole : cut,
    fit: "phone",
    target,
    labels: ph.simulated ? [SIMULATED] : [],
  };
}

/**
 * A run's filmed page, idle stretches cut, pushed in on its open-weights heal. The push is anchored on the top
 * center of the page, in source pixels: the HUD's status panel (top right) and the repair card (left) both stay
 * whole, and only the sidebar and the foot of the page leave the frame.
 */
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
  const { width } = await probe(clip.file);
  return {
    kind: "video",
    file: clip.file,
    ranges: await trimmed(clip.file, a, b),
    fit: "browser",
    target,
    ...(o.speed ? { speed: o.speed } : {}),
    ...(heal ? { push: { at: sec(clip, heal.start) - 0.5, cx: width / 2, cy: 0 } } : {}),
  };
}

/** A recorder page the take filmed. `still`: it does not move, so it plays from its start and claims no speed. */
function cameraPiece(
  s: Session,
  label: string,
  target: number,
  o: { still?: boolean; fit?: Fit } = {},
): Piece {
  const c = cameraShot(s, label);
  if (!c) return slate("Close-up", label, target, "placeholder");
  const end = (c.end - c.start) / 1000;
  return o.still
    ? { kind: "video", file: c.file, ranges: [[0, Math.min(end, target)]], fit: "camera", target, speed: 1 }
    : { kind: "video", file: c.file, ranges: [[0, end]], fit: o.fit ?? "camera", target };
}

/** A clip passed by flag: from its start at real speed, its last frame held if it runs short. */
async function clipPiece(file: string, target: number, fit: Fit, gain?: number): Promise<VideoPiece> {
  const { duration } = await probe(file);
  const piece: VideoPiece = {
    kind: "video",
    file,
    ranges: [[0, Math.min(target, duration)]],
    fit,
    target,
    speed: 1,
  };
  if (gain === undefined) return piece;
  if (await hasAudio(file)) return { ...piece, sound: { file, gain } };
  notFinal.push(`${relative(root, file)}: its sound was to stay, and it has none`);
  return piece;
}

/** Seconds a chart still draws at the head of its piece; its caption lands once it is fully drawn. */
const CHART_LEAD = 1.3;

/** A chart from the end of its draw-in: fully drawn by CHART_LEAD, then held for the rest of the piece. */
async function chartPiece(file: string, target: number): Promise<Piece> {
  if (!existsSync(file)) return slate("Asset missing", relative(root, file), target, "placeholder");
  const { duration } = await probe(file);
  const moves = await activeRanges(file, 0, duration, { threshold: 0.02, pad: 0, minGap: 60 });
  const drawn = moves.at(-1)?.[1] ?? duration;
  say(`${relative(root, file)}: drawn at ${drawn.toFixed(1)} s of ${duration.toFixed(1)} s`);
  const from = Math.max(0, drawn - CHART_LEAD);
  return {
    kind: "video",
    file,
    ranges: [[from, Math.min(duration, from + target)]],
    fit: "camera",
    target,
    speed: 1,
  };
}

const msgs = (a: { events: { msgs: { dir: string; kind: string; text: string; at: number }[] } }) =>
  a.events.msgs;

interface Voice {
  name: string;
  title: string;
  country: string;
  quote: string;
  clip?: string;
}

function loadVoices(): Voice[] {
  const file = opt("--voices");
  if (!file) return [];
  const list = JSON.parse(readFileSync(file, "utf8")) as Voice[];
  if (!Array.isArray(list)) throw new Error("--voices: a JSON list is expected");
  for (const v of list) {
    for (const key of ["name", "title", "country", "quote"] as const)
      if (!v[key]) throw new Error(`--voices: no ${key} in ${JSON.stringify(v)}`);
    if (v.clip && !existsSync(v.clip)) throw new Error(`--voices: ${v.clip} does not exist`);
    if (/\b(sample|placeholder|example)\b/i.test(`${v.name} ${v.quote}`))
      notFinal.push(`--voices: "${v.name}" is a placeholder, not a real person's words`);
  }
  return list;
}

async function voicePiece(v: Voice, target: number): Promise<StillPiece> {
  const png = overlay(quoteHtml(v), true);
  const sound = v.clip && (await hasAudio(v.clip)) ? { file: v.clip, gain: 1 } : null;
  return { kind: "still", png, target, ...(sound ? { sound } : {}) };
}

const clockOf = (s: number) => {
  const whole = Math.floor(s);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
};

/** How long the clock sits on the measured time at the end of the shot. */
const TIMER_HOLD = 0.8;

/**
 * The human filling the form: sped up to fit, under a running clock that ends on the real measured time and holds
 * there, with who timed it.
 */
async function byHandPiece(file: string, seconds: number, target: number): Promise<VideoPiece> {
  const { duration } = await probe(file);
  if (Math.abs(duration - seconds) > seconds * 0.05)
    say(
      `--by-hand runs ${duration.toFixed(0)} s, --by-hand-seconds says ${seconds}: the clock shows the flag`,
    );
  const speed = Math.max(1, duration / (target - TIMER_HOLD));
  const n = Math.round((duration / speed) * 10);
  const ticks: Ticks = [];
  for (let k = 0; k <= n; k++)
    ticks.push({
      png: overlay(timerHtml("Timed by the builder", clockOf((seconds * k) / n))),
      dur: k < n ? 0.1 : TIMER_HOLD,
    });
  return { kind: "video", file, ranges: [[0, duration]], fit: "camera", target, speed, ticks };
}

/** Beat 5's close: the card from the phone; until it is filmed, the rendered card, labeled a placeholder. */
async function overnightCard(target: number): Promise<Piece> {
  const flag = opt("--overnight-card");
  if (flag) return clipPiece(flag, target, "phone");
  const night = takeIn(sessions, "overnight");
  const card = night && msgs(night.a).find((x) => x.dir === "out" && /changed overnight/.test(x.text));
  if (night && card) return phonePiece(night.s, card.at - 300, card.at + target * 1000 - 300, target, true);
  const file = join(root, "var", "design", "cards", "watch.png");
  if (!existsSync(file))
    return slate("Overnight card", "", target, "placeholder: the phone recording goes here");
  notFinal.push("overnight card: placeholder, var/design/cards/watch.png");
  return {
    kind: "video",
    file,
    ranges: [[0, 0.04]],
    fit: "phone",
    target,
    speed: 1,
    labels: ["Placeholder: overnight card"],
    caption: "top",
  };
}

/** The credits, held under the voice, then the hard cut to lemon that the clip itself makes at 6 s. */
async function endPieces(file: string, credits: number, card: number): Promise<Piece[]> {
  if (!existsSync(file)) return [slate("Asset missing", relative(root, file), credits + card, "placeholder")];
  const { duration } = await probe(file);
  const cut = 6;
  const piece = (ranges: [number, number][], target: number): VideoPiece => ({
    kind: "video",
    file,
    ranges,
    fit: "camera",
    target,
    speed: 1,
  });
  return [piece([[0, cut - 0.05]], credits), piece([[cut, duration]], card)];
}

async function buildBeats(): Promise<Beat[]> {
  const beats: Beat[] = [];
  for (const s of sessions)
    if (s.cut.mode !== "live" && s.cut.mode !== "live-sim")
      notFinal.push(`${s.name} was recorded in ${s.cut.mode} mode, not live`);

  // 1. Eleven at night: real hands in a dark room, their keyboard under the voice.
  const hands = opt("--hands");
  beats.push({
    n: 1,
    name: "eleven at night",
    dur: 12,
    pieces: [
      hands
        ? await clipPiece(hands, 12, "camera", HANDS_GAIN)
        : slate(
            "Hands on a laptop, dark room",
            "real keyboard sound under the voice",
            12,
            "placeholder: --hands <clip>",
          ),
    ],
  });

  // 2. Who, and what it costs: Rabin to camera, a real rep's words if we have them, the form by hand with its timer.
  const founder = opt("--founder");
  const byHand = opt("--by-hand");
  const voices = loadVoices();
  // Up to seven seconds of quote cards, shared between them.
  const eachVoice = voices.length ? onFrame(Math.min(3.5, 7 / voices.length)) : 0;
  const voicesEnd = 5 + eachVoice * voices.length;
  const byHandTarget = onFrame(18 - voicesEnd);
  // The voice turns from the login to the typing here: on the by-hand shot, a little into it if it has the beat alone.
  const typed = Math.max(10, voicesEnd);
  // The rules, sourced, over the by-hand shot: Dell's while the voice says them, then Microsoft's.
  const rulesAt = voicesEnd + 0.1;
  const rulesMid = onFrame((rulesAt + 17.85) / 2);
  beats.push({
    n: 2,
    name: "who, and what it costs",
    dur: 18,
    voFrom: founder ? 1 : 0,
    pieces: [
      founder
        ? await clipPiece(founder, 5, "camera", 1)
        : slate("Rabin to camera", "five seconds, his own sound", 5, "placeholder: --founder <clip>"),
      ...(await Promise.all(voices.map((v) => voicePiece(v, eachVoice)))),
      byHand && handSeconds > 0
        ? await byHandPiece(byHand, handSeconds, byHandTarget)
        : slate(
            "The form, by hand",
            "sped up, with the real timer",
            byHandTarget,
            "placeholder: --by-hand <clip> --by-hand-seconds <n>",
          ),
    ],
    extra: [
      {
        png: overlay(
          lowerThirdHtml(
            "Dell: the partner must be first to submit the deal.",
            "Dell Deal Registration Terms, 2025",
          ),
        ),
        from: rulesAt,
        to: rulesMid - 0.05,
      },
      {
        png: overlay(
          lowerThirdHtml("Microsoft: five days to answer a referral.", "Microsoft, SMB referrals, Nov 2026"),
        ),
        from: rulesMid,
        to: 17.85,
      },
    ],
    captions: [
      { first: /^I'm Rabin/, at: 0.15, to: 4.9 },
      { first: /^Big companies/, at: 5.1, to: typed - 0.05 },
      { first: /^By hand/, at: typed, to: 17.85 },
    ],
  });

  // 3. The forward: the phone, the replay at real speed in silence, the receipt. The silence lasts what the replay
  // lasts: only the rep's wait at the commit gate is cut, and the HUD's clock stops for it too.
  const use = takeIn(sessions, "use");
  const usePieces: Piece[] = [];
  let silent = 4;
  const receiptFor = 4;
  if (use) {
    const m = msgs(use.a);
    const approve = m.find((x) => x.dir === "in" && x.kind === "button");
    const from = (use.a.readyAt ?? use.a.startedAt) - 500;
    const run = mainRun(use.a);
    const clip = run ? clipOfRun(use.s, run.id) : undefined;
    let replay: Piece | null = null;
    if (clip) {
      const commit = use.a.events.gates.find((g) => g.kind === "commit");
      const end = sec(clip, clip.end);
      const held = commit ? sec(clip, commit.at) + 0.2 : end;
      const on = commit?.resolvedAt ? sec(clip, commit.resolvedAt) : held;
      const done = Math.min(end, on + 0.7);
      // The first frames are the blank page before it paints: a white flash in a dark film.
      const paint = (await activeRanges(clip.file, 0, 1.5, { threshold: 4, pad: 0 }))[0]?.[0] ?? 0;
      const ranges: [number, number][] =
        on > held
          ? [
              [paint, held],
              [on, done],
            ]
          : [[paint, done]];
      silent = onFrame(span(ranges));
      replay = { kind: "video", file: clip.file, ranges, fit: "browser", target: silent, speed: 1 };
    }
    const toApprove = (approve?.at ?? from + 4000) + 800;
    usePieces.push(await phonePiece(use.s, from, toApprove, onFrame(24 - silent - receiptFor)));
    usePieces.push(replay ?? slate("Replay", "at 1×", silent, "placeholder"));
    const receipt = m.find((x) => x.dir === "out" && x.kind === "image" && /Replay ·|Replayed/.test(x.text));
    usePieces.push(
      receipt
        ? await phonePiece(use.s, receipt.at - 500, receipt.at + 3500, receiptFor, true)
        : slate("Receipt", "", receiptFor, "placeholder"),
    );
  } else usePieces.push(slate("Use", "use take missing", 24, "placeholder"));
  const replayAt = onFrame(24 - silent - receiptFor);
  beats.push({
    n: 3,
    name: "the forward",
    dur: 24,
    pieces: usePieces,
    captions: [
      { first: /^So I built/, at: 0.15, to: replayAt - 0.1 },
      { first: /^Done/, at: replayAt + silent, to: 21.85 },
    ],
  });

  // 4. How it learned: the recording in, the teach card, the first run (sped up, labeled), the code.
  const teach = takeIn(sessions, "teach");
  const teachPieces: Piece[] = [];
  if (teach) {
    const m = msgs(teach.a);
    const card = m.find((x) => x.dir === "out" && x.kind === "interactive" && /^I learned/.test(x.text));
    const tapped = card ? m.find((x) => x.dir === "in" && x.kind === "button" && x.at > card.at) : undefined;
    const from = (teach.a.readyAt ?? teach.a.startedAt) - 500;
    teachPieces.push(await phonePiece(teach.s, from, (tapped?.at ?? from + 8000) + 1500, 6));
    // what Muse Wonder drafted from the recording (the recorder's teach view, focus mode)
    teachPieces.push(cameraPiece(teach.s, "__teach", 5, { still: true }));
    const run = mainRun(teach.a);
    const clip = run ? clipOfRun(teach.s, run.id) : undefined;
    teachPieces.push(
      clip && run
        ? await runPiece(teach.s, run.id, clip, 9)
        : slate("First run", "computer use", 9, "placeholder"),
    );
    teachPieces.push(cameraPiece(teach.s, "code-v1", 8, { fit: "code" }));
  } else teachPieces.push(slate("Teach", "teach take missing", 28, "placeholder"));
  beats.push({
    n: 4,
    name: "how it learned",
    dur: 28,
    pieces: teachPieces,
    captions: [
      { first: /^How did it learn/, at: 0.15, to: 10.9 },
      { first: /^Muse Spark's computer use/, at: 11, to: 19.9 },
      { first: /^That one run/, at: 20, to: 27.85 },
    ],
  });

  // 5. Three in the morning: the real lock screen, the race (the recorded script dies on the left, Dockhand repairs
  // on the right), the pick at 0.25x, the lemon card: the line lands on it, then 2 s with nothing over it.
  const LOCK = 6;
  const RACE = 11;
  const PICK = 11.2;
  const CARD = 3.8;
  const hook = opt("--hook") ?? join(first.dir, "phone", "hook.mp4");
  const lock: Piece = existsSync(hook)
    ? await clipPiece(hook, LOCK, "phone")
    : slate(
        "Lock screen, 3 AM",
        "the real drift-watch notification",
        LOCK,
        "placeholder: Rabin's lock-screen footage goes here",
      );
  const hero = takeIn(sessions, "hero");
  const heroRun = hero && mainRun(hero.a);
  const heroClip = hero && heroRun ? clipOfRun(hero.s, heroRun.id) : undefined;
  // The recorded script's real run (scripts/video/race.ts): its stderr lines with run-relative times.
  const raceFile = opt("--race") ?? join(first.dir, "race", "race.json");
  if (!existsSync(raceFile)) notFinal.push(`no race output at ${raceFile}`);
  const race = existsSync(raceFile)
    ? (JSON.parse(readFileSync(raceFile, "utf8")) as {
        lines?: { t: number; text: string; stream?: string }[];
        timeoutMs?: number;
        errorName?: string;
        run?: { ms: number };
      })
    : null;
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
  const title = race ? "Recorded script" : "Recorded script (placeholder)";
  const foot = `${timeoutS} s timeout for the video (default 30 s)`;
  const left: { png: string; dur: number }[] = [];
  for (let k = 0; k < Math.floor(failAt); k++)
    left.push({
      png: overlay(terminalHtml({ title, status: `running, ${k} s`, lines: [], foot }), true),
      dur: 1,
    });
  left.push({
    png: overlay(terminalHtml({ title, status: `running, ${Math.floor(failAt)} s`, lines: [], foot }), true),
    dur: failAt - Math.floor(failAt),
  });
  left.push({
    png: overlay(
      terminalHtml({
        title,
        status: `stopped at ${failAt.toFixed(1)} s`,
        lines: race
          ? realLines.map((l, i) => ({ text: l.text, error: i === 0 }))
          : [{ text: "TimeoutError (placeholder until race.ts writes race/race.json)", error: true }],
        foot,
      }),
      true,
    ),
    dur: RACE - failAt,
  });
  const nightPieces: Piece[] = [lock];
  if (hero && heroRun && heroClip) {
    const { push: _push, ...right } = await runPiece(hero.s, heroRun.id, heroClip, RACE);
    nightPieces.push({ kind: "split", left, right, target: RACE });
    const heal = healOf(hero.s, heroRun.id);
    if (heal) {
      // The step Muse Spark Open repaired: its spotlight comes up, the model's wait is cut, the pick and its
      // reason land and hold. Whole frame: the status panel top right, the picked element low on the page, so the
      // caption goes top left.
      const from = sec(heroClip, heal.start);
      const to = sec(heroClip, heal.end);
      nightPieces.push({
        kind: "video",
        file: heroClip.file,
        ranges: [
          [Math.max(0, from - 0.5), from],
          [to - 0.1, Math.min(sec(heroClip, heroClip.end), to + 2.2)],
        ],
        fit: "browser",
        target: PICK,
        speed: 0.25,
        labels: ["Replay 0.25×"],
        caption: "top",
      });
    } else nightPieces.push(slate("Replay 0.25×", "no open-weights heal in this take", PICK, "placeholder"));
  } else nightPieces.push(slate("The race", "hero take missing", RACE + PICK, "placeholder"));
  nightPieces.push(await overnightCard(CARD));
  const pickAt = LOCK + RACE;
  const cardAt = pickAt + PICK;
  beats.push({
    n: 5,
    name: "three in the morning",
    dur: 32,
    pieces: nightPieces,
    // "Portals change", sourced, beside the lock screen.
    extra: [
      {
        png: overlay(
          lowerThirdHtml(
            "SAP Ariba redesigned a supplier profile screen.",
            "SAP Ariba release 2602, Feb 2026",
            { beside: "phone" },
          ),
        ),
        from: 1,
        to: LOCK - 0.1,
      },
    ],
    captions: [
      { first: /^Here's what kills/, at: 0.15, to: LOCK - 0.1 },
      { first: /^A recorded script/, at: LOCK + 0.1, to: LOCK + 5.3 },
      { first: /^Dockhand repairs/, at: LOCK + 5.4, to: pickAt - 0.1 },
      { first: /^then Meta's/, at: pickAt, to: cardAt - 0.1 },
      { first: /^You wake up/, at: cardAt, to: 30 },
    ],
  });

  // 6. The rest of the day: EspoCRM, the supplier form, the ask, HubSpot.
  const espo = takeIn(sessions, "espocrm");
  const dayPieces: Piece[] = [
    slate("EspoCRM, open source, unmodified", "Its own admin renames two fields and reorders the form", 2.5),
  ];
  if (espo) {
    const run = mainRun(espo.a);
    const clip = run ? clipOfRun(espo.s, run.id) : undefined;
    const heal = clip && run ? healOf(espo.s, run.id) : null;
    dayPieces.push(
      clip && run
        ? {
            ...(await runPiece(espo.s, run.id, clip, 4, {
              ...(heal ? { from: sec(clip, heal.start) - 2, to: sec(clip, heal.end) + 1.6 } : {}),
            })),
            // pushed in, the repair card reaches down to where a bottom caption lands
            caption: "top" as const,
          }
        : slate("EspoCRM", "run missing", 4, "placeholder"),
    );
    dayPieces.push(cameraPiece(espo.s, "pick-espocrm", 3.5, { still: true }));
  } else dayPieces.push(slate("EspoCRM", "EspoCRM take missing", 7.5, "placeholder"));
  const supplier = takeIn(sessions, "supplier") ?? takeIn(sessions, "supplier2");
  const supplierRun = supplier && mainRun(supplier.a);
  const supplierClip = supplier && supplierRun ? clipOfRun(supplier.s, supplierRun.id) : undefined;
  if (supplier && supplierRun && supplierClip) {
    const commit = supplier.a.events.gates.find((g) => g.kind === "commit");
    dayPieces.push(
      await runPiece(supplier.s, supplierRun.id, supplierClip, 5, {
        ...(commit ? { to: sec(supplierClip, commit.at) } : {}),
      }),
    );
  } else dayPieces.push(slate("Supplier form", "supplier take missing", 5, "placeholder"));
  const ask = takeIn(sessions, "ask");
  const q = ask?.a.events.gates.find((g) => g.kind === "question");
  dayPieces.push(
    ask && q
      ? await phonePiece(ask.s, q.at - 300, (q.resolvedAt ?? q.at + 3000) + 1500, 4.5)
      : slate("Ask", "ask take missing", 4.5, "placeholder"),
  );
  const hubspot = opt("--hubspot");
  dayPieces.push(
    hubspot
      ? await clipPiece(hubspot, 4.5, "camera")
      : slate(
          "HubSpot",
          "the deal and the quote, through its API",
          4.5,
          "placeholder: a 4.5 s capture of the HubSpot deal",
        ),
  );
  beats.push({
    n: 6,
    name: "the rest of the day",
    dur: 24,
    pieces: dayPieces,
    captions: [
      { first: /^It works on real software/, at: 0.15, to: 2.4 },
      { first: /^This is EspoCRM/, at: 2.5, to: 6.4 },
      { first: /^I renamed a field/, at: 6.5, to: 9.9 },
      { first: /^A forty-field/, at: 10, to: 14.9 },
      { first: /^When a form/, at: 15, to: 19.4 },
      { first: /^And where a tool/, at: 19.5, to: 23.85 },
    ],
  });

  // 7. Proof: the baseline with its required footnote, the heal rungs, the cost curve.
  const assets = join(root, "assets", "video");
  const lead = CHART_LEAD;
  beats.push({
    n: 7,
    name: "proof",
    dur: 26,
    pieces: [
      await chartPiece(join(assets, "chart-baseline.mp4"), 8),
      await chartPiece(join(assets, "chart-heals.mp4"), 9),
      await chartPiece(join(assets, "chart-cost.mp4"), 9),
    ],
    extra: [
      {
        png: overlay(
          footnoteHtml(
            "One selector per step, like a typical recording; with five stored selectors per step it broke on 9 of 42",
          ),
        ),
        from: 0,
        to: 8,
      },
    ],
    captions: [
      { first: /recorded script broke/, at: lead, to: 7.9 },
      { first: /^Dockhand handled/, at: 8 + lead, to: 17.9 },
      { first: /^Over 93 runs/, at: 18 + lead, to: 27.85 },
    ],
  });

  // 8. End card: the credits (real and simulated) under the voice, then the hard cut to lemon on "Dockhand:". The
  // card says that sentence itself, and no caption covers the compliance lines.
  beats.push({
    n: 8,
    name: "end",
    dur: 16,
    pieces: await endPieces(join(assets, "endcard.mp4"), 10.5, 5.5),
    captions: [{ first: /^Next/, at: 0.15, to: 10.4 }],
    captionsStop: /^Dockhand:/,
  });
  return beats;
}

// ---------- render ----------

/** The band under the race; otherwise bottom unless the piece on screen says where. */
function placeAt(b: Beat, t: number): CaptionPos {
  let start = 0;
  for (const p of b.pieces) {
    if (t < start + p.target) {
      if (p.kind === "split") return "band";
      return (p.kind === "video" && p.caption) || "bottom";
    }
    start += p.target;
  }
  return "bottom";
}

const beats = await buildBeats();
const filmLength = beats.reduce((s, b) => s + b.dur, 0);
if (filmLength !== 180) throw new Error(`the beats last ${filmLength} s, the film 180 s`);

// The voiceover: where each clip lands, and how long it really is.
interface VoClip {
  file: string;
  /** Seconds into the film. */
  at: number;
  /** Seconds into the file where the voice starts: its lead-in silence is skipped. */
  from: number;
  /** Seconds on film it plays: up to the next silence the picture holds, or the beat's end. */
  slot: number;
  /** Above 1 when the line runs a little past its room: played that much faster, the pitch kept, rather than cut. */
  tempo: number;
}
const VO_EXT = ["wav", "m4a", "mp3", "aac", "ogg", "flac"];
/** The most a line is sped up to fit; past it, the line is recorded again. */
const VO_MAX_TEMPO = 1.07;
/** The breath between two parts of a line when the first runs past the second's cue. */
const VO_BREATH = 0.15;
const voDir = opt("--vo");
const vo: VoClip[] = [];
/** Per beat, the caption groups a clip covers alone: they start and end with the voice. */
const voStarts = new Map<number, Map<number, number>>();
const voEnds = new Map<number, Map<number, number>>();
if (!voDir) notFinal.push("no voiceover: --vo <dir>");
{
  let beatAt = 0;
  for (const b of beats) {
    const groups = b.captions ?? [{ first: /./, at: 0.15, to: b.dur - 0.15 }];
    const group = (k: number) => groups[k] as CaptionGroup;
    const from = b.voFrom ?? 0;
    const find = (name: string) =>
      voDir ? VO_EXT.map((e) => join(voDir, `${name}.${e}`)).find((f) => existsSync(f)) : undefined;
    const whole = find(`beat${b.n}`);
    const parts = groups.flatMap((_, k) => {
      const f = k >= from ? find(`beat${b.n}-${k + 1}`) : undefined;
      return f ? [{ file: f, group: k }] : [];
    });
    if (whole && parts.length)
      throw new Error(`--vo: beat ${b.n} has both beat${b.n} and beat${b.n}-<k> clips`);
    const placed = whole ? [{ file: whole, group: from }] : parts;
    if (voDir && !placed.length) notFinal.push(`--vo: no voiceover for beat ${b.n}`);
    // A whole clip would talk through the line's silence (beat 3's replay): it has to come in parts.
    if (whole)
      for (let k = from; k + 1 < groups.length; k++)
        if (group(k + 1).at - group(k).to > 1.5)
          notFinal.push(
            `--vo: beat ${b.n} has a silence before group ${k + 2}; split it into beat${b.n}-<k> clips`,
          );
    const speech = await Promise.all(placed.map((c) => speechOf(c.file)));
    // Parts run in chains. Each comes in on its cue, or a breath after the one before when that runs long; a chain
    // ends at a silence the picture holds (a gap of over 1.5 s between groups), or at the beat's end.
    const chains: number[][] = [];
    for (const [j, c] of placed.entries()) {
      const prev = placed[j - 1];
      if (prev && group(c.group).at - group(prev.group).to <= 1.5) chains.at(-1)?.push(j);
      else chains.push([j]);
    }
    const starts = new Map<number, number>();
    const ends = new Map<number, number>();
    for (const [ci, chain] of chains.entries()) {
      const lastGroup = group((placed[chain.at(-1) as number] as { group: number }).group);
      const limit = chains[ci + 1] ? lastGroup.to : b.dur - 0.05;
      const lay = (tempo: number) => {
        let end = Number.NEGATIVE_INFINITY;
        return chain.map((j) => {
          const s = speech[j] as { from: number; to: number };
          const at = Math.max(group((placed[j] as { group: number }).group).at, end + VO_BREATH);
          end = at + (s.to - s.from) / tempo;
          return { j, at, end };
        });
      };
      const over = (tempo: number) => (lay(tempo).at(-1)?.end ?? 0) - limit;
      let tempo = 1;
      if (over(1) > 0) {
        if (over(VO_MAX_TEMPO) > 0) {
          tempo = VO_MAX_TEMPO;
          notFinal.push(
            `--vo: beat ${b.n} runs ${over(tempo).toFixed(1)} s past its room even ${VO_MAX_TEMPO}x faster: record ${chain.map((j) => relative(root, (placed[j] as { file: string }).file)).join(", ")} shorter`,
          );
        } else {
          let lo = 1;
          let hi = VO_MAX_TEMPO;
          for (let k = 0; k < 24; k++) {
            const mid = (lo + hi) / 2;
            if (over(mid) > 0) lo = mid;
            else hi = mid;
          }
          tempo = hi;
          say(`--vo: beat ${b.n} plays ${tempo.toFixed(3)}x to fit`);
        }
      }
      for (const { j, at, end } of lay(tempo)) {
        const c = placed[j] as { file: string; group: number };
        const until = Math.min(end, limit);
        vo.push({
          file: c.file,
          at: beatAt + at,
          from: (speech[j] as { from: number }).from,
          slot: until - at,
          tempo,
        });
        // A part, or a whole clip for a single group, sets that group's captions to the voice.
        if (!whole || groups.length - from === 1) {
          starts.set(c.group, at);
          ends.set(c.group, until);
        }
      }
    }
    voStarts.set(b.n, starts);
    voEnds.set(b.n, ends);
    beatAt += b.dur;
  }
  // A draft shows what the voice still needs at once: which clip to record again, not only a refusal at --final.
  for (const m of new Set(notFinal)) if (m.startsWith("--vo:")) say(m);
}
// captions: each beat's line in chunks of at most two lines, timed by words
/** Chunks spread over [from, to] by their words; a word or two still stays up long enough to read. */
function timed(b: Beat, chunks: string[], from: number, to: number) {
  const words = chunks.map((c) => Math.max(3, c.split(/\s+/).length));
  const total = words.reduce((x, y) => x + y, 0) || 1;
  let at = from;
  return chunks.map((c, i) => {
    const d = ((to - from) * (words[i] as number)) / total;
    const item = { png: overlay(captionHtml(c, placeAt(b, at + d / 2))), from: at, to: at + d };
    at += d;
    return item;
  });
}

const captionPlan = beats.map((b) => {
  const all = captionChunks(lineOf(b.n));
  const stop = b.captionsStop ? all.findIndex((c) => b.captionsStop?.test(c)) : -1;
  const chunks = stop < 0 ? all : all.slice(0, stop);
  const groups = b.captions ?? [{ first: /./, at: 0.15, to: b.dur - 0.15 }];
  // A line that lost its anchor must stop the render: left to the word count, it would caption a silence.
  const starts = groups.map((g) => {
    const i = chunks.findIndex((c) => g.first.test(c));
    if (i < 0) throw new Error(`beat ${b.n}: no caption matches ${g.first} in "${lineOf(b.n)}"`);
    return i;
  });
  return groups.flatMap((g, i) =>
    timed(
      b,
      chunks.slice(starts[i] as number, starts[i + 1] ?? chunks.length),
      voStarts.get(b.n)?.get(i) ?? g.at,
      voEnds.get(b.n)?.get(i) ?? g.to,
    ),
  );
});
for (const b of beats) for (const p of b.pieces) for (const l of labelsOf(p)) label(l.text, l.slot);
if (args.includes("--final") && notFinal.length > 0)
  throw new Error(`not the film yet:\n  ${[...new Set(notFinal)].join("\n  ")}`);
say(`rendering ${overlays.length} overlays (Mona Sans, headless Chromium)`);
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
  // Even frame times: the seams between pieces can repeat a timestamp, and the encoder would drop that frame.
  let graph = `[0:v]setpts=N/${FPS}/TB[even]`;
  let last = "even";
  items.forEach((it, k) => {
    inputs.push("-loop", "1", "-i", it.png);
    graph += `;[${last}][${k + 1}:v]overlay=0:0:shortest=1:enable='between(t,${it.from.toFixed(2)},${it.to.toFixed(2)})'[c${k}]`;
    last = `c${k}`;
  });
  const out = join(work, `beat${b.n}.mp4`);
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
  beatFiles.push(out);
}

const filmList = join(work, "film.txt");
writeFileSync(filmList, `${beatFiles.map((f) => `file '${f.replace(/\\/g, "/")}'`).join("\n")}\n`);
const picture = join(work, "film-picture.mp4");
await ffmpeg(["-f", "concat", "-safe", "0", "-i", filmList, "-c", "copy", picture]);

// The sound: silence for the whole film, with the real sound of the pieces that keep theirs laid in at their times.
const sounds: (Sound & { at: number; dur: number })[] = [];
let filmAt = 0;
for (const b of beats)
  for (const p of b.pieces) {
    if (p.kind !== "split" && p.sound) sounds.push({ ...p.sound, at: filmAt, dur: p.target });
    filmAt += p.target;
  }
const soundInputs = [...sounds, ...vo].flatMap((s) => ["-i", s.file]);
const soundChains = sounds.map(
  (s, i) =>
    `[${i + 2}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:${s.dur.toFixed(3)},asetpts=PTS-STARTPTS,` +
    `afade=t=out:st=${Math.max(0, s.dur - 0.15).toFixed(3)}:d=0.15,volume=${s.gain},` +
    `adelay=delays=${Math.round(s.at * 1000)}:all=1[s${i}]`,
);
// The voice: one channel, rumble cut, leveled so the two channels together sit near -16 LUFS, then both sides.
const voChains = vo.map(
  (v, j) =>
    `[${sounds.length + j + 2}:a]aresample=48000,aformat=channel_layouts=mono,highpass=f=80,` +
    `loudnorm=I=-19:TP=-2:LRA=11,aresample=48000,pan=stereo|c0=c0|c1=c0,` +
    `atrim=start=${v.from.toFixed(3)}:end=${(v.from + v.slot * v.tempo).toFixed(3)},asetpts=PTS-STARTPTS,` +
    `atempo=${v.tempo.toFixed(4)},afade=t=out:st=${Math.max(0, v.slot - 0.1).toFixed(3)}:d=0.1,` +
    `adelay=delays=${Math.round(v.at * 1000)}:all=1[v${j}]`,
);
const labelsIn = [...sounds.map((_, i) => `[s${i}]`), ...vo.map((_, j) => `[v${j}]`)];
const mix = `[1:a]${labelsIn.join("")}amix=inputs=${labelsIn.length + 1}:normalize=0:duration=first,alimiter=limit=0.95:level=0[a]`;
const film = join(outDir, "rough-cut-v2.mp4");
rmSync(film, { force: true });
await ffmpeg([
  "-i",
  picture,
  "-f",
  "lavfi",
  "-t",
  String(filmLength),
  "-i",
  "anullsrc=r=48000:cl=stereo",
  ...soundInputs,
  "-filter_complex",
  [...soundChains, ...voChains, mix].join(";"),
  "-map",
  "0:v",
  "-map",
  "[a]",
  "-c:v",
  "copy",
  "-c:a",
  "aac",
  "-b:a",
  "192k",
  "-t",
  String(filmLength),
  "-movflags",
  "+faststart",
  film,
]);
const sheet = join(outDir, "contact-sheet.png");
await ffmpeg([
  "-i",
  film,
  "-vf",
  `fps=1/5,scale=384:-1,tile=6x6:padding=8:margin=8:color=${GROUND}`,
  "-frames:v",
  "1",
  sheet,
]);
const p = await probe(film);
// Counted, not read from the container: a dropped frame leaves its duration at 180.00.
const frames = await countFrames(film);
if (frames !== filmLength * FPS) throw new Error(`the film has ${frames} frames, not ${filmLength * FPS}`);
say(
  `rough cut v2: ${relative(root, film)} (${p.duration.toFixed(2)} s, ${frames} frames); contact sheet: ${relative(root, sheet)}`,
);

// `pnpm video:cut`: cuts a recorded session into per-take clips and a rough cut, with ffmpeg only.
//
// Per take (its last good attempt, 1 s before it was ready to 2 s after its last message): a 1920x1080 split
// screen, the phone on the left (the real recording placed by phone-sync.json; in a rehearsal the filmed
// emulator chat, labeled "Simulated chat (rehearsal)"), the browser filmed inside Chromium on the right (the
// newest page at each moment), and the wall clock. Computer-use stretches are sped up and labeled on screen.
// The rough cut strings the takes in the storyboard's shot order with the title, charts and end card.
//
//   pnpm video:cut --session rh-cassette-1            all takes + rough cut into <session>/cuts/
//   pnpm video:cut --session ... --only hero          one take

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { type ClipInfo, encodeClip, readClipInfo } from "../../packages/browser/src/index.ts";
import { workspaceRoot } from "../../packages/core/src/index.ts";
import { FONT, FONT_BOLD, ffmpeg, probe, stageFonts } from "./lib/media.ts";
import type { Attempt, CutList } from "./session.ts";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const root = workspaceRoot();
const session = opt("--session");
if (!session) throw new Error("--session <name> is required");
const only = opt("--only")?.split(",");
const sessionDir = join(root, "var", "recordings", session);
const cutsDir = join(sessionDir, "cuts");
const work = join(cutsDir, "work");
mkdirSync(work, { recursive: true });
stageFonts(work);
const cut = JSON.parse(readFileSync(join(sessionDir, "cutlist.json"), "utf8")) as CutList;
const FPS = 30;
const BG = "0x0e1116";
const t0 = Date.now();
const say = (s: string) =>
  process.stdout.write(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s] ${s}\n`);

// ---------- sources ----------

interface Clip {
  folder: string;
  file: string;
  start: number;
  end: number;
  info: ClipInfo;
}

async function clipsIn(dir: string): Promise<Clip[]> {
  if (!existsSync(dir)) return [];
  const out: Clip[] = [];
  for (const name of readdirSync(dir)) {
    const folder = join(dir, name);
    const info = readClipInfo(folder);
    if (!info?.startedAt || !info.endedAt) continue;
    const file = join(folder, "clip.mkv");
    if (!existsSync(file)) await encodeClip(folder).catch(() => null);
    if (existsSync(file)) out.push({ folder, file, start: info.startedAt, end: info.endedAt, info });
  }
  return out.sort((a, b) => a.start - b.start);
}

const browserClips = await clipsIn(join(sessionDir, "clips"));
const cameraClips = await clipsIn(join(sessionDir, "camera"));

/** The phone track: the real recording (placed by phone sync), else the rehearsal's filmed emulator chat. */
async function phoneSource(): Promise<{ file: string; start: number; simulated: boolean } | null> {
  const syncPath = join(sessionDir, "phone-sync.json");
  if (existsSync(syncPath)) {
    const s = JSON.parse(readFileSync(syncPath, "utf8")) as {
      file: string;
      startAt: number;
      confidence: string;
    };
    if (s.confidence === "low") say("phone sync confidence is LOW: check the phone track's timing by eye");
    return { file: join(root, s.file), start: s.startAt, simulated: false };
  }
  if (cut.phoneSim?.startedAt) {
    const folder = join(root, cut.phoneSim.folder);
    if (!existsSync(join(folder, "clip.mkv"))) await encodeClip(folder);
    return { file: join(folder, "clip.mkv"), start: cut.phoneSim.startedAt, simulated: true };
  }
  return null;
}
const phone = await phoneSource();

// ---------- helpers ----------

const secs = (ms: number) => (ms / 1000).toFixed(3);
const frames = (ms: number) => Math.max(1, Math.round((ms / 1000) * FPS));
let textN = 0;
/** drawtext reads its text from a file (no filtergraph escaping); returns the option for it. */
function textFile(s: string): string {
  const name = `t${++textN}.txt`;
  writeFileSync(join(work, name), s);
  return `textfile=${name}`;
}
const x264 = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "-pix_fmt", "yuv420p", "-an"];

/** The browser track for [w0, w1]: at each moment the newest page that was open; a slate where none was. */
async function browserTrack(w0: number, w1: number, tag: string): Promise<string> {
  const cuts = new Set<number>([w0, w1]);
  for (const c of browserClips) {
    if (c.end <= w0 || c.start >= w1) continue;
    cuts.add(Math.max(w0, c.start));
    cuts.add(Math.min(w1, c.end));
  }
  const times = [...cuts].sort((a, b) => a - b);
  const plan: { clip: Clip | null; a: number; b: number }[] = [];
  for (let i = 0; i + 1 < times.length; i++) {
    const a = times[i] as number;
    const b = times[i + 1] as number;
    if (b - a < 1) continue;
    const covering = browserClips.filter((c) => c.start <= a && c.end >= b);
    const clip = covering.sort((x, y) => y.start - x.start)[0] ?? null;
    const last = plan.at(-1);
    if (last && last.clip === clip) last.b = b;
    else plan.push({ clip, a, b });
  }
  const list: string[] = [];
  for (const [i, seg] of plan.entries()) {
    const out = `${tag}-b${i}.mp4`;
    const n = frames(seg.b - seg.a);
    if (seg.clip) {
      await ffmpeg(
        [
          "-ss",
          secs(seg.a - seg.clip.start),
          "-i",
          seg.clip.file,
          "-vf",
          `scale=1280:800:force_original_aspect_ratio=decrease,pad=1280:800:(ow-iw)/2:(oh-ih)/2:color=${BG},fps=${FPS},format=yuv420p`,
          "-frames:v",
          String(n),
          ...x264,
          out,
        ],
        work,
      );
    } else {
      await ffmpeg(
        [
          "-f",
          "lavfi",
          "-i",
          `color=c=0x141922:s=1280x800:r=${FPS}`,
          "-vf",
          `drawtext=fontfile=${FONT}:${textFile("Dockhand is reading the message or waiting for the rep")}:fontcolor=0x8b95a5:fontsize=26:x=(w-tw)/2:y=(h-th)/2`,
          "-frames:v",
          String(n),
          ...x264,
          out,
        ],
        work,
      );
    }
    list.push(`file '${out}'`);
  }
  const listFile = `${tag}-browser.txt`;
  writeFileSync(join(work, listFile), `${list.join("\n")}\n`);
  const track = `${tag}-browser.mp4`;
  await ffmpeg(["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", track], work);
  return track;
}

/** One take as a real-time split screen, then its computer-use stretches sped up and labeled. */
async function cutTake(a: Attempt): Promise<string | null> {
  if (!a.readyAt || !a.doneAt) return null;
  const w0 = a.readyAt - 1000;
  const w1 = a.doneAt + 2000;
  const dur = w1 - w0;
  const tag = `${a.id}-${a.attempt}`;
  say(`take ${a.id} #${a.attempt}: ${(dur / 1000).toFixed(1)} s real time`);
  const browser = await browserTrack(w0, w1, tag);
  const inputs = ["-f", "lavfi", "-i", `color=c=${BG}:s=1920x1080:r=${FPS}`, "-i", browser];
  let phoneChain = "";
  if (phone) {
    const off = (w0 - phone.start) / 1000;
    inputs.push(...(off > 0 ? ["-ss", off.toFixed(3)] : []), "-i", phone.file);
    const pad = off < 0 ? `tpad=start_duration=${(-off).toFixed(3)}:color=${BG},` : "";
    phoneChain = `[2:v]${pad}scale=-2:960,fps=${FPS},tpad=stop_mode=clone:stop_duration=${secs(dur)}[ph];[bgb][ph]overlay=x=60:y=92:eof_action=pass[bgp];`;
  }
  const phoneLabel = phone
    ? phone.simulated
      ? "Simulated chat (rehearsal): the emulator stands in for the phone"
      : "Rabin's phone: WhatsApp, real time"
    : "";
  const clock = `%{pts:localtime:${(w0 / 1000).toFixed(3)}:%H\\:%M\\:%S}`;
  const graph = [
    `[1:v]fps=${FPS}[br]`,
    `[0:v][br]overlay=x=580:y=152:eof_action=pass[bgb]`,
    phone ? phoneChain.replace(/;$/, "") : "[bgb]null[bgp]",
    `[bgp]drawtext=fontfile=${FONT}:${textFile(phoneLabel)}:fontcolor=0x8b95a5:fontsize=24:x=60:y=50,` +
      `drawtext=fontfile=${FONT}:${textFile("Dockhand's browser, filmed inside Chromium")}:fontcolor=0x8b95a5:fontsize=24:x=580:y=110,` +
      `drawtext=fontfile=${FONT_BOLD}:${textFile(clock)}:fontcolor=0xe8ecf2:fontsize=30:x=w-tw-60:y=44[out]`,
  ].join(";");
  const rt = `${tag}-rt.mp4`;
  await ffmpeg(
    [...inputs, "-filter_complex", graph, "-map", "[out]", "-frames:v", String(frames(dur)), ...x264, rt],
    work,
  );

  // Speed-ups: computer use at 8x / 16x, labeled for as long as they run.
  const regions = (a.speed ?? [])
    .map((r) => ({ from: (r.fromAt - w0) / 1000, to: (r.toAt - w0) / 1000, factor: r.factor }))
    .filter((r) => r.to - r.from > 2)
    .sort((x, y) => x.from - y.from);
  const final = join(cutsDir, `take-${a.id}.mp4`);
  if (regions.length === 0) {
    rmSync(final, { force: true });
    await ffmpeg(["-i", rt, "-c", "copy", final], work);
    return final;
  }
  const parts: string[] = [];
  let at = 0;
  const total = dur / 1000;
  const piece = async (from: number, to: number, factor: number) => {
    if (to - from < 0.05) return;
    const out = `${tag}-p${parts.length}.mp4`;
    const vf =
      factor === 1
        ? `fps=${FPS}`
        : `setpts=(PTS-STARTPTS)/${factor},fps=${FPS},drawtext=fontfile=${FONT_BOLD}:${textFile(`${factor}× speed`)}:fontcolor=0x0b0d12:box=1:boxcolor=0xfbbf24:boxborderw=12:fontsize=34:x=(w-tw)/2:y=40`;
    await ffmpeg(
      ["-ss", from.toFixed(3), "-t", (to - from).toFixed(3), "-i", rt, "-vf", vf, ...x264, out],
      work,
    );
    parts.push(`file '${out}'`);
  };
  for (const r of regions) {
    await piece(at, r.from, 1);
    await piece(r.from, r.to, r.factor);
    at = r.to;
  }
  await piece(at, total, 1);
  writeFileSync(join(work, `${tag}-parts.txt`), `${parts.join("\n")}\n`);
  await ffmpeg(["-f", "concat", "-safe", "0", "-i", `${tag}-parts.txt`, "-c", "copy", final], work);
  return final;
}

/** Any video to 1920x1080 / 30 fps / x264 (camera clips, the title and chart assets). */
async function normalize(src: string, name: string, maxSeconds?: number): Promise<string> {
  const out = join(work, name);
  await ffmpeg(
    [
      "-i",
      src,
      ...(maxSeconds ? ["-t", String(maxSeconds)] : []),
      "-vf",
      `scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=${BG},fps=${FPS},format=yuv420p`,
      ...x264,
      out,
    ],
    work,
  );
  return out;
}

async function slate(text: string, sub: string, seconds: number, name: string): Promise<string> {
  const out = join(work, name);
  await ffmpeg(
    [
      "-f",
      "lavfi",
      "-i",
      `color=c=${BG}:s=1920x1080:r=${FPS}`,
      "-vf",
      `drawtext=fontfile=${FONT_BOLD}:${textFile(text)}:fontcolor=0xe8ecf2:fontsize=64:x=(w-tw)/2:y=(h-th)/2-30,` +
        `drawtext=fontfile=${FONT}:${textFile(sub)}:fontcolor=0xfbbf24:fontsize=30:x=(w-tw)/2:y=(h/2)+50`,
      "-frames:v",
      String(Math.round(seconds * FPS)),
      ...x264,
      out,
    ],
    work,
  );
  return out;
}

// ---------- main ----------

const finals = new Map<string, Attempt>();
for (const t of cut.takes) if (t.status === "done") finals.set(t.id, t); // the last good attempt wins
const takeFiles = new Map<string, string>();
for (const [id, a] of finals) {
  if (only && !only.includes(id)) continue;
  if (id === "check") continue;
  const f = await cutTake(a);
  if (f) takeFiles.set(id, f);
}
if (takeFiles.has("hero")) {
  const hero = join(cutsDir, "hero-split.mp4");
  rmSync(hero, { force: true });
  await ffmpeg(["-i", takeFiles.get("hero") as string, "-c", "copy", hero]);
}

if (!only) {
  say("rough cut");
  const assets = join(root, "assets", "video");
  const cam = (label: string) => cameraClips.find((c) => c.info.label.endsWith(label))?.file;
  const order: string[] = [];
  const add = async (f: string | undefined, name: string, max?: number) => {
    if (f && existsSync(f)) order.push(await normalize(f, name, max));
  };
  await add(takeFiles.get("hero"), "r01-hero.mp4");
  await add(join(assets, "title.mp4"), "r02-title.mp4");
  await add(takeFiles.get("teach"), "r03-teach.mp4");
  await add(cam("code-v1"), "r04-code-v1.mp4", 25);
  await add(takeFiles.get("use"), "r05-use.mp4");
  if (takeFiles.has("espocrm")) {
    await add(takeFiles.get("espocrm"), "r06-espocrm.mp4");
    await add(cam("pick-espocrm"), "r07-pick.mp4", 14);
  } else await add(cam("pick-hero"), "r07-pick.mp4", 14);
  await add(takeFiles.get("ask"), "r08-ask.mp4");
  await add(cam("code-v3"), "r09-code-v3.mp4", 14);
  if (takeFiles.has("overnight")) {
    order.push(await slate("Skip to 3:00 AM", "time skipped for the video", 2.5, "r10-skip.mp4"));
    await add(takeFiles.get("overnight"), "r11-overnight.mp4");
  }
  await add(takeFiles.get("supplier"), "r12-supplier.mp4");
  await add(takeFiles.get("supplier2"), "r13-supplier2.mp4");
  await add(takeFiles.get("quote"), "r14-quote.mp4");
  await add(join(assets, "chart-cost.mp4"), "r15-chart-cost.mp4");
  await add(join(assets, "chart-heals.mp4"), "r16-chart-heals.mp4");
  await add(join(assets, "endcard.mp4"), "r17-endcard.mp4");
  writeFileSync(
    join(work, "rough.txt"),
    `${order.map((f) => `file '${relative(work, f).replace(/\\/g, "/")}'`).join("\n")}\n`,
  );
  const rough = join(cutsDir, "rough-cut.mp4");
  await ffmpeg(["-f", "concat", "-safe", "0", "-i", "rough.txt", ...x264, rough], work);
  const p = await probe(rough);
  say(`rough cut: ${relative(root, rough)} (${p.duration.toFixed(1)} s)`);
}

const lines = ["| take | real time | in the cut | speed-ups |", "|---|---|---|---|"];
for (const [id, f] of takeFiles) {
  const a = finals.get(id) as Attempt;
  const real = ((a.doneAt as number) + 2000 - ((a.readyAt as number) - 1000)) / 1000;
  const p = await probe(f);
  lines.push(
    `| ${id} | ${real.toFixed(1)} s | ${p.duration.toFixed(1)} s | ${a.speed.map((s) => `${s.factor}x for ${((s.toAt - s.fromAt) / 1000).toFixed(0)} s`).join(", ") || "none"} |`,
  );
}
writeFileSync(join(cutsDir, "timing.md"), `${lines.join("\n")}\n`);
process.stdout.write(`${lines.join("\n")}\ncuts: ${relative(root, cutsDir)}\n`);

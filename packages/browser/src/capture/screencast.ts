// Demo capture (DEMO_CAPTURE_DIR): films a page from inside Chromium. A CDP screencast hands over each frame
// Chromium composites (the HUD overlay included) with its wall-clock time; frames arrive only when the page
// changes. They are written as JPEGs plus an index while the page lives, and encoded afterwards into a constant
// 30 fps clip whose timeline is the wall clock: frame n shows the page at startedAt + n / fps. Nothing here
// changes the viewport, the device scale factor or any screenshot automation takes, and every failure is
// swallowed: a lost frame never breaks a run.

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";

export interface CaptureOptions {
  /** Every capture gets its own folder here: frames/, index.jsonl, clip.json, then clip.mkv once encoded. */
  dir: string;
  /** Output frame rate (default 30). */
  fps?: number;
  /** JPEG quality of the screencast frames (default 92). */
  quality?: number;
  /** Largest frame Chromium sends, in device pixels (default: the page's own size, up to 4096). */
  maxWidth?: number;
  maxHeight?: number;
}

/** The sidecar next to every capture (clip.json). Times are epoch milliseconds. */
export interface ClipInfo {
  label: string;
  /** Wall-clock time of the first frame; null until one arrived. */
  startedAt: number | null;
  /** When the capture stopped; null while it runs (or if the process died: the index still has every frame). */
  endedAt: number | null;
  frames: number;
  /** The page's size in CSS pixels (frames are this times the device scale factor). */
  width: number | null;
  height: number | null;
  fps: number;
  meta: Record<string, unknown>;
}

export interface Capture {
  readonly folder: string;
  /** Stops the screencast and writes the sidecar. Encoding is separate (encodeClip), so this returns at once. */
  stop(): Promise<ClipInfo>;
}

/** DEMO_CAPTURE_DIR=<dir> (with DEMO_MODE on) films every leased page; null otherwise. */
export function captureOptionsFromEnv(
  env: Record<string, string | undefined> = process.env,
): CaptureOptions | null {
  const demo = ["1", "true", "yes", "on"].includes((env.DEMO_MODE ?? "").trim().toLowerCase());
  const dir = (env.DEMO_CAPTURE_DIR ?? "").trim();
  return demo && dir ? { dir } : null;
}

const safe = (s: string) => s.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 80);
const stamp = (ms: number) => new Date(ms).toISOString().replace(/[:.]/g, "-");

/**
 * Starts filming `page`. `label` names the folder (with a timestamp first, so folders sort by start time);
 * `meta` lands in the sidecar (run id, portal).
 */
export async function startScreencast(
  page: Page,
  o: CaptureOptions & { label: string; meta?: Record<string, unknown> },
): Promise<Capture> {
  const fps = o.fps ?? 30;
  const folder = join(o.dir, `${stamp(Date.now())}__${safe(o.label)}`);
  const framesDir = join(folder, "frames");
  mkdirSync(framesDir, { recursive: true });
  const info: ClipInfo = {
    label: o.label,
    startedAt: null,
    endedAt: null,
    frames: 0,
    width: null,
    height: null,
    fps,
    meta: o.meta ?? {},
  };
  const sidecar = () => writeFileSync(join(folder, "clip.json"), `${JSON.stringify(info, null, 2)}\n`);
  sidecar();
  const index = join(folder, "index.jsonl");
  const writes = new Set<Promise<void>>();
  let stopped = false;

  const cdp = await page.context().newCDPSession(page);
  cdp.on("Page.screencastFrame", (e) => {
    // Ack first: Chromium sends the next frame only after the previous one is acknowledged.
    void cdp.send("Page.screencastFrameAck", { sessionId: e.sessionId }).catch(() => {});
    if (stopped) return;
    const at =
      typeof e.metadata.timestamp === "number" ? Math.round(e.metadata.timestamp * 1000) : Date.now();
    const n = ++info.frames;
    if (info.startedAt === null) {
      info.startedAt = at;
      info.width = Math.round(e.metadata.deviceWidth);
      info.height = Math.round(e.metadata.deviceHeight);
      sidecar();
    }
    const file = `${String(n).padStart(6, "0")}.jpg`;
    const w = writeFile(join(framesDir, file), Buffer.from(e.data, "base64"))
      .then(() => appendFileSync(index, `${JSON.stringify({ f: file, t: at })}\n`))
      .catch(() => {});
    writes.add(w);
    void w.finally(() => writes.delete(w));
  });
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: o.quality ?? 92,
    maxWidth: o.maxWidth ?? 4096,
    maxHeight: o.maxHeight ?? 4096,
    everyNthFrame: 1,
  });

  return {
    folder,
    async stop() {
      if (!stopped) {
        stopped = true;
        await cdp.send("Page.stopScreencast").catch(() => {});
        await cdp.detach().catch(() => {});
        await Promise.allSettled([...writes]);
        info.endedAt = Date.now();
        sidecar();
      }
      return { ...info };
    },
  };
}

// ---------- encoding ----------

export interface IndexedFrame {
  f: string;
  t: number;
}

export function readClipInfo(folder: string): ClipInfo | null {
  try {
    return JSON.parse(readFileSync(join(folder, "clip.json"), "utf8")) as ClipInfo;
  } catch {
    return null;
  }
}

/** The frames a capture wrote, in time order (a frame whose write failed is simply not listed). */
export function readIndex(folder: string): IndexedFrame[] {
  const path = join(folder, "index.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as IndexedFrame];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.t - b.t || a.f.localeCompare(b.f));
}

/**
 * The concat-demuxer script for a capture: each frame lasts until the next one arrived, the last one until
 * `endAt`. Times are quantized to whole output frames from the first frame, so the video starts at frame 0 and
 * frame n is wall time first + n / fps (within half a frame).
 */
export function concatScript(frames: IndexedFrame[], endAt: number, fps: number): string {
  return concatPlan(frames, endAt, fps).script;
}

/** concatScript plus the clip's exact length in output frames (the demuxer's last-entry quirk adds some). */
export function concatPlan(
  frames: IndexedFrame[],
  endAt: number,
  fps: number,
): { script: string; totalFrames: number } {
  if (frames.length === 0) return { script: "ffconcat version 1.0\n", totalFrames: 0 };
  const t0 = (frames[0] as IndexedFrame).t;
  const slot = (t: number) => Math.round(((t - t0) / 1000) * fps);
  const lines = ["ffconcat version 1.0"];
  let shown = 0; // output frames written so far
  for (let i = 0; i < frames.length; i++) {
    const fr = frames[i] as IndexedFrame;
    const until =
      i + 1 < frames.length ? slot((frames[i + 1] as IndexedFrame).t) : Math.max(slot(endAt), shown + 1);
    const n = until - shown;
    if (n <= 0) continue; // superseded within the same output frame: the newer frame wins
    lines.push(`file 'frames/${fr.f}'`, `duration ${(n / fps).toFixed(6)}`);
    shown = until;
  }
  // The concat demuxer ignores the last entry's duration unless the file is listed once more (that extra
  // entry then lasts as long again: the encoder stops at totalFrames).
  const lastFile = lines.filter((l) => l.startsWith("file ")).at(-1);
  if (lastFile) lines.push(lastFile);
  return { script: `${lines.join("\n")}\n`, totalFrames: shown };
}

export interface EncodeOptions {
  ffmpegPath?: string;
  /** x264 CRF (default 14: visually lossless for UI text). */
  crf?: number;
  preset?: string;
  /** Output file (default <folder>/clip.mkv). */
  out?: string;
}

/**
 * Encodes a capture folder into a constant-frame-rate H.264 clip (Matroska: still playable if a later step
 * dies). Returns the output path, or null when the capture has no frames.
 */
export async function encodeClip(folder: string, o: EncodeOptions = {}): Promise<string | null> {
  const info = readClipInfo(folder);
  const frames = readIndex(folder);
  if (!info || frames.length === 0) return null;
  const fps = info.fps || 30;
  const endAt = info.endedAt ?? (frames.at(-1) as IndexedFrame).t + 1000 / fps;
  const list = join(folder, "frames.ffconcat");
  const plan = concatPlan(frames, endAt, fps);
  writeFileSync(list, plan.script);
  const out = o.out ?? join(folder, "clip.mkv");
  await run(o.ffmpegPath ?? "ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    list,
    "-vf",
    `fps=${fps},scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=lanczos,format=yuv420p`,
    "-c:v",
    "libx264",
    "-preset",
    o.preset ?? "veryfast",
    "-crf",
    String(o.crf ?? 14),
    "-frames:v",
    String(plan.totalFrames),
    "-an",
    out,
  ]);
  return out;
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let err = "";
    child.stderr.on("data", (d: Buffer) => {
      err = (err + d.toString()).slice(-4000);
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.trim()}`)),
    );
  });
}

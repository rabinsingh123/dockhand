// ffmpeg / ffprobe helpers for the video tools (spawned without a shell; drawtext reads its text and font from
// files next to the filter, so nothing needs filtergraph escaping).

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

/** Font files by name: stageFonts copies them next to the filter scripts (a path with "C:" needs escaping). */
export const FONT = "segoeui.ttf";
export const FONT_BOLD = "segoeuib.ttf";

export function stageFonts(dir: string): void {
  for (const f of [FONT, FONT_BOLD]) {
    const to = join(dir, f);
    if (!existsSync(to)) copyFileSync(join(process.env.WINDIR ?? "C:/Windows", "Fonts", f), to);
  }
}

export function run(
  cmd: string,
  args: string[],
  o: { cwd?: string; stderr?: boolean } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: o.cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
      if (!o.stderr && err.length > 20_000) err = err.slice(-8000);
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve(o.stderr ? err : out)
        : reject(new Error(`${cmd} exited ${code}: ${err.slice(-2000).trim()}`)),
    );
  });
}

export const ffmpeg = (args: string[], cwd?: string) =>
  run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], cwd ? { cwd } : {});

export interface Probe {
  duration: number;
  width: number;
  height: number;
  /** Epoch ms from the container's creation_time tag, if any. */
  creationTime: number | null;
  /** Epoch ms of the file's last write (usually when the recording stopped). */
  mtime: number;
}

export async function probe(file: string): Promise<Probe> {
  const json = JSON.parse(
    await run("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "format=duration:format_tags=creation_time:stream=width,height:stream_tags=creation_time",
      "-of",
      "json",
      file,
    ]),
  ) as {
    format?: { duration?: string; tags?: { creation_time?: string } };
    streams?: { width?: number; height?: number; tags?: { creation_time?: string } }[];
  };
  const tag = json.format?.tags?.creation_time ?? json.streams?.[0]?.tags?.creation_time;
  const created = tag ? Date.parse(tag) : Number.NaN;
  return {
    duration: Number(json.format?.duration ?? 0),
    width: json.streams?.[0]?.width ?? 0,
    height: json.streams?.[0]?.height ?? 0,
    creationTime: Number.isFinite(created) ? created : null,
    mtime: statSync(file).mtimeMs,
  };
}

/** The video frames really in the file, counted packet by packet. */
export async function countFrames(file: string): Promise<number> {
  const out = await run("ffprobe", [
    "-v",
    "error",
    "-count_packets",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=nb_read_packets",
    "-of",
    "csv=p=0",
    file,
  ]);
  return Number(out.trim());
}

/**
 * Where the voice in a clip starts and ends, in seconds of the file: a lead-in or a tail quieter than -40 dB for
 * 0.2 s is not the line. A clip with no such silence is all voice.
 */
export async function speechOf(file: string): Promise<{ from: number; to: number }> {
  const { duration } = await probe(file);
  const log = await run(
    "ffmpeg",
    ["-hide_banner", "-nostats", "-i", file, "-af", "silencedetect=noise=-40dB:d=0.2", "-f", "null", "-"],
    { stderr: true },
  );
  const starts = [...log.matchAll(/silence_start: (-?[\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...log.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  const from = (starts[0] ?? 1) <= 0.05 ? (ends[0] ?? 0) : 0;
  const last = starts.at(-1);
  // The tail: the last silence runs out the file, unclosed or closed at its very end.
  const tail =
    last !== undefined &&
    last > from &&
    (ends.length < starts.length || (ends.at(-1) ?? 0) >= duration - 0.05);
  const to = tail ? (last as number) : duration;
  return { from: Math.max(0, from - 0.05), to: Math.min(duration, to + 0.08) };
}

/** Whether the file carries a sound track. */
export async function hasAudio(file: string): Promise<boolean> {
  const out = await run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "a",
    "-show_entries",
    "stream=index",
    "-of",
    "csv=p=0",
    file,
  ]);
  return out.trim().length > 0;
}

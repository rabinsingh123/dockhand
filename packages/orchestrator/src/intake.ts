// Intake: classify by MIME (before any download), download media right away (Graph media URLs expire in
// minutes), then voice -> 16 kHz mono WAV (ffmpeg) -> transcript, photo/PDF -> structured extraction.
// Videos are teach input; their narration is handled by the teach flow.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ArtifactRef,
  type ArtifactStore,
  DockhandError,
  type InboundMessage,
  type Logger,
  type ModelGateway,
  type RepProfile,
  type Transcript,
  type WhatsAppClient,
} from "@dockhand/core";
import { type Extraction, extractionRequest } from "./understand.ts";

export type MediaClass = "voice" | "photo" | "pdf" | "video" | "unsupported";

const AUDIO = new Set([
  "audio/ogg",
  "audio/opus",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/amr",
  "audio/wav",
  "audio/x-wav",
]);
const IMAGES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function baseMime(mime: string | undefined): string {
  return (mime ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

/** What a media message is, from its MIME type (a screen recording sent as a document is still a video). */
export function classifyMedia(msg: Pick<InboundMessage, "kind" | "media">): MediaClass {
  const mime = baseMime(msg.media?.mime);
  if (!msg.media) return "unsupported";
  if (mime === "video/mp4") return "video";
  if (AUDIO.has(mime)) return "voice";
  if (IMAGES.has(mime)) return "photo";
  if (mime === "application/pdf") return "pdf";
  return "unsupported";
}

export const UNSUPPORTED_MEDIA =
  "I can read text, voice notes, photos, PDFs and mp4 screen recordings. That file type isn't one of them.";

export interface IntakeDeps {
  wa: WhatsAppClient;
  artifacts: ArtifactStore;
  models: ModelGateway;
  log: Logger;
  ffmpegPath: string;
  /** Scratch files for ffmpeg (var/tmp in production). */
  tmpDir: string;
}

/** One inbound message, ready for understanding. */
export interface IntakeItem {
  waId: string;
  kind: "text" | MediaClass;
  text?: string;
  media?: ArtifactRef;
  transcript?: Transcript;
  extraction?: Extraction;
}

/** Downloads now and stores the bytes; never call later than intake. */
export async function downloadMedia(
  msg: InboundMessage,
  jobId: string,
  deps: Pick<IntakeDeps, "wa" | "artifacts">,
): Promise<ArtifactRef> {
  if (!msg.media) throw new DockhandError("MEDIA_UNSUPPORTED", "message has no media");
  const { data, mime } = await deps.wa.downloadMedia(msg.media.mediaId);
  return deps.artifacts.put(data, baseMime(mime) || baseMime(msg.media.mime), {
    kind: "inbound_media",
    jobId,
    ...(msg.media.filename ? { filename: msg.media.filename } : {}),
  });
}

/** Transcript or extraction for a stored media item (no download: works after a restart too). */
export async function analyzeMedia(
  item: IntakeItem,
  ctx: { jobId: string; rep: RepProfile; keywords: string[] },
  deps: IntakeDeps,
): Promise<IntakeItem> {
  if (!item.media) return item;
  if (item.kind === "voice") {
    const wav = await toWav(await deps.artifacts.read(item.media), extFor(item.media.mime), deps);
    if (!wav) throw new DockhandError("MEDIA_UNSUPPORTED", "the voice note has no audio stream");
    const ref = await deps.artifacts.put(wav, "audio/wav", { kind: "audio_wav", jobId: ctx.jobId });
    const transcript = await deps.models.transcribe(
      ref,
      { languageBias: ctx.rep.languageBias, keywords: ctx.keywords },
      { purpose: "transcribe", jobId: ctx.jobId, timeoutMs: 60_000 },
    );
    return { ...item, transcript };
  }
  if (item.kind === "photo" || item.kind === "pdf") {
    const extraction = await deps.models.structured(
      extractionRequest({ type: item.kind === "photo" ? "image" : "pdf", ref: item.media }, item.text),
      { purpose: "extract", jobId: ctx.jobId, timeoutMs: 90_000 },
    );
    return { ...item, extraction };
  }
  return item;
}

function extFor(mime: string): string {
  const m = baseMime(mime);
  return m === "audio/mpeg"
    ? "mp3"
    : m === "video/mp4" || m === "audio/mp4"
      ? "mp4"
      : m.split("/")[1] || "bin";
}

/**
 * Any audio or video -> 16 kHz mono PCM16 WAV (what Voice Transcribe takes). Returns null when the input
 * has no audio stream (a silent screen recording). execFile with an argument array: the repo path has a space.
 */
export async function toWav(
  input: Uint8Array,
  ext: string,
  deps: Pick<IntakeDeps, "ffmpegPath" | "tmpDir">,
): Promise<Uint8Array | null> {
  await mkdir(deps.tmpDir, { recursive: true });
  const id = randomUUID();
  const inPath = join(deps.tmpDir, `${id}.${ext}`);
  const outPath = join(deps.tmpDir, `${id}.wav`);
  await writeFile(inPath, input);
  try {
    const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", inPath, "-map", "0:a:0"];
    args.push("-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", outPath);
    const { code, stderr } = await run(deps.ffmpegPath, args);
    if (code !== 0) {
      if (/matches no streams|does not contain any stream/i.test(stderr)) return null;
      throw new DockhandError(
        "MEDIA_UNSUPPORTED",
        `ffmpeg could not convert the audio: ${stderr.trim().slice(0, 300)}`,
      );
    }
    return new Uint8Array(await readFile(outPath));
  } finally {
    await rm(inPath, { force: true });
    await rm(outPath, { force: true });
  }
}

function run(file: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new DockhandError("TOOL_ERROR", `ffmpeg not found at "${file}" (set FFMPEG_PATH)`));
          return;
        }
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        resolve({ code, stderr: String(stderr ?? "") });
      },
    );
  });
}

/** ASR keyword hints: names Dockhand already knows (companies, portals, products, skill param examples). */
/** Voice Transcribe refuses the whole request when one keyword runs over 30 characters (HTTP 400). */
const ASR_KEYWORD_MAX = 30;

export function transcriptionKeywords(o: { companies: string[]; skillExamples: string[] }): string[] {
  const fixed = [
    "Tidewater Cloud",
    "Caravela",
    "Acme Group",
    "Globex Industrial",
    "Starter",
    "Business",
    "Enterprise",
  ];
  const out: string[] = [];
  for (const k of [...fixed, ...o.companies, ...o.skillExamples]) {
    const t = k.trim();
    if (t.length >= 3 && t.length <= ASR_KEYWORD_MAX && /[A-Za-zÀ-ÿ]/.test(t) && !out.includes(t)) out.push(t);
    if (out.length >= 50) break;
  }
  return out;
}

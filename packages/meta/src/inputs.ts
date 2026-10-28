import { type ArtifactStore, DockhandError, type InputPart } from "@dockhand/core";
import { MAX_IMAGES_PER_REQUEST, MAX_OPEN_WEIGHTS_IMAGES } from "./config.ts";
import type { FileUploader } from "./files.ts";
import type { RequestScope } from "./http.ts";
import { baseMime, dataUrlLength, imageMimeFor, isMp4Bytes, isPdfBytes, toDataUrl } from "./media.ts";

export type Route = "meta" | "baseten";

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"]);

/** input_image.image_url maxLength in https://dev.meta.ai/docs/api-reference/responses/schemas. */
const MAX_INLINE_IMAGE_URL_CHARS = 20_971_520;

export function countImages(parts: InputPart[]): number {
  return parts.filter((p) => p.type === "image").length;
}

/** Checks declared types and counts before anything is read, uploaded or replayed. */
export function assertInputParts(parts: InputPart[], route: Route): void {
  for (const part of parts) {
    if (part.type === "image" && !IMAGE_MIMES.has(baseMime(part.image.mime))) {
      throw new DockhandError(
        "MEDIA_UNSUPPORTED",
        `image input: ${part.image.mime} is not a supported image type`,
      );
    }
    if (part.type === "pdf") {
      if (route === "baseten")
        throw new DockhandError("MEDIA_UNSUPPORTED", "Muse Spark Open on Baseten does not accept PDFs");
      if (baseMime(part.file.mime) !== "application/pdf") {
        throw new DockhandError("MEDIA_UNSUPPORTED", `pdf input: declared type is ${part.file.mime}`);
      }
    }
    if (part.type === "video") {
      if (route === "baseten")
        throw new DockhandError("MEDIA_UNSUPPORTED", "the open-weights rung takes text and images only");
      if (baseMime(part.video.mime) !== "video/mp4") {
        throw new DockhandError("MEDIA_UNSUPPORTED", `video input must be video/mp4, got ${part.video.mime}`);
      }
    }
  }
  const images = countImages(parts);
  const max = route === "meta" ? MAX_IMAGES_PER_REQUEST : MAX_OPEN_WEIGHTS_IMAGES;
  if (images > max)
    throw new DockhandError("TOO_MANY_IMAGES", `${images} images in one request (max ${max})`);
}

/**
 * Cassette identity of a structured request: model, schema name, instructions, text parts, media hashes.
 * Calendar dates in the instructions are left out ("Today is Wed 2026-10-28" in the understanding prompt), so
 * a recording replays on any day; the replayed answer keeps the dates it was recorded with.
 */
export function structuredKeyMaterial(req: {
  model: string;
  schemaName: string;
  instructions: string;
  input: InputPart[];
}): unknown {
  return {
    model: req.model,
    schemaName: req.schemaName,
    instructions: withoutDates(req.instructions),
    parts: req.input.map(keyPart),
  };
}

const WEEKDAY_DATE = /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,? (?=\d{4}-\d{2}-\d{2}\b)/g;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g;

function withoutDates(text: string): string {
  return text.replace(WEEKDAY_DATE, "").replace(ISO_DATE, "<date>");
}

function keyPart(p: InputPart): Record<string, unknown> {
  if (p.type === "text") return { text: p.text };
  if (p.type === "image") return { image: p.image.sha256 };
  if (p.type === "pdf") return { pdf: p.file.sha256 };
  return { video: p.video.sha256, fps: p.fps ?? null };
}

export interface InputDeps {
  artifacts: ArtifactStore;
  files: FileUploader;
}

/**
 * The Responses user message (shape from https://dev.meta.ai/docs/file-handling): images inline as data
 * URLs (Files API when too large), PDFs and mp4 videos uploaded once and referenced by file id.
 */
export async function buildResponsesUserMessage(
  parts: InputPart[],
  deps: InputDeps,
  scope: RequestScope,
): Promise<Record<string, unknown>> {
  const content: Record<string, unknown>[] = [];
  for (const part of parts) {
    switch (part.type) {
      case "text":
        content.push({ type: "input_text", text: part.text });
        break;
      case "image": {
        const bytes = await deps.artifacts.read(part.image);
        const mime = imageMimeFor(part.image.mime, bytes, "image input");
        if (dataUrlLength(mime, bytes.byteLength) <= MAX_INLINE_IMAGE_URL_CHARS) {
          content.push({ type: "input_image", image_url: toDataUrl(mime, bytes) });
        } else {
          const fileId = await deps.files.fileId({ ...part.image, mime }, async () => bytes, scope);
          content.push({ type: "input_image", file_id: fileId });
        }
        break;
      }
      case "pdf": {
        const fileId = await deps.files.fileId(
          part.file,
          () => readChecked(deps, part.file, isPdfBytes, "PDF"),
          scope,
        );
        content.push({ type: "input_file", file_id: fileId });
        break;
      }
      case "video": {
        const fileId = await deps.files.fileId(
          part.video,
          () => readChecked(deps, part.video, isMp4Bytes, "mp4"),
          scope,
        );
        // input_file is the documented default for uploaded video; input_video carries the optional fps.
        content.push(
          part.fps === undefined
            ? { type: "input_file", file_id: fileId }
            : { type: "input_video", file_id: fileId, fps: part.fps },
        );
        break;
      }
    }
  }
  return { type: "message", role: "user", content };
}

/** Chat Completions user content for Baseten: a plain string for text only, else text and image_url parts. */
export async function buildChatUserContent(
  parts: InputPart[],
  artifacts: ArtifactStore,
): Promise<string | Record<string, unknown>[]> {
  if (parts.every((p) => p.type === "text"))
    return parts.map((p) => (p.type === "text" ? p.text : "")).join("\n\n");
  const content: Record<string, unknown>[] = [];
  for (const part of parts) {
    if (part.type === "text") content.push({ type: "text", text: part.text });
    else if (part.type === "image") {
      const bytes = await artifacts.read(part.image);
      const mime = imageMimeFor(part.image.mime, bytes, "image input");
      content.push({ type: "image_url", image_url: { url: toDataUrl(mime, bytes) } });
    }
  }
  return content;
}

async function readChecked(
  deps: InputDeps,
  ref: Parameters<ArtifactStore["read"]>[0],
  looksRight: (b: Uint8Array) => boolean,
  what: string,
): Promise<Uint8Array> {
  const bytes = await deps.artifacts.read(ref);
  if (!looksRight(bytes))
    throw new DockhandError("MEDIA_UNSUPPORTED", `${what} input: the bytes are not a ${what} file`);
  return bytes;
}

// Cloud API limits (docs/research/integration-facts.md sections 3.3 and 3.4), shared by the client
// (fails before any HTTP call) and the emulator (answers like Graph would).

import type { Button } from "@dockhand/core";

export const LIMITS = {
  textBody: 4096,
  interactiveBody: 1024,
  buttons: 3,
  buttonTitle: 20,
  buttonId: 256,
  footer: 60,
  headerText: 60, // stated for list messages; reply-button header length is undocumented
  caption: 1024,
} as const;

const MB = 1024 * 1024;

/** Outbound media types and size caps from the media page's upload table. */
const MEDIA_TYPES: {
  kind: "image" | "document" | "audio" | "video" | "sticker";
  mimes: string[];
  maxBytes: number;
}[] = [
  { kind: "image", mimes: ["image/jpeg", "image/png"], maxBytes: 5 * MB },
  {
    kind: "document",
    mimes: [
      "application/pdf",
      "text/plain",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
    maxBytes: 100 * MB,
  },
  {
    kind: "audio",
    mimes: ["audio/aac", "audio/amr", "audio/mpeg", "audio/mp4", "audio/ogg"],
    maxBytes: 16 * MB,
  },
  { kind: "video", mimes: ["video/3gpp", "video/mp4"], maxBytes: 16 * MB },
  { kind: "sticker", mimes: ["image/webp"], maxBytes: 500 * 1024 },
];

export function baseMime(mime: string): string {
  return mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

/** The upload category for a MIME type, or undefined when Cloud API does not accept it. */
export function mediaTypeFor(mime: string): { kind: string; maxBytes: number } | undefined {
  const base = baseMime(mime);
  return MEDIA_TYPES.find((t) => t.mimes.includes(base));
}

/** Characters as a person counts them (code points, so an emoji is one). */
export function charCount(value: string): number {
  return [...value].length;
}

export function textProblems(body: string): string[] {
  if (charCount(body.trim()) === 0) return ["text body is empty"];
  if (charCount(body) > LIMITS.textBody)
    return [`text body has ${charCount(body)} characters (max ${LIMITS.textBody})`];
  return [];
}

export function captionProblems(caption: string | undefined): string[] {
  if (caption === undefined || charCount(caption) <= LIMITS.caption) return [];
  return [`caption has ${charCount(caption)} characters (max ${LIMITS.caption})`];
}

export function buttonProblems(
  body: string,
  buttons: Button[],
  opts: { headerText?: string; footer?: string } = {},
): string[] {
  const problems: string[] = [];
  if (charCount(body.trim()) === 0) problems.push("body is empty");
  if (charCount(body) > LIMITS.interactiveBody) {
    problems.push(`body has ${charCount(body)} characters (max ${LIMITS.interactiveBody})`);
  }
  if (buttons.length < 1 || buttons.length > LIMITS.buttons) {
    problems.push(`${buttons.length} buttons (allowed: 1 to ${LIMITS.buttons})`);
  }
  for (const b of buttons) {
    const title = charCount(b.title);
    if (title < 1 || title > LIMITS.buttonTitle) {
      problems.push(
        `button title "${b.title}" has ${title} characters (allowed: 1 to ${LIMITS.buttonTitle})`,
      );
    }
    if (b.id.length < 1 || b.id.length > LIMITS.buttonId) {
      problems.push(`button id has ${b.id.length} characters (allowed: 1 to ${LIMITS.buttonId})`);
    }
  }
  if (new Set(buttons.map((b) => b.title)).size !== buttons.length)
    problems.push("button titles must be unique");
  if (new Set(buttons.map((b) => b.id)).size !== buttons.length) problems.push("button ids must be unique");
  if (opts.headerText !== undefined && charCount(opts.headerText) > LIMITS.headerText) {
    problems.push(`header text has ${charCount(opts.headerText)} characters (max ${LIMITS.headerText})`);
  }
  if (opts.footer !== undefined && charCount(opts.footer) > LIMITS.footer) {
    problems.push(`footer has ${charCount(opts.footer)} characters (max ${LIMITS.footer})`);
  }
  return problems;
}

/** Problems with sending these bytes as `kind` (image, document). */
export function mediaProblems(kind: "image" | "document", mime: string, bytes: number): string[] {
  const type = mediaTypeFor(mime);
  if (!type || type.kind !== kind)
    return [`${kind} MIME type ${baseMime(mime) || "(none)"} is not supported by WhatsApp`];
  if (bytes > type.maxBytes) return [`${kind} is ${bytes} bytes (max ${type.maxBytes})`];
  return [];
}

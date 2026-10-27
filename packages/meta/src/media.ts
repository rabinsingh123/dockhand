import { DockhandError } from "@dockhand/core";

export type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** Image types https://dev.meta.ai/docs/image-understanding lists (x-icon left out on purpose). */
const DECLARED_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"]);

/** The type the bytes really are; the API rejects a data URL whose declared type does not match its bytes. */
export function sniffImageMime(b: Uint8Array): ImageMime | undefined {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a") return "image/gif";
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "image/webp";
  return undefined;
}

export function isPdfBytes(b: Uint8Array): boolean {
  return ascii(b, 0, 5) === "%PDF-";
}

/** ISO base media file: the first box is `ftyp`. */
export function isMp4Bytes(b: Uint8Array): boolean {
  return ascii(b, 4, 4) === "ftyp";
}

/** "Image/JPEG; charset=x" -> "image/jpeg". */
export function baseMime(mime: string): string {
  return (mime.split(";", 1)[0] ?? "").trim().toLowerCase();
}

/** Checks the declared type of an input image and returns the type of its bytes. */
export function imageMimeFor(declared: string, bytes: Uint8Array, what: string): ImageMime {
  if (!DECLARED_IMAGE_MIMES.has(baseMime(declared))) {
    throw new DockhandError("MEDIA_UNSUPPORTED", `${what}: ${declared} is not a supported image type`, {
      mime: declared,
    });
  }
  const actual = sniffImageMime(bytes);
  if (!actual) {
    throw new DockhandError("MEDIA_UNSUPPORTED", `${what}: bytes are not PNG, JPEG, GIF or WebP`, {
      mime: declared,
    });
  }
  return actual;
}

/** Computer-use screenshots must be PNG or JPEG (https://dev.meta.ai/docs/computer-use). */
export function screenshotMime(bytes: Uint8Array): "image/png" | "image/jpeg" {
  const mime = sniffImageMime(bytes);
  if (mime === "image/png" || mime === "image/jpeg") return mime;
  throw new DockhandError("MEDIA_UNSUPPORTED", "screenshot must be a PNG or JPEG image");
}

export function toDataUrl(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64")}`;
}

export function dataUrlLength(mime: string, byteLength: number): number {
  return `data:${mime};base64,`.length + 4 * Math.ceil(byteLength / 3);
}

function startsWith(b: Uint8Array, prefix: number[]): boolean {
  return b.length >= prefix.length && prefix.every((v, i) => b[i] === v);
}

function ascii(b: Uint8Array, offset: number, length: number): string {
  if (b.length < offset + length) return "";
  return String.fromCharCode(...b.subarray(offset, offset + length));
}

// Internal to core (not exported from index.ts). packages/whatsapp's emulator mirrors contentPath().

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/amr": "amr",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/3gpp": "3gp",
  "video/webm": "webm",
  "application/json": "json",
  "application/x-ndjson": "ndjson",
  "text/plain": "txt",
  "text/html": "html",
  "text/csv": "csv",
  "text/markdown": "md",
  "text/typescript": "ts",
  "image/svg+xml": "svg",
  "application/zip": "zip",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

/** File extension for a MIME type; parameters are ignored ("audio/ogg; codecs=opus" -> "ogg"). Unknown -> "bin". */
export function extForMime(mime: string): string {
  const base = mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return EXTENSIONS[base] ?? "bin";
}

/** Content-addressed location, POSIX and relative to the var dir: `artifacts/ab/<sha256>.<ext>`. */
export function contentPath(sha256: string, mime: string): string {
  return `artifacts/${sha256.slice(0, 2)}/${sha256}.${extForMime(mime)}`;
}

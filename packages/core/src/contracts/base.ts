// Base types shared by every package. Contract changes are lead-only commits.

export type Id = string; // ULID

export interface Clock {
  now(): number; // epoch ms, UTC
}

export type ErrorCode =
  | "STEP_NOT_FOUND"
  | "STEP_AMBIGUOUS"
  | "STEP_TIMEOUT"
  | "ASSERT_FAILED"
  | "PORTAL_VALIDATION"
  | "READBACK_MISMATCH"
  | "NEEDS_INPUT"
  | "COMMIT_BLOCKED"
  | "WRITE_BLOCKED"
  | "APPROVAL_REJECTED"
  | "APPROVAL_EXPIRED"
  | "BUDGET_EXCEEDED"
  | "MODEL_TIMEOUT"
  | "MODEL_ERROR"
  | "MODEL_INCOMPLETE"
  | "MODEL_INVALID_OUTPUT"
  | "TOO_MANY_IMAGES"
  | "MEDIA_UNSUPPORTED"
  | "TOOL_ERROR"
  | "UNKNOWN_OUTCOME"
  | "CRASH_RECOVERED";

export class DockhandError extends Error {
  readonly code: ErrorCode;
  readonly detail?: unknown;
  constructor(code: ErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = "DockhandError";
    this.code = code;
    this.detail = detail;
  }
}

export type ArtifactKind =
  | "inbound_media"
  | "audio_wav"
  | "screenshot"
  | "receipt"
  | "quote_pdf"
  | "trace"
  | "skill_export"
  | "chart"
  | "upload_fixture";

export interface ArtifactRef {
  id: Id;
  sha256: string;
  mime: string;
  bytes: number;
  relPath: string; // POSIX, relative to the data dir
}

export interface ArtifactStore {
  put(
    data: Uint8Array,
    mime: string,
    meta: { kind: ArtifactKind; jobId?: Id; runId?: Id; filename?: string },
  ): Promise<ArtifactRef>;
  get(id: Id): ArtifactRef;
  read(ref: ArtifactRef | Id): Promise<Uint8Array>;
  absPath(ref: ArtifactRef): string;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

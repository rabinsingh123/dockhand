import { DockhandError, type Logger } from "./contracts/base.ts";

type Level = "debug" | "info" | "warn" | "error";
const RANK: Record<Level | "silent", number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

// Long strings are cut so a stray base64 image or request body never floods the log.
const MAX_STRING_CHARS = 2000;

/**
 * JSON lines to stderr: {"ts","level","msg",...fields}. Level from opts, else LOG_LEVEL, else "info"
 * ("silent" mutes everything). `write` replaces the stderr sink (tests).
 */
export function createLogger(
  opts: { level?: string; fields?: Record<string, unknown>; write?: (line: string) => void } = {},
): Logger {
  const threshold = RANK[parseLevel(opts.level ?? process.env.LOG_LEVEL)];
  const write = opts.write ?? ((line: string) => void process.stderr.write(`${line}\n`));
  return makeLogger(threshold, opts.fields ?? {}, write);
}

function makeLogger(threshold: number, base: Record<string, unknown>, write: (line: string) => void): Logger {
  const emit = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    if (RANK[level] < threshold) return;
    const record: Record<string, unknown> = { ts: new Date().toISOString(), level, msg };
    for (const [key, value] of Object.entries({ ...base, ...fields })) {
      if (!(key in record)) record[key] = value;
    }
    write(serialize(record));
  };
  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (fields) => makeLogger(threshold, { ...base, ...fields }, write),
  };
}

function parseLevel(value: string | undefined): Level | "silent" {
  const level = value?.trim().toLowerCase();
  return level && level in RANK ? (level as Level | "silent") : "info";
}

function serialize(record: Record<string, unknown>): string {
  try {
    return JSON.stringify(
      record,
      function replacer(this: Record<string, unknown>, key: string, value: unknown) {
        // `this[key]` is the value before toJSON ran (Buffer.toJSON would otherwise dump every byte).
        const original = key === "" ? value : this[key];
        if (original instanceof Uint8Array) return { bytes: original.byteLength };
        if (original instanceof Error) return describeError(original);
        if (typeof value === "bigint") return value.toString();
        if (typeof value === "string" && value.length > MAX_STRING_CHARS) {
          return `${value.slice(0, MAX_STRING_CHARS)}...(+${value.length - MAX_STRING_CHARS} chars)`;
        }
        return value;
      },
    );
  } catch (err) {
    return JSON.stringify({
      ts: record.ts,
      level: record.level,
      msg: record.msg,
      logError: `fields not serializable: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

function describeError(err: Error): Record<string, unknown> {
  const out: Record<string, unknown> = { name: err.name, message: err.message };
  const code = err instanceof DockhandError ? err.code : (err as Error & { code?: unknown }).code;
  if (typeof code === "string") out.code = code;
  if (err.stack) out.stack = err.stack;
  if (err.cause !== undefined)
    out.cause = err.cause instanceof Error ? describeError(err.cause) : String(err.cause);
  return out;
}

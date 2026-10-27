import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Clock, DockhandError, type Logger } from "@dockhand/core";

/** off = live calls only; record = live calls written to disk; replay = served from disk, no network. */
export type TapeMode = "off" | "record" | "replay";

/**
 * The raw provider responses of one logical call, in order (a structured call and its validation retry, or
 * every turn of a computer-use session). Replay feeds them back through the same parsing code.
 */
export interface Tape {
  readonly key: string;
  readonly replaying: boolean;
  /** Live/record: runs `send`. Replay: returns the next recorded response and never runs `send`. */
  next(send: () => Promise<unknown>, label?: string): Promise<unknown>;
  /** Record mode: writes everything recorded so far (computer-use sessions call this after every turn). */
  save(): Promise<void>;
}

export interface Cassettes {
  readonly mode: TapeMode;
  tape(purpose: string, key: string): Tape;
}

export interface CassetteFile {
  key: string;
  purpose: string;
  recordedAt: string;
  exchanges: { label?: string; response: unknown }[];
}

/** `<purpose>-<16 hex>`: sha256 over canonical JSON (sorted keys) of what identifies the call. */
export function cassetteKey(purpose: string, material: unknown): string {
  return `${purpose}-${createHash("sha256").update(canonicalJson(material)).digest("hex").slice(0, 16)}`;
}

export function cassettePath(dir: string, purpose: string, key: string): string {
  return join(dir, purpose, `${key}.json`);
}

export function createCassettes(o: { mode: TapeMode; dir: string; clock: Clock; log: Logger }): Cassettes {
  return {
    mode: o.mode,
    tape(purpose, key) {
      const path = cassettePath(o.dir, purpose, key);
      if (o.mode === "replay") return replayTape(key, path);
      if (o.mode === "record") return recordTape(key, purpose, path, o.clock, o.log);
      return { key, replaying: false, next: (send) => send(), save: async () => undefined };
    },
  };
}

function replayTape(key: string, path: string): Tape {
  let loaded: Promise<CassetteFile> | undefined;
  let cursor = 0;
  return {
    key,
    replaying: true,
    async next(_send, label) {
      loaded ??= loadCassette(key, path);
      const file = await loaded;
      const index = cursor++;
      const exchange = file.exchanges[index];
      if (!exchange) {
        throw new DockhandError("MODEL_ERROR", `cassette ${key} has no exchange #${index + 1} (${path})`, {
          key,
          path,
        });
      }
      if (label !== undefined && exchange.label !== undefined && exchange.label !== label) {
        throw new DockhandError(
          "MODEL_ERROR",
          `cassette ${key} exchange #${index + 1} was recorded for "${exchange.label}", replay sent "${label}"`,
          { key, path },
        );
      }
      return structuredClone(exchange.response);
    },
    save: async () => undefined,
  };
}

function recordTape(key: string, purpose: string, path: string, clock: Clock, log: Logger): Tape {
  const exchanges: CassetteFile["exchanges"] = [];
  let saved = 0;
  return {
    key,
    replaying: false,
    async next(send, label) {
      const response = await send();
      exchanges.push({ ...(label !== undefined ? { label } : {}), response });
      return response;
    },
    async save() {
      if (exchanges.length === saved) return;
      const file: CassetteFile = { key, purpose, recordedAt: new Date(clock.now()).toISOString(), exchanges };
      try {
        await writeAtomically(path, `${JSON.stringify(file, null, 2)}\n`);
        saved = exchanges.length;
        log.debug("cassette written", { key, exchanges: exchanges.length });
      } catch (err) {
        // A failed recording must not fail the live call it recorded.
        log.error("cassette write failed", { key, path, error: (err as Error).message });
      }
    },
  };
}

async function loadCassette(key: string, path: string): Promise<CassetteFile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new DockhandError(
      "MODEL_ERROR",
      `no cassette for key ${key} (expected ${path}); record it with META_MODE=record`,
      {
        key,
        path,
      },
    );
  }
  const file = JSON.parse(text) as CassetteFile;
  if (!Array.isArray(file.exchanges))
    throw new DockhandError("MODEL_ERROR", `cassette ${key} is malformed (${path})`);
  return file;
}

async function writeAtomically(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, text, "utf8");
  try {
    await rename(temp, path);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  });
}

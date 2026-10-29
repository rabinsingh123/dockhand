import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Clock, DockhandError, type Logger, varDir } from "@dockhand/core";

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
  /** `material` is what `key` was hashed from: stored with recordings, written out on a replay miss so the two can be diffed. */
  tape(purpose: string, key: string, material?: unknown): Tape;
}

export interface CassetteFile {
  key: string;
  purpose: string;
  recordedAt: string;
  material?: unknown;
  /** The first call with this key in the recording session. */
  exchanges: Exchange[];
  /**
   * Later calls with the same key in the same session, in order (the same photo sent in two steps, say). Live
   * responses vary, so replay serves the n-th call with the n-th recording; beyond the last it repeats the last.
   */
  laterCalls?: Exchange[][];
}

type Exchange = { label?: string; response: unknown };

/** `<purpose>-<16 hex>`: sha256 over canonical JSON (sorted keys) of what identifies the call. */
export function cassetteKey(purpose: string, material: unknown): string {
  return `${purpose}-${createHash("sha256").update(canonicalJson(material)).digest("hex").slice(0, 16)}`;
}

export function cassettePath(dir: string, purpose: string, key: string): string {
  return join(dir, purpose, `${key}.json`);
}

export function createCassettes(o: { mode: TapeMode; dir: string; clock: Clock; log: Logger }): Cassettes {
  /** Calls opened so far per key, in this process: which recorded call a replay serves, or a recording fills. */
  const calls = new Map<string, number>();
  /** Record mode: the files written in this session, so a later call with the same key appends to its file. */
  const files = new Map<string, CassetteFile>();
  const nextCall = (key: string) => {
    const n = calls.get(key) ?? 0;
    calls.set(key, n + 1);
    return n;
  };
  return {
    mode: o.mode,
    tape(purpose, key, material) {
      const path = cassettePath(o.dir, purpose, key);
      if (o.mode === "replay") return replayTape(key, path, purpose, material, nextCall(key));
      if (o.mode === "record")
        return recordTape({
          key,
          purpose,
          path,
          material,
          call: nextCall(key),
          files,
          clock: o.clock,
          log: o.log,
        });
      return { key, replaying: false, next: (send) => send(), save: async () => undefined };
    },
  };
}

/** The exchanges recorded for the `call`-th call with a key (older files hold only the first). */
function exchangesOf(file: CassetteFile, call: number): Exchange[] {
  if (call === 0 || !file.laterCalls?.length) return file.exchanges;
  return file.laterCalls[call - 1] ?? file.laterCalls[file.laterCalls.length - 1] ?? file.exchanges;
}

function replayTape(key: string, path: string, purpose: string, material: unknown, call: number): Tape {
  let loaded: Promise<Exchange[]> | undefined;
  let cursor = 0;
  return {
    key,
    replaying: true,
    async next(_send, label) {
      loaded ??= loadCassette(key, path, purpose, material).then((file) => exchangesOf(file, call));
      const exchanges = await loaded;
      const index = cursor++;
      const exchange = exchanges[index];
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

function recordTape(o: {
  key: string;
  purpose: string;
  path: string;
  material: unknown;
  call: number;
  files: Map<string, CassetteFile>;
  clock: Clock;
  log: Logger;
}): Tape {
  const { key, path, log } = o;
  const exchanges: Exchange[] = [];
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
      // The first call in this session starts the file (replacing an older recording); later calls append to it.
      let file = o.files.get(key);
      if (!file || o.call === 0) {
        file = { key, purpose: o.purpose, recordedAt: "", exchanges: [] };
        if (o.material !== undefined) file.material = o.material;
        o.files.set(key, file);
      }
      file.recordedAt = new Date(o.clock.now()).toISOString();
      if (o.call === 0) file.exchanges = [...exchanges];
      else {
        file.laterCalls ??= [];
        file.laterCalls[o.call - 1] = [...exchanges];
      }
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

async function loadCassette(
  key: string,
  path: string,
  purpose: string,
  material: unknown,
): Promise<CassetteFile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    const dump = await writeMiss(purpose, key, material);
    throw new DockhandError(
      "MODEL_ERROR",
      `no cassette for key ${key} (expected ${path}); record it with META_MODE=record${dump ? `; key material written to ${dump}` : ""}`,
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

/** On a replay miss, the material the key came from, under <var>/cassette-misses/ for a diff against the recording. */
async function writeMiss(purpose: string, key: string, material: unknown): Promise<string | undefined> {
  if (material === undefined) return undefined;
  const path = join(varDir(), "cassette-misses", purpose, `${key}.json`);
  try {
    await writeAtomically(path, `${JSON.stringify({ key, material }, null, 2)}\n`);
    return path;
  } catch {
    return undefined; // diagnostics only
  }
}

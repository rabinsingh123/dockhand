import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
  /** Replay mode: recordings by key material with clock values blanked, for the fallback match (built once). */
  let byClockless: Promise<Map<string, Exchange[][]>> | undefined;
  const clockless = new Map<string, number>();
  const fallback = async (purpose: string, material: unknown): Promise<Exchange[] | undefined> => {
    byClockless ??= indexWithoutClock(o.dir);
    const key = cassetteKey(purpose, withoutClock(material));
    const recorded = (await byClockless).get(key);
    if (!recorded?.length) return undefined;
    const n = clockless.get(key) ?? 0;
    clockless.set(key, n + 1);
    o.log.info("cassette matched with clock values ignored", { purpose, call: n + 1 });
    return recorded[Math.min(n, recorded.length - 1)];
  };
  return {
    mode: o.mode,
    tape(purpose, key, material) {
      const path = cassettePath(o.dir, purpose, key);
      if (o.mode === "replay") return replayTape(key, path, purpose, material, nextCall(key), fallback);
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

function replayTape(
  key: string,
  path: string,
  purpose: string,
  material: unknown,
  call: number,
  fallback: (purpose: string, material: unknown) => Promise<Exchange[] | undefined>,
): Tape {
  let loaded: Promise<Exchange[]> | undefined;
  let cursor = 0;
  const resolve = async (): Promise<Exchange[]> => {
    const file = await readCassette(key, path);
    if (file) return exchangesOf(file, call);
    // A page's clock (a submission time, today's date) is part of some requests; a recording made at another
    // time still answers the same request.
    const matched = material !== undefined ? await fallback(purpose, material) : undefined;
    if (matched) return matched;
    const dump = await writeMiss(purpose, key, material);
    throw new DockhandError(
      "MODEL_ERROR",
      `no cassette for key ${key} (expected ${path}); record it with META_MODE=record${dump ? `; key material written to ${dump}` : ""}`,
      { key, path },
    );
  };
  return {
    key,
    replaying: true,
    async next(_send, label) {
      loaded ??= resolve();
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

async function readCassette(key: string, path: string): Promise<CassetteFile | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const file = JSON.parse(text) as CassetteFile;
  if (!Array.isArray(file.exchanges))
    throw new DockhandError("MODEL_ERROR", `cassette ${key} is malformed (${path})`);
  return file;
}

const MONTH = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?";
const CLOCK_PATTERNS: [RegExp, string][] = [
  [/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g, "<date>"],
  [new RegExp(`\\b\\d{1,2} ${MONTH},? \\d{4}\\b`, "g"), "<date>"],
  [new RegExp(`\\b${MONTH} \\d{1,2},? \\d{4}\\b`, "g"), "<date>"],
  [/\b\d{1,2}\/\d{1,2}\/\d{4}\b/g, "<date>"],
  [/\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AaPp]\.?[Mm]\.?)?\b/g, "<time>"],
  [/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,? (?=<date>)/g, ""],
];

/** Key material with dates and times of day blanked: the fallback identity of a request. */
export function withoutClock(value: unknown): unknown {
  if (typeof value === "string") return CLOCK_PATTERNS.reduce((s, [re, to]) => s.replace(re, to), value);
  if (Array.isArray(value)) return value.map(withoutClock);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withoutClock(v)]));
  return value;
}

/** Every recording with stored material, by clockless key: its calls in recording order, oldest file first. */
async function indexWithoutClock(dir: string): Promise<Map<string, Exchange[][]>> {
  const found: { key: string; at: string; calls: Exchange[][] }[] = [];
  for (const purpose of await readdir(dir).catch(() => [] as string[])) {
    for (const name of await readdir(join(dir, purpose)).catch(() => [] as string[])) {
      if (!name.endsWith(".json")) continue;
      const file = await readCassette(name, join(dir, purpose, name)).catch(() => undefined);
      if (!file || file.material === undefined) continue;
      found.push({
        key: cassetteKey(purpose, withoutClock(file.material)),
        at: file.recordedAt,
        calls: [file.exchanges, ...(file.laterCalls ?? [])],
      });
    }
  }
  found.sort((a, b) => a.at.localeCompare(b.at));
  const index = new Map<string, Exchange[][]>();
  for (const f of found) index.set(f.key, [...(index.get(f.key) ?? []), ...f.calls]);
  return index;
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

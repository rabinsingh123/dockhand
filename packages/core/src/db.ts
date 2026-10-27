import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export interface Db {
  raw: DatabaseSync;
  /**
   * Runs `fn` in BEGIN IMMEDIATE ... COMMIT, or ROLLBACK when it throws. Nested calls use savepoints.
   * `fn` must be synchronous: a transaction cannot span an await.
   */
  tx<T>(fn: () => T): T;
  close(): void;
}

const require = createRequire(import.meta.url);
const WARNING_FILTER = Symbol.for("dockhand.sqliteExperimentalWarningFilter");

/** Opens (creating parent directories) and migrates a SQLite database. `":memory:"` is allowed. */
export function openDb(path: string): Db {
  const { DatabaseSync } = loadSqlite();
  const inMemory = path === ":memory:";
  if (!inMemory) mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA busy_timeout = 5000");
  if (!inMemory) raw.exec("PRAGMA journal_mode = WAL");
  raw.exec("PRAGMA foreign_keys = ON");
  raw.exec("PRAGMA synchronous = NORMAL");
  const db = wrap(raw);
  try {
    migrate(db);
  } catch (err) {
    raw.close();
    throw err;
  }
  return db;
}

function wrap(raw: DatabaseSync): Db {
  let depth = 0;
  return {
    raw,
    tx<T>(fn: () => T): T {
      const savepoint = depth > 0 ? `tx_${depth}` : null;
      raw.exec(savepoint ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
      depth++;
      try {
        const result = fn();
        if (isThenable(result)) {
          result.then(undefined, () => {}); // the caller gets the error below; avoid an unhandled rejection too
          throw new Error("db.tx(fn): fn returned a promise; transactions must be synchronous");
        }
        raw.exec(savepoint ? `RELEASE ${savepoint}` : "COMMIT");
        return result;
      } catch (err) {
        try {
          raw.exec(savepoint ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK");
        } catch {
          // SQLite already rolled back (some errors end the transaction themselves); keep the original error.
        }
        throw err;
      } finally {
        depth--;
      }
    },
    close: () => raw.close(),
  };
}

function migrate(db: Db): void {
  const migrations = loadMigrations();
  const latest = migrations.at(-1)?.version ?? 0;
  const userVersion = () =>
    (db.raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  const current = userVersion();
  if (current > latest)
    throw new Error(`database schema version ${current} is newer than this code (${latest})`);
  for (const m of migrations) {
    if (m.version <= current) continue;
    db.tx(() => {
      if (userVersion() >= m.version) return; // another process migrated while we waited for the lock
      db.raw.exec(m.sql);
      db.raw.exec(`PRAGMA user_version = ${m.version}`);
    });
  }
}

interface Migration {
  version: number;
  sql: string;
}

function loadMigrations(): Migration[] {
  const text = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
  // split() with a capture group yields [preamble, "1", sql1, "2", sql2, ...]
  const parts = text.split(/^-- migration: (\d+)[ \t]*\r?$/m);
  const migrations: Migration[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    const version = Number(parts[i]);
    if (version !== migrations.length + 1)
      throw new Error(`schema.sql: expected migration ${migrations.length + 1}, found ${version}`);
    migrations.push({ version, sql: parts[i + 1] ?? "" });
  }
  return migrations;
}

/**
 * node:sqlite (Node 22) prints "ExperimentalWarning: SQLite is an experimental feature" on first load.
 * Drop exactly that warning, then load the module lazily so the filter is in place first.
 */
function loadSqlite(): typeof import("node:sqlite") {
  const proc = process as NodeJS.Process & { [WARNING_FILTER]?: true };
  if (!proc[WARNING_FILTER]) {
    proc[WARNING_FILTER] = true;
    const emitWarning = process.emitWarning;
    process.emitWarning = function filtered(this: unknown, warning: string | Error, ...rest: unknown[]) {
      const message = typeof warning === "string" ? warning : warning.message;
      const option = rest[0];
      const type =
        typeof option === "string"
          ? option
          : ((option as { type?: string } | undefined)?.type ??
            (typeof warning === "string" ? undefined : warning.name));
      if (type === "ExperimentalWarning" && message.startsWith("SQLite is an experimental feature")) return;
      return (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
    } as typeof process.emitWarning;
  }
  return require("node:sqlite") as typeof import("node:sqlite");
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === "function";
}

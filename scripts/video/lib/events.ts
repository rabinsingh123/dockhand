// What happened in a session, read straight from the gateway's SQLite (read-only, WAL: safe while it runs).
// The director polls this for the cue screen and the cut list; it works the same with real WhatsApp and the
// emulator, because every inbound and outbound message, gate and run is stored there.

import { existsSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export interface Msg {
  waId: string;
  dir: "in" | "out";
  kind: string;
  text: string;
  at: number;
  jobId: string | null;
}

export interface GateRow {
  id: string;
  kind: string;
  status: string;
  body: string;
  at: number;
  resolvedAt: number | null;
}

export interface RunRow {
  id: string;
  mode: string;
  outcome: string | null;
  skill: string | null;
  version: number | null;
  startedAt: number;
  endedAt: number | null;
  modelCalls: number | null;
  suite: string | null;
}

export interface Snapshot {
  msgs: Msg[];
  gates: GateRow[];
  runs: RunRow[];
}

function open(dbPath: string): DatabaseSync | null {
  if (!existsSync(dbPath)) return null;
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
}

/** Messages, gates and runs from `since` (epoch ms) on, oldest first. */
export function readSince(dbPath: string, since: number): Snapshot {
  const db = open(dbPath);
  if (!db) return { msgs: [], gates: [], runs: [] };
  try {
    const msgs = (
      db
        .prepare(
          "SELECT wa_id, direction, kind, text, created_at, job_id FROM messages WHERE created_at >= ? ORDER BY created_at, rowid",
        )
        .all(since) as {
        wa_id: string;
        direction: "in" | "out";
        kind: string;
        text: string | null;
        created_at: number;
        job_id: string | null;
      }[]
    ).map((r) => ({
      waId: r.wa_id,
      dir: r.direction,
      kind: r.kind,
      text: r.text ?? "",
      at: r.created_at,
      jobId: r.job_id,
    }));
    const gates = (
      db
        .prepare(
          "SELECT id, kind, status, body, created_at, resolved_at FROM gates WHERE created_at >= ? ORDER BY created_at, rowid",
        )
        .all(since) as {
        id: string;
        kind: string;
        status: string;
        body: string;
        created_at: number;
        resolved_at: number | null;
      }[]
    ).map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      body: r.body,
      at: r.created_at,
      resolvedAt: r.resolved_at,
    }));
    const runs = (
      db
        .prepare(
          "SELECT id, mode, outcome, skill_name, skill_version, started_at, ended_at, model_calls, eval_suite FROM runs WHERE started_at >= ? ORDER BY started_at, rowid",
        )
        .all(since) as {
        id: string;
        mode: string;
        outcome: string | null;
        skill_name: string | null;
        skill_version: number | null;
        started_at: number;
        ended_at: number | null;
        model_calls: number | null;
        eval_suite: string | null;
      }[]
    ).map((r) => ({
      id: r.id,
      mode: r.mode,
      outcome: r.outcome,
      skill: r.skill_name,
      version: r.skill_version,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      modelCalls: r.model_calls,
      suite: r.eval_suite,
    }));
    return { msgs, gates, runs };
  } finally {
    db.close();
  }
}

/** Active skill versions (name -> version). */
export function activeSkills(dbPath: string): Record<string, number> {
  const db = open(dbPath);
  if (!db) return {};
  try {
    const rows = db.prepare("SELECT name, version FROM skills WHERE active = 1").all() as {
      name: string;
      version: number;
    }[];
    return Object.fromEntries(rows.map((r) => [r.name, r.version]));
  } finally {
    db.close();
  }
}

/** The newest open-weights pick (heal rung 2) since `since`, for the recorder's pick view. */
export function latestPick(dbPath: string, since: number, until = Number.MAX_SAFE_INTEGER): string | null {
  const db = open(dbPath);
  if (!db) return null;
  try {
    const r = db
      .prepare(
        "SELECT id FROM artifacts WHERE kind = 'heal_pick' AND created_at >= ? AND created_at <= ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(since, until) as { id: string } | undefined;
    return r?.id ?? null;
  } finally {
    db.close();
  }
}

/** The newest teach draft since `since`, for the recorder's teach view. */
export function latestDraft(dbPath: string, since: number, until = Number.MAX_SAFE_INTEGER): string | null {
  const db = open(dbPath);
  if (!db) return null;
  try {
    const r = db
      .prepare(
        "SELECT id FROM skill_drafts WHERE created_at >= ? AND created_at <= ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(since, until) as { id: string } | undefined;
    return r?.id ?? null;
  } finally {
    db.close();
  }
}

/** Spend on real providers (not tapes, stand-ins or the scripted model) since `since`. */
export function realSpend(dbPath: string, since = 0): number {
  const db = open(dbPath);
  if (!db) return 0;
  try {
    return (
      db
        .prepare(
          "SELECT COALESCE(SUM(cost_usd), 0) AS c FROM model_calls WHERE provider IN ('meta', 'baseten') AND ts >= ?",
        )
        .get(since) as { c: number }
    ).c;
  } catch {
    return 0;
  } finally {
    db.close();
  }
}

/** Model calls that reached a real provider (a cassette rehearsal must have none). */
export function providerCalls(dbPath: string): number {
  const db = open(dbPath);
  if (!db) return 0;
  try {
    return (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM model_calls WHERE provider NOT IN ('cassette', 'fake', 'scripted')",
        )
        .get() as { n: number }
    ).n;
  } finally {
    db.close();
  }
}

/** A consistent copy of the live database (VACUUM INTO works on a read-only connection). */
export function snapshotDb(dbPath: string, to: string): boolean {
  const db = open(dbPath);
  if (!db) return false;
  try {
    rmSync(to, { force: true }); // a redo snapshots the same take again, and VACUUM INTO never overwrites
    db.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`);
    return true;
  } finally {
    db.close();
  }
}

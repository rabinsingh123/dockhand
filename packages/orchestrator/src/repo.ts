// Typed repositories over the core SQLite schema (docs/reviews/architect-review.md §4, T1-T6).
// Every function is synchronous (node:sqlite) so callers can compose them inside db.tx().

import type {
  Clock,
  Db,
  ErrorCode,
  GateKind,
  InboundMessage,
  Intent,
  JobEvent,
  JobStatus,
  Plan,
  StepResult,
  Understanding,
} from "@dockhand/core";
import { ulid } from "@dockhand/core";
import { transition } from "./fsm.ts";

// ---------- rows ----------

export interface JobRow {
  id: string;
  rep: string;
  status: JobStatus;
  intent: Intent | null;
  understanding: Understanding | null;
  plan: Plan | null;
  language: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  rev: number;
  createdAt: number;
  updatedAt: number;
}

export interface JobEventRow {
  id: number;
  jobId: string;
  from: JobStatus | null;
  to: JobStatus | null;
  event: JobEvent;
  accepted: boolean;
  at: number;
}

export interface MessageRow {
  waId: string;
  direction: "in" | "out";
  rep: string;
  jobId: string | null;
  kind: string;
  text: string | null;
  mediaArtifactId: string | null;
  buttonId: string | null;
  replyTo: string | null;
  createdAt: number;
}

export type GateStatus = "pending" | "approved" | "rejected" | "edit" | "expired" | `opt${number}`;

export interface GateRow {
  id: string;
  jobId: string;
  runId: string | null;
  kind: GateKind;
  status: GateStatus;
  body: string;
  imageArtifactId: string | null;
  waId: string | null;
  expiresAt: number;
  resolvedAt: number | null;
  resolvedByWaId: string | null;
  createdAt: number;
}

export type ToolCallStatus = "started" | "succeeded" | "failed" | "unknown";

export interface ToolCallRow {
  id: string;
  jobId: string;
  idx: number;
  kind: string;
  idemKey: string;
  args: unknown;
  status: ToolCallStatus;
  result: unknown;
  error: string | null;
  startedAt: number;
  endedAt: number | null;
}

export type RunMode = "agentic" | "replay" | "repair";

export interface RunRow {
  id: string;
  jobId: string | null;
  mode: RunMode;
  skillName: string | null;
  skillVersion: number | null;
  portalId: string | null;
  outcome: string | null;
  errorCode: string | null;
  startedAt: number;
  endedAt: number | null;
  ms: number | null;
  execCostUsd: number | null;
  modelCalls: number | null;
}

// ---------- repositories ----------

export type ApplyResult = { ok: true; job: JobRow } | { ok: false; reason: string; job: JobRow | undefined };

export interface Repos {
  messages: ReturnType<typeof messagesRepo>;
  jobs: ReturnType<typeof jobsRepo>;
  gates: ReturnType<typeof gatesRepo>;
  toolCalls: ReturnType<typeof toolCallsRepo>;
  runs: ReturnType<typeof runsRepo>;
  reps: ReturnType<typeof repsRepo>;
  drafts: ReturnType<typeof draftsRepo>;
}

export function createRepos(db: Db, clock: Clock): Repos {
  return {
    messages: messagesRepo(db, clock),
    jobs: jobsRepo(db, clock),
    gates: gatesRepo(db, clock),
    toolCalls: toolCallsRepo(db, clock),
    runs: runsRepo(db, clock),
    reps: repsRepo(db, clock),
    drafts: draftsRepo(db),
  };
}

/** skill_drafts belongs to the skill store; the only thing done here is abandoning a rejected draft. */
function draftsRepo(db: Db) {
  return {
    abandon(id: string): void {
      db.raw
        .prepare("UPDATE skill_drafts SET status = 'abandoned' WHERE id = ? AND status = 'draft'")
        .run(id);
    },
  };
}

type Row = Record<string, unknown>;

function json<T>(text: unknown): T | null {
  return typeof text === "string" ? (JSON.parse(text) as T) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : null;
}

// ---------- messages (T1) ----------

function messagesRepo(db: Db, clock: Clock) {
  const toRow = (r: Row): MessageRow => ({
    waId: String(r.wa_id),
    direction: r.direction as "in" | "out",
    rep: String(r.rep),
    jobId: str(r.job_id),
    kind: String(r.kind),
    text: str(r.text),
    mediaArtifactId: str(r.media_artifact_id),
    buttonId: str(r.button_id),
    replyTo: str(r.reply_to),
    createdAt: Number(r.created_at),
  });

  return {
    /** Inbound dedupe: false when this wamid was already stored (a webhook retry). */
    insertInbound(m: InboundMessage, raw?: unknown): boolean {
      const res = db.raw
        .prepare(
          `INSERT INTO messages (wa_id, direction, rep, job_id, kind, text, media_artifact_id, button_id, reply_to, raw_json, created_at)
           VALUES (?, 'in', ?, NULL, ?, ?, NULL, ?, ?, ?, ?) ON CONFLICT(wa_id) DO NOTHING`,
        )
        .run(
          m.waId,
          m.from,
          m.kind,
          m.text ?? null,
          m.button?.id ?? null,
          m.replyTo ?? null,
          JSON.stringify(raw ?? m),
          clock.now(),
        );
      return Number(res.changes) > 0;
    },

    insertOutbound(o: { waId: string; to: string; jobId: string | null; kind: string; text?: string }): void {
      db.raw
        .prepare(
          `INSERT INTO messages (wa_id, direction, rep, job_id, kind, text, created_at)
           VALUES (?, 'out', ?, ?, ?, ?, ?) ON CONFLICT(wa_id) DO NOTHING`,
        )
        .run(o.waId, o.to, o.jobId, o.kind, o.text ?? null, clock.now());
    },

    linkJob(waId: string, jobId: string): void {
      db.raw.prepare("UPDATE messages SET job_id = ? WHERE wa_id = ?").run(jobId, waId);
    },

    setMedia(waId: string, artifactId: string): void {
      db.raw.prepare("UPDATE messages SET media_artifact_id = ? WHERE wa_id = ?").run(artifactId, waId);
    },

    get(waId: string): MessageRow | undefined {
      const r = db.raw.prepare("SELECT * FROM messages WHERE wa_id = ?").get(waId) as Row | undefined;
      return r ? toRow(r) : undefined;
    },

    /** Inbound messages of a job, oldest first (the inputs an understanding call sees). */
    inboundForJob(jobId: string): MessageRow[] {
      return (
        db.raw
          .prepare("SELECT * FROM messages WHERE job_id = ? AND direction = 'in' ORDER BY created_at, rowid")
          .all(jobId) as Row[]
      ).map(toRow);
    },

    forJob(jobId: string): MessageRow[] {
      return (
        db.raw
          .prepare("SELECT * FROM messages WHERE job_id = ? ORDER BY created_at, rowid")
          .all(jobId) as Row[]
      ).map(toRow);
    },
  };
}

// ---------- jobs + job_events (T3) ----------

function jobsRepo(db: Db, clock: Clock) {
  const toJob = (r: Row): JobRow => ({
    id: String(r.id),
    rep: String(r.rep),
    status: r.status as JobStatus,
    intent: (str(r.intent) as Intent | null) ?? null,
    understanding: json<Understanding>(r.understanding_json),
    plan: json<Plan>(r.plan_json),
    language: str(r.language),
    errorCode: str(r.error_code),
    errorMessage: str(r.error_message),
    rev: Number(r.rev),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  });

  const get = (id: string): JobRow | undefined => {
    const r = db.raw.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;
    return r ? toJob(r) : undefined;
  };

  const logEvent = (
    jobId: string,
    from: JobStatus | null,
    to: JobStatus | null,
    e: JobEvent,
    ok: boolean,
  ) => {
    db.raw
      .prepare(
        "INSERT INTO job_events (job_id, from_status, to_status, event_json, accepted, at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(jobId, from, to, JSON.stringify(e), ok ? 1 : 0, clock.now());
  };

  return {
    get,

    create(rep: string): JobRow {
      const now = clock.now();
      const id = ulid(clock);
      db.raw
        .prepare(
          "INSERT INTO jobs (id, rep, status, rev, created_at, updated_at) VALUES (?, ?, 'received', 0, ?, ?)",
        )
        .run(id, rep, now, now);
      return get(id) as JobRow;
    },

    /**
     * T3: transition by compare-and-set on rev, plus the job_events row, in one transaction.
     * A rejected transition is logged with accepted = 0 and changes nothing.
     */
    apply(id: string, event: JobEvent): ApplyResult {
      return db.tx(() => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const job = get(id);
          if (!job) return { ok: false, reason: `job ${id} not found`, job: undefined };
          const t = transition(job.status, event);
          if (!t.ok) {
            logEvent(id, job.status, null, event, false);
            return { ok: false, reason: t.reason, job };
          }
          const errorCode = event.type === "finished" && !event.ok ? (event.errorCode ?? null) : null;
          const res = db.raw
            .prepare(
              `UPDATE jobs SET status = ?, rev = rev + 1, updated_at = ?,
                 error_code = COALESCE(?, error_code)
               WHERE id = ? AND rev = ?`,
            )
            .run(t.next, clock.now(), errorCode, id, job.rev);
          if (Number(res.changes) === 1) {
            logEvent(id, job.status, t.next, event, true);
            return { ok: true, job: get(id) as JobRow };
          }
          // Lost a race (rev moved): re-read and decide again.
        }
        return { ok: false, reason: "lost the compare-and-set race 3 times", job: get(id) };
      });
    },

    update(
      id: string,
      f: {
        intent?: Intent | null;
        understanding?: Understanding | null;
        plan?: Plan | null;
        language?: string | null;
        error?: { code: ErrorCode | string; message: string } | null;
      },
    ): void {
      const sets: string[] = [];
      const args: (string | number | null)[] = [];
      if (f.intent !== undefined) {
        sets.push("intent = ?");
        args.push(f.intent);
      }
      if (f.understanding !== undefined) {
        sets.push("understanding_json = ?");
        args.push(f.understanding === null ? null : JSON.stringify(f.understanding));
      }
      if (f.plan !== undefined) {
        sets.push("plan_json = ?");
        args.push(f.plan === null ? null : JSON.stringify(f.plan));
      }
      if (f.language !== undefined) {
        sets.push("language = ?");
        args.push(f.language);
      }
      if (f.error !== undefined) {
        sets.push("error_code = ?", "error_message = ?");
        args.push(f.error?.code ?? null, f.error?.message ?? null);
      }
      if (sets.length === 0) return;
      sets.push("updated_at = ?");
      args.push(clock.now());
      db.raw.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
    },

    events(jobId: string): JobEventRow[] {
      return (
        db.raw.prepare("SELECT * FROM job_events WHERE job_id = ? ORDER BY id").all(jobId) as Row[]
      ).map((r) => ({
        id: Number(r.id),
        jobId: String(r.job_id),
        from: (str(r.from_status) as JobStatus | null) ?? null,
        to: (str(r.to_status) as JobStatus | null) ?? null,
        event: JSON.parse(String(r.event_json)) as JobEvent,
        accepted: Number(r.accepted) === 1,
        at: Number(r.at),
      }));
    },

    /**
     * The rep's job that a plain text attaches to (§1.4): awaiting input, or waiting on a plan or
     * question gate. Most recent first.
     */
    attachableFor(rep: string): JobRow | undefined {
      const r = db.raw
        .prepare(
          `SELECT j.* FROM jobs j
           WHERE j.rep = ? AND (
             j.status = 'awaiting_input'
             OR (j.status = 'awaiting_approval' AND EXISTS (
               SELECT 1 FROM gates g WHERE g.job_id = j.id AND g.status = 'pending' AND g.kind IN ('plan', 'question')))
           )
           ORDER BY j.created_at DESC, j.rowid DESC LIMIT 1`,
        )
        .get(rep) as Row | undefined;
      return r ? toJob(r) : undefined;
    },

    /** Jobs that were mid-flight when the process stopped (boot sweep). */
    inFlight(): JobRow[] {
      return (
        db.raw
          .prepare(
            "SELECT * FROM jobs WHERE status IN ('received', 'understanding', 'executing', 'awaiting_approval') ORDER BY created_at",
          )
          .all() as Row[]
      ).map(toJob);
    },

    recentCompanies(limit: number): string[] {
      const rows = db.raw
        .prepare(
          `SELECT DISTINCT json_extract(understanding_json, '$.company') AS company FROM jobs
           WHERE understanding_json IS NOT NULL AND json_extract(understanding_json, '$.company') IS NOT NULL
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all(limit) as Row[];
      return rows.map((r) => String(r.company)).filter((c) => c.trim() !== "");
    },
  };
}

// ---------- gates (T2, T5) ----------

function gatesRepo(db: Db, clock: Clock) {
  const toGate = (r: Row): GateRow => ({
    id: String(r.id),
    jobId: String(r.job_id),
    runId: str(r.run_id),
    kind: r.kind as GateKind,
    status: r.status as GateStatus,
    body: String(r.body),
    imageArtifactId: str(r.image_artifact_id),
    waId: str(r.wa_id),
    expiresAt: Number(r.expires_at),
    resolvedAt: num(r.resolved_at),
    resolvedByWaId: str(r.resolved_by_wa_id),
    createdAt: Number(r.created_at),
  });

  return {
    insert(g: {
      id: string;
      jobId: string;
      runId?: string | null;
      kind: GateKind;
      body: string;
      imageArtifactId?: string | null;
      expiresAt: number;
      status?: GateStatus;
    }): void {
      db.raw
        .prepare(
          `INSERT INTO gates (id, job_id, run_id, kind, status, body, image_artifact_id, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          g.id,
          g.jobId,
          g.runId ?? null,
          g.kind,
          g.status ?? "pending",
          g.body,
          g.imageArtifactId ?? null,
          g.expiresAt,
          clock.now(),
        );
    },

    setWaId(id: string, waId: string): void {
      db.raw.prepare("UPDATE gates SET wa_id = ? WHERE id = ?").run(waId, id);
    },

    get(id: string): GateRow | undefined {
      const r = db.raw.prepare("SELECT * FROM gates WHERE id = ?").get(id) as Row | undefined;
      return r ? toGate(r) : undefined;
    },

    /** T2's guarded update: only a pending, unexpired gate changes. Returns true when it did. */
    resolve(
      id: string,
      status: Exclude<GateStatus, "pending" | "expired">,
      byWaId: string | null,
      now: number,
    ): boolean {
      const res = db.raw
        .prepare(
          `UPDATE gates SET status = ?, resolved_at = ?, resolved_by_wa_id = ?
           WHERE id = ? AND status = 'pending' AND expires_at > ?`,
        )
        .run(status, now, byWaId, id, now);
      return Number(res.changes) === 1;
    },

    /** Marks a pending gate expired (no time check: the sweep and the boot sweep decide). */
    expire(id: string, now: number): boolean {
      const res = db.raw
        .prepare("UPDATE gates SET status = 'expired', resolved_at = ? WHERE id = ? AND status = 'pending'")
        .run(now, id);
      return Number(res.changes) === 1;
    },

    due(now: number): GateRow[] {
      return (
        db.raw
          .prepare("SELECT * FROM gates WHERE status = 'pending' AND expires_at <= ? ORDER BY expires_at")
          .all(now) as Row[]
      ).map(toGate);
    },

    pendingForJob(jobId: string): GateRow[] {
      return (
        db.raw
          .prepare("SELECT * FROM gates WHERE job_id = ? AND status = 'pending' ORDER BY created_at, rowid")
          .all(jobId) as Row[]
      ).map(toGate);
    },

    forJob(jobId: string): GateRow[] {
      return (
        db.raw.prepare("SELECT * FROM gates WHERE job_id = ? ORDER BY created_at, rowid").all(jobId) as Row[]
      ).map(toGate);
    },
  };
}

// ---------- tool_calls (written outside transactions on purpose) ----------

function toolCallsRepo(db: Db, clock: Clock) {
  const toCall = (r: Row): ToolCallRow => ({
    id: String(r.id),
    jobId: String(r.job_id),
    idx: Number(r.idx),
    kind: String(r.kind),
    idemKey: String(r.idem_key),
    args: json(r.args_json),
    status: r.status as ToolCallStatus,
    result: json(r.result_json),
    error: str(r.error),
    startedAt: Number(r.started_at),
    endedAt: num(r.ended_at),
  });

  const byKey = (idemKey: string): ToolCallRow | undefined => {
    const r = db.raw.prepare("SELECT * FROM tool_calls WHERE idem_key = ?").get(idemKey) as Row | undefined;
    return r ? toCall(r) : undefined;
  };

  return {
    byKey,

    /**
     * Commits a 'started' row before the external call. A failed earlier attempt (the server
     * answered with an error, so nothing was written) is reopened; any other existing row is returned
     * as is and the caller must not call out again.
     */
    begin(c: {
      jobId: string;
      idx: number;
      kind: string;
      idemKey: string;
      args: unknown;
    }): { fresh: true; row: ToolCallRow } | { fresh: false; row: ToolCallRow } {
      const existing = byKey(c.idemKey);
      if (existing && existing.status !== "failed") return { fresh: false, row: existing };
      if (existing) {
        db.raw
          .prepare(
            "UPDATE tool_calls SET status = 'started', error = NULL, result_json = NULL, started_at = ?, ended_at = NULL WHERE id = ?",
          )
          .run(clock.now(), existing.id);
      } else {
        db.raw
          .prepare(
            `INSERT INTO tool_calls (id, job_id, idx, kind, idem_key, args_json, status, started_at)
             VALUES (?, ?, ?, ?, ?, ?, 'started', ?)`,
          )
          .run(ulid(clock), c.jobId, c.idx, c.kind, c.idemKey, JSON.stringify(c.args ?? null), clock.now());
      }
      return { fresh: true, row: byKey(c.idemKey) as ToolCallRow };
    },

    succeed(id: string, result: unknown): void {
      db.raw
        .prepare("UPDATE tool_calls SET status = 'succeeded', result_json = ?, ended_at = ? WHERE id = ?")
        .run(JSON.stringify(result ?? null), clock.now(), id);
    },

    fail(id: string, error: string, status: "failed" | "unknown" = "failed"): void {
      db.raw
        .prepare("UPDATE tool_calls SET status = ?, error = ?, ended_at = ? WHERE id = ?")
        .run(status, error, clock.now(), id);
    },

    forJob(jobId: string): ToolCallRow[] {
      return (
        db.raw
          .prepare("SELECT * FROM tool_calls WHERE job_id = ? ORDER BY started_at, rowid")
          .all(jobId) as Row[]
      ).map(toCall);
    },

    /** Boot sweep: 'started' rows never got an answer, so their outcome is unknown. */
    markStartedUnknown(): ToolCallRow[] {
      const rows = (db.raw.prepare("SELECT * FROM tool_calls WHERE status = 'started'").all() as Row[]).map(
        toCall,
      );
      db.raw
        .prepare(
          "UPDATE tool_calls SET status = 'unknown', error = 'process stopped during the call', ended_at = ? WHERE status = 'started'",
        )
        .run(clock.now());
      return rows;
    },
  };
}

/** Idempotency key for a plan action: "jobId:actionIdx". */
export function idemKey(jobId: string, actionIdx: number): string {
  return `${jobId}:${actionIdx}`;
}

export function parseIdemKey(key: string): { jobId: string; idx: number } {
  const at = key.lastIndexOf(":");
  const idx = Number(key.slice(at + 1));
  if (at <= 0 || !Number.isInteger(idx))
    throw new Error(`bad idempotency key "${key}" (expected jobId:actionIdx)`);
  return { jobId: key.slice(0, at), idx };
}

// ---------- runs + run_steps (T6) ----------

function runsRepo(db: Db, clock: Clock) {
  const toRun = (r: Row): RunRow => ({
    id: String(r.id),
    jobId: str(r.job_id),
    mode: r.mode as RunMode,
    skillName: str(r.skill_name),
    skillVersion: num(r.skill_version),
    portalId: str(r.portal_id),
    outcome: str(r.outcome),
    errorCode: str(r.error_code),
    startedAt: Number(r.started_at),
    endedAt: num(r.ended_at),
    ms: num(r.ms),
    execCostUsd: num(r.exec_cost_usd),
    modelCalls: num(r.model_calls),
  });

  return {
    /** Inserted at start so a crashed run stays visible. */
    start(r: {
      id: string;
      jobId: string | null;
      mode: RunMode;
      skillName?: string | null;
      skillVersion?: number | null;
      portalId?: string | null;
      portalSession?: unknown;
      params?: unknown;
    }): void {
      db.raw
        .prepare(
          `INSERT INTO runs (id, job_id, mode, skill_name, skill_version, portal_id, portal_session_json, params_json, started_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          r.id,
          r.jobId,
          r.mode,
          r.skillName ?? null,
          r.skillVersion ?? null,
          r.portalId ?? null,
          r.portalSession === undefined ? null : JSON.stringify(r.portalSession),
          r.params === undefined ? null : JSON.stringify(r.params),
          clock.now(),
        );
    },

    /** One update at the end: outcome, timing, cost and evidence. */
    finish(
      id: string,
      f: {
        outcome: string;
        errorCode?: string | null;
        ms: number;
        execCostUsd: number;
        modelCalls: number;
        mode?: RunMode;
        skillName?: string | null;
        skillVersion?: number | null;
        traceArtifactId?: string | null;
        finalScreenshotId?: string | null;
        extracted?: Record<string, string>;
      },
    ): void {
      db.raw
        .prepare(
          `UPDATE runs SET outcome = ?, error_code = ?, ended_at = ?, ms = ?, exec_cost_usd = ?, model_calls = ?,
             mode = COALESCE(?, mode), skill_name = COALESCE(?, skill_name), skill_version = COALESCE(?, skill_version),
             trace_artifact_id = ?, final_screenshot_id = ?, extracted_json = ?
           WHERE id = ?`,
        )
        .run(
          f.outcome,
          f.errorCode ?? null,
          clock.now(),
          Math.round(f.ms),
          f.execCostUsd,
          f.modelCalls,
          f.mode ?? null,
          f.skillName ?? null,
          f.skillVersion ?? null,
          f.traceArtifactId ?? null,
          f.finalScreenshotId ?? null,
          f.extracted ? JSON.stringify(f.extracted) : null,
          id,
        );
    },

    /** Autocommit per completed step. */
    step(runId: string, s: StepResult & { op: string; target?: unknown }): void {
      db.raw
        .prepare(
          `INSERT OR REPLACE INTO run_steps (run_id, idx, step_id, op, status, rung, candidate_idx, ms, error_code, error, target_json, screenshot_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          s.idx,
          s.stepId,
          s.op,
          s.status,
          s.rung ?? null,
          s.candidateIdx ?? null,
          Math.round(s.ms),
          s.errorCode ?? null,
          s.error ?? null,
          s.target === undefined ? null : JSON.stringify(s.target),
          s.screenshot?.id ?? null,
        );
    },

    get(id: string): RunRow | undefined {
      const r = db.raw.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Row | undefined;
      return r ? toRun(r) : undefined;
    },

    forJob(jobId: string): RunRow[] {
      return (
        db.raw.prepare("SELECT * FROM runs WHERE job_id = ? ORDER BY started_at, rowid").all(jobId) as Row[]
      ).map(toRun);
    },

    steps(runId: string): { idx: number; stepId: string; op: string; status: string; rung: string | null }[] {
      return (
        db.raw.prepare("SELECT * FROM run_steps WHERE run_id = ? ORDER BY idx").all(runId) as Row[]
      ).map((r) => ({
        idx: Number(r.idx),
        stepId: String(r.step_id),
        op: String(r.op),
        status: String(r.status),
        rung: str(r.rung),
      }));
    },

    /** Boot sweep: runs that never finished. Their outcome is unknown (a commit may have happened). */
    markUnfinished(): number {
      const res = db.raw
        .prepare(
          `UPDATE runs SET outcome = 'unknown', error_code = 'CRASH_RECOVERED', ended_at = ?
           WHERE ended_at IS NULL AND eval_suite IS NULL`,
        )
        .run(clock.now());
      return Number(res.changes);
    },

    /** Summary for /stats (non-eval runs only). */
    summary(): {
      mode: string;
      outcome: string | null;
      runs: number;
      avgMs: number | null;
      costUsd: number;
    }[] {
      return (
        db.raw
          .prepare(
            `SELECT mode, outcome, COUNT(*) AS runs, AVG(ms) AS avg_ms, COALESCE(SUM(exec_cost_usd), 0) AS cost
             FROM runs WHERE eval_suite IS NULL GROUP BY mode, outcome ORDER BY mode, outcome`,
          )
          .all() as Row[]
      ).map((r) => ({
        mode: String(r.mode),
        outcome: str(r.outcome),
        runs: Number(r.runs),
        avgMs: num(r.avg_ms),
        costUsd: Number(r.cost),
      }));
    },
  };
}

// ---------- reps ----------

export interface RepRow {
  phone: string;
  name: string;
  tz: string;
  locale: string;
  languageBias: string[];
  allowed: boolean;
  refusedAt: number | null;
}

function repsRepo(db: Db, clock: Clock) {
  return {
    get(phone: string): RepRow | undefined {
      const r = db.raw.prepare("SELECT * FROM reps WHERE phone = ?").get(phone) as Row | undefined;
      if (!r) return undefined;
      return {
        phone: String(r.phone),
        name: String(r.name),
        tz: String(r.tz),
        locale: String(r.locale),
        languageBias: json<string[]>(r.language_bias) ?? [],
        allowed: Number(r.allowed) === 1,
        refusedAt: num(r.refused_at),
      };
    },

    upsert(r: {
      phone: string;
      name: string;
      tz: string;
      locale: string;
      languageBias: string[];
      allowed: boolean;
    }): void {
      db.raw
        .prepare(
          `INSERT INTO reps (phone, name, tz, locale, language_bias, allowed) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(phone) DO UPDATE SET name = excluded.name, tz = excluded.tz, locale = excluded.locale,
             language_bias = excluded.language_bias, allowed = excluded.allowed`,
        )
        .run(r.phone, r.name, r.tz, r.locale, JSON.stringify(r.languageBias), r.allowed ? 1 : 0);
    },

    /** Records a polite refusal; false when one was already sent in the last 24 h. */
    markRefused(phone: string): boolean {
      const now = clock.now();
      db.raw
        .prepare("INSERT INTO reps (phone, allowed) VALUES (?, 0) ON CONFLICT(phone) DO NOTHING")
        .run(phone);
      const res = db.raw
        .prepare("UPDATE reps SET refused_at = ? WHERE phone = ? AND (refused_at IS NULL OR refused_at <= ?)")
        .run(now, phone, now - 24 * 3_600_000);
      return Number(res.changes) === 1;
    },
  };
}

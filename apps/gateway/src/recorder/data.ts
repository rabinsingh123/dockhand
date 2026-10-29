// Read-only queries for the flight recorder (SELECT only; the recorder never writes the ledger).

import type { Db, Skill, SkillDraft } from "@dockhand/core";

type Row = Record<string, unknown>;
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function json<T>(v: unknown): T | null {
  if (typeof v !== "string" || v === "") return null;
  try {
    return JSON.parse(v) as T;
  } catch {
    return null;
  }
}

export interface RunRow {
  id: string;
  jobId: string | null;
  evalSuite: string | null;
  mode: string;
  skillName: string | null;
  skillVersion: number | null;
  portalId: string | null;
  params: Record<string, unknown> | null;
  outcome: string | null;
  errorCode: string | null;
  startedAt: number;
  endedAt: number | null;
  ms: number | null;
  costUsd: number | null;
  modelCalls: number | null;
  traceArtifactId: string | null;
  finalScreenshotId: string | null;
  extracted: Record<string, string> | null;
}

export interface StepRow {
  idx: number;
  stepId: string;
  op: string;
  status: string;
  rung: string | null;
  candidateIdx: number | null;
  ms: number;
  errorCode: string | null;
  error: string | null;
  screenshotId: string | null;
}

export interface ModelCallRow {
  ts: number;
  purpose: string;
  provider: string;
  model: string;
  stepIdx: number | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number | null;
  images: number;
  latencyMs: number;
  costUsd: number;
  status: string;
}

export interface GateRow {
  id: string;
  kind: string;
  status: string;
  body: string;
  imageArtifactId: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

export interface SkillRow {
  name: string;
  version: number;
  parentVersion: number | null;
  skill: Skill;
  active: boolean;
  changelog: string;
  source: string;
  sourceRunId: string | null;
  createdAt: number;
}

export interface DraftRow {
  id: string;
  name: string;
  draft: SkillDraft;
  jobId: string | null;
  videoArtifactId: string | null;
  status: string;
  createdAt: number;
}

const toRun = (r: Row): RunRow => ({
  id: String(r.id),
  jobId: str(r.job_id),
  evalSuite: str(r.eval_suite),
  mode: String(r.mode),
  skillName: str(r.skill_name),
  skillVersion: num(r.skill_version),
  portalId: str(r.portal_id),
  params: json(r.params_json),
  outcome: str(r.outcome),
  errorCode: str(r.error_code),
  startedAt: Number(r.started_at),
  endedAt: num(r.ended_at),
  ms: num(r.ms),
  costUsd: num(r.exec_cost_usd),
  modelCalls: num(r.model_calls),
  traceArtifactId: str(r.trace_artifact_id),
  finalScreenshotId: str(r.final_screenshot_id),
  extracted: json(r.extracted_json),
});

const toSkill = (r: Row): SkillRow | null => {
  const skill = json<Skill>(r.json);
  if (!skill) return null;
  return {
    name: String(r.name),
    version: Number(r.version),
    parentVersion: num(r.parent_version),
    skill,
    active: Number(r.active) === 1,
    changelog: String(r.changelog ?? ""),
    source: String(r.source),
    sourceRunId: str(r.source_run_id),
    createdAt: Number(r.created_at),
  };
};

const toDraft = (r: Row): DraftRow | null => {
  const draft = json<SkillDraft>(r.json);
  if (!draft) return null;
  return {
    id: String(r.id),
    name: String(r.name),
    draft,
    jobId: str(r.job_id),
    videoArtifactId: str(r.video_artifact_id),
    status: String(r.status),
    createdAt: Number(r.created_at),
  };
};

export function createRecorderData(db: Db) {
  const all = (sql: string, ...args: (string | number | null)[]) => db.raw.prepare(sql).all(...args) as Row[];
  const one = (sql: string, ...args: (string | number | null)[]) =>
    db.raw.prepare(sql).get(...args) as Row | undefined;

  return {
    runs(limit = 60): RunRow[] {
      return all("SELECT * FROM runs ORDER BY started_at DESC, rowid DESC LIMIT ?", limit).map(toRun);
    },
    run(id: string): RunRow | undefined {
      const r = one("SELECT * FROM runs WHERE id = ?", id);
      return r ? toRun(r) : undefined;
    },
    runsForSkill(name: string, limit = 40): RunRow[] {
      return all("SELECT * FROM runs WHERE skill_name = ? ORDER BY started_at DESC LIMIT ?", name, limit).map(
        toRun,
      );
    },
    steps(runId: string): StepRow[] {
      return all("SELECT * FROM run_steps WHERE run_id = ? ORDER BY idx", runId).map((r) => ({
        idx: Number(r.idx),
        stepId: String(r.step_id),
        op: String(r.op),
        status: String(r.status),
        rung: str(r.rung),
        candidateIdx: num(r.candidate_idx),
        ms: Number(r.ms),
        errorCode: str(r.error_code),
        error: str(r.error),
        screenshotId: str(r.screenshot_id),
      }));
    },
    modelCalls(runId: string): ModelCallRow[] {
      return all("SELECT * FROM model_calls WHERE run_id = ? ORDER BY ts, id", runId).map((r) => ({
        ts: Number(r.ts),
        purpose: String(r.purpose),
        provider: String(r.provider),
        model: String(r.model),
        stepIdx: num(r.step_idx),
        inputTokens: Number(r.input_tokens),
        cachedInputTokens: Number(r.cached_input_tokens),
        outputTokens: Number(r.output_tokens),
        reasoningTokens: num(r.reasoning_tokens),
        images: Number(r.images),
        latencyMs: Number(r.latency_ms),
        costUsd: Number(r.cost_usd),
        status: String(r.status),
      }));
    },
    gates(runId: string): GateRow[] {
      return all("SELECT * FROM gates WHERE run_id = ? ORDER BY created_at", runId).map((r) => ({
        id: String(r.id),
        kind: String(r.kind),
        status: String(r.status),
        body: String(r.body),
        imageArtifactId: str(r.image_artifact_id),
        createdAt: Number(r.created_at),
        resolvedAt: num(r.resolved_at),
      }));
    },
    /** Read-backs the runner kept for a run and for its canary dry runs ("<runId>-canary-c0", ...), oldest first. */
    readbacks(runId: string): { id: string; runId: string; at: number }[] {
      return all(
        "SELECT id, run_id, created_at FROM artifacts WHERE kind = 'readback' AND (run_id = ? OR run_id LIKE ?) ORDER BY created_at, rowid",
        runId,
        `${runId.replace(/[%_\\]/g, "")}-%`,
      ).map((r) => ({ id: String(r.id), runId: String(r.run_id), at: Number(r.created_at) }));
    },
    /** Open-weights picks (heal rung 2) kept for a run, oldest first. */
    picks(runId: string): { id: string; at: number }[] {
      return all(
        "SELECT id, created_at FROM artifacts WHERE kind = 'heal_pick' AND run_id = ? ORDER BY created_at, rowid",
        runId,
      ).map((r) => ({ id: String(r.id), at: Number(r.created_at) }));
    },
    /** Screenshots stored for a run, oldest first (trace steps point at the ones taken after each batch). */
    screenshots(runId: string): { id: string; at: number }[] {
      return all(
        "SELECT id, created_at FROM artifacts WHERE run_id = ? AND kind = 'screenshot' ORDER BY created_at, rowid",
        runId,
      ).map((r) => ({ id: String(r.id), at: Number(r.created_at) }));
    },
    skillNames(): {
      name: string;
      title: string;
      active: number | null;
      versions: number;
      updated: number;
    }[] {
      return all(
        `SELECT name, COUNT(*) AS versions, MAX(created_at) AS updated, MAX(CASE WHEN active = 1 THEN version END) AS active,
                (SELECT json_extract(json, '$.title') FROM skills s2 WHERE s2.name = skills.name ORDER BY version DESC LIMIT 1) AS title
         FROM skills GROUP BY name ORDER BY updated DESC`,
      ).map((r) => ({
        name: String(r.name),
        title: String(r.title ?? r.name),
        active: num(r.active),
        versions: Number(r.versions),
        updated: Number(r.updated),
      }));
    },
    skillVersions(name: string): SkillRow[] {
      return all("SELECT * FROM skills WHERE name = ? ORDER BY version", name)
        .map(toSkill)
        .filter((s): s is SkillRow => s !== null);
    },
    /** The version a run created (heal, repair, ask_rep, or the compile of a first run). */
    skillFromRun(runId: string): SkillRow | undefined {
      const r = one("SELECT * FROM skills WHERE source_run_id = ? ORDER BY version LIMIT 1", runId);
      return (r && toSkill(r)) || undefined;
    },
    skillFromDraft(draftId: string): SkillRow | undefined {
      const r = one(
        "SELECT * FROM skills WHERE json_extract(json, '$.createdFrom.draftId') = ? ORDER BY version LIMIT 1",
        draftId,
      );
      return (r && toSkill(r)) || undefined;
    },
    drafts(limit = 30): DraftRow[] {
      return all("SELECT * FROM skill_drafts ORDER BY created_at DESC LIMIT ?", limit)
        .map(toDraft)
        .filter((d): d is DraftRow => d !== null);
    },
    draft(id: string): DraftRow | undefined {
      const r = one("SELECT * FROM skill_drafts WHERE id = ?", id);
      return (r && toDraft(r)) || undefined;
    },
    /** The teach recording: the draft's own column, else a video the job received. */
    draftVideo(d: DraftRow): string | null {
      if (d.videoArtifactId) return d.videoArtifactId;
      if (!d.jobId) return null;
      const a = one(
        "SELECT id FROM artifacts WHERE job_id = ? AND mime LIKE 'video/%' ORDER BY created_at LIMIT 1",
        d.jobId,
      );
      if (a) return String(a.id);
      const m = one(
        `SELECT m.media_artifact_id AS id FROM messages m JOIN artifacts a ON a.id = m.media_artifact_id
         WHERE m.job_id = ? AND a.mime LIKE 'video/%' ORDER BY m.created_at LIMIT 1`,
        d.jobId,
      );
      return m ? String(m.id) : null;
    },
    artifact(
      id: string,
    ): { id: string; mime: string; relPath: string; bytes: number; sha256: string } | undefined {
      const r = one("SELECT id, mime, rel_path, bytes, sha256 FROM artifacts WHERE id = ?", id);
      return r
        ? {
            id: String(r.id),
            mime: String(r.mime),
            relPath: String(r.rel_path),
            bytes: Number(r.bytes),
            sha256: String(r.sha256),
          }
        : undefined;
    },
  };
}

export type RecorderData = ReturnType<typeof createRecorderData>;

// One eval case: a fresh browser context pinned to the case's UI, mutation and runId; the skill replayed
// (or, for the agentic suite, a first run from the goal with a real model); the portal's own submission log
// as ground truth. Heals are measured, never saved: no skill store is touched here.

import { runComputerUse } from "@dockhand/browser";
import {
  type ArtifactRef,
  type ArtifactStore,
  type BrowserPool,
  type ComputerUseModel,
  type CuHooks,
  createMemoryArtifactStore,
  type EvalCase,
  type EvalResult,
  type HealRung,
  type ParamValue,
  type RunHooks,
  type RunResult,
  type Skill,
  ulid,
} from "@dockhand/core";
import {
  isMutationOperator,
  type MutationConfig,
  type PortalHandle,
  type Submission,
} from "@dockhand/portals";
import { rebaseSkill, renderTemplate, renderUrlTemplate, runSkill } from "@dockhand/skills";
import type { Page } from "playwright";
import { canonicalActual, fieldBindings } from "./bindings.ts";
import { answerParamName } from "./cases.ts";
import { isFileParam, materializeFiles } from "./files.ts";
import { type EvalLedger, providerLabel } from "./ledger.ts";
import { isLocalUrl, type PortalDef, portalOfSkill, writeGuardFor } from "./portals.ts";
import type { RepairMode, RepairSetup } from "./repairers.ts";

/** One JSONL row: the contract's EvalResult plus what the summary groups by. */
export interface EvalRecord extends EvalResult {
  skill: string;
  portalId: string;
  ui: "v1" | "v2";
  operators: string[];
  expectedCategory?: EvalCase["expectedCategory"];
  repair: RepairMode;
  seed?: number;
  /** Cases running in parallel when this one ran (wall times grow with it). */
  concurrency?: number;
  error?: string;
  /** Failure screenshot (relative to var/evals), kept for failed cases only. */
  screenshot?: string;
}

export interface RunCaseDeps {
  portal: PortalHandle;
  pool: BrowserPool;
  /** The skill as compiled; its goto URLs are rebased to `portal.url` here. */
  skill: Skill;
  ledger: EvalLedger;
  repair?: RepairSetup;
  /** Required for the agentic suite: the computer-use model that does the first run. */
  agentModel?: ComputerUseModel;
  /** Where failure screenshots are kept; omitted = not kept. */
  failures?: ArtifactStore;
  stepTimeoutMs?: number;
  successTimeoutMs?: number;
  seed?: number;
  concurrency?: number;
}

const DEFAULT_STEP_TIMEOUT_MS = 5_000;
const DEFAULT_SUCCESS_TIMEOUT_MS = 15_000;

function mutationOf(c: EvalCase): MutationConfig | null {
  const m = c.portal.mutation;
  return m
    ? { seed: m.seed, ...(m.operators ? { operators: m.operators.filter(isMutationOperator) } : {}) }
    : null;
}

function autoApprove(page: Page): CuHooks["approveCommit"] {
  // Eval auto-approval works only against local portals (docs/ARCHITECTURE.md §2.4).
  return async () => (isLocalUrl(page.url()) ? "approved" : "rejected");
}

/** askRep answers from the case's extra params ("Partner tier" -> params.partner_tier), else stops safely. */
function repAnswers(answers: Record<string, ParamValue>): NonNullable<RunHooks["askRep"]> {
  return async (q) => {
    const v = answers[answerParamName(q.label)];
    return v === undefined || isFileParam(v) ? null : String(v);
  };
}

export interface Grade {
  fields: EvalResult["fields"];
  submitted: boolean;
  silentWrong: boolean;
}

const ABSENT = "(absent)";

/** Compares the run's submissions with the expected canonical fields (extra fields count as wrong). */
export function gradeSubmissions(
  expected: Record<string, string>,
  submissions: Submission[],
  fileSha: Record<string, string> = {},
): Grade {
  const sub = submissions.at(-1);
  if (!sub) {
    return {
      fields: { correct: 0, total: Object.keys(expected).length, mismatches: [] },
      submitted: false,
      silentWrong: false,
    };
  }
  const actual: Record<string, string> = {};
  for (const [k, v] of Object.entries(sub.fields)) actual[k] = canonicalActual(v);
  for (const f of sub.files ?? []) {
    const want = fileSha[f.field];
    actual[f.field] = want && want !== f.sha256 ? `${f.filename} (different bytes)` : f.filename;
  }
  const mismatches: EvalResult["fields"]["mismatches"] = [];
  let correct = 0;
  for (const [field, want] of Object.entries(expected)) {
    const got = actual[field] ?? ABSENT;
    if (got === want) correct++;
    else mismatches.push({ field, expected: want, actual: got });
  }
  for (const [field, got] of Object.entries(actual)) {
    if (!(field in expected)) mismatches.push({ field, expected: ABSENT, actual: got });
  }
  if (submissions.length > 1) {
    mismatches.push({ field: "(submissions)", expected: "1", actual: String(submissions.length) });
  }
  const extras = Object.keys(actual).filter((k) => !(k in expected)).length;
  return {
    fields: { correct, total: Object.keys(expected).length + extras, mismatches },
    submitted: true,
    silentWrong: mismatches.length > 0,
  };
}

function healsOf(r: RunResult): EvalResult["heals"] {
  const counts = new Map<HealRung, number>();
  for (const s of r.steps) {
    if (s.rung && (s.status === "healed" || s.status === "repaired" || s.status === "asked")) {
      counts.set(s.rung, (counts.get(s.rung) ?? 0) + 1);
    }
  }
  return [...counts].map(([rung, count]) => ({ rung, count }));
}

/** A must_fail_safe case expects a safe stop unless it carries the rep's answer for the inserted field. */
function expectsSafeStop(c: EvalCase, def: PortalDef): boolean {
  if (c.expectedCategory !== "must_fail_safe") return false;
  const inserted = def.insertable.filter((f) => f.insertedBy === "insert_required_field");
  return !inserted.some((f) => f.key in c.expected);
}

/** Runs one case end to end and grades it against the portal's submission log. */
export async function runCase(c: EvalCase, deps: RunCaseDeps): Promise<EvalRecord> {
  const def = portalOfSkill(deps.skill);
  const skill = rebaseSkill(deps.skill, deps.portal.url);
  const execId = `${c.id}.${ulid()}`; // ledger rows are per execution, so a re-run never sums an old one
  deps.portal.reset({ runId: c.portal.runId });
  const cookies = await deps.portal.session({
    ui: c.portal.ui,
    mutation: mutationOf(c),
    runId: c.portal.runId,
  });
  const lease = await deps.pool.lease({ portalId: def.portalId, runId: execId, cookies, ttlMs: 300_000 });
  const artifacts = createMemoryArtifactStore();
  const writeGuard = writeGuardFor(def, deps.portal.url);
  try {
    const { params: all, sha256 } = await materializeFiles(c.params, artifacts);
    const declared = new Set(skill.params.map((p) => p.name));
    const params: Record<string, ParamValue> = {};
    const answers: Record<string, ParamValue> = {};
    for (const [k, v] of Object.entries(all)) (declared.has(k) ? params : answers)[k] = v;
    const fileSha: Record<string, string> = {};
    for (const b of fieldBindings(skill, def).bindings) {
      const p = b.field.type === "file" ? b.params[0] : undefined;
      if (p && sha256[p]) fileSha[b.key] = sha256[p];
    }

    const started = performance.now();
    let outcome: RunResult["outcome"];
    let heals: EvalResult["heals"] = [];
    let errorCode: EvalResult["errorCode"];
    let error: string | undefined;
    let shot: ArtifactRef | undefined;
    if (c.suite === "agentic") {
      if (!deps.agentModel) throw new Error("the agentic suite needs a computer-use model (live Meta key)");
      const start = skill.steps.find((s) => s.op === "goto");
      await lease.page.goto(
        start?.op === "goto" ? renderUrlTemplate(start.url, params) : `${deps.portal.url}${def.startPath}`,
        { waitUntil: "load" },
      );
      const r = await runComputerUse(
        deps.agentModel,
        {
          page: lease.page,
          portalId: def.portalId,
          runId: execId,
          goal: goalFor(def, skill, params),
          guidance: [],
          params,
          attachments: Object.fromEntries(
            Object.entries(params).flatMap(([k, v]) => (isFileParam(v) ? [[k, v.file]] : [])),
          ),
          commitPolicy: "gate",
          commitHints: [],
          writeGuard,
          limits: { maxActions: 120, maxWallMs: 600_000, maxCostUsd: 3, rolloverAfterImages: 50 },
          costSoFar: () => deps.ledger.totals({ runId: execId }).costUsd,
          artifacts,
        },
        { approveCommit: autoApprove(lease.page), approveSafety: async () => "rejected" },
        { purpose: "cu_first_run", runId: execId, timeoutMs: 120_000 },
      );
      outcome = r.outcome === "done" ? "success" : r.outcome === "budget_exceeded" ? "failed" : r.outcome;
      if (r.outcome === "budget_exceeded") errorCode = "BUDGET_EXCEEDED";
      error = r.message;
      shot = r.trace.final.screenshot;
    } else {
      const r = await runSkill(
        lease.page,
        skill,
        params,
        {
          approveCommit: autoApprove(lease.page),
          approveSafety: async () => "rejected",
          askRep: repAnswers(answers),
          repairers: deps.repair?.build({ artifacts, writeGuard }) ?? [],
        },
        {
          runId: execId,
          stepTimeoutMs: deps.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
          successTimeoutMs: deps.successTimeoutMs ?? DEFAULT_SUCCESS_TIMEOUT_MS,
          screenshots: "fail_only",
          allowFallbackHeal: true,
          artifacts,
          writeGuard,
        },
      );
      outcome = r.outcome;
      heals = healsOf(r);
      errorCode = r.errorCode;
      error = r.error;
      shot = r.finalScreenshot;
    }
    const ms = Math.round(performance.now() - started);

    const grade = gradeSubmissions(c.expected, deps.portal.submissions({ runId: c.portal.runId }), fileSha);
    const safeStop =
      !grade.submitted &&
      (outcome === "failed" || outcome === "needs_input") &&
      c.expectedCategory === "must_fail_safe";
    const ok = expectsSafeStop(c, def) ? safeStop : grade.submitted && !grade.silentWrong;
    const usage = deps.ledger.usage(execId);

    let screenshot: string | undefined;
    if (!ok && shot && deps.failures) {
      const kept = await deps.failures.put(await artifacts.read(shot), shot.mime, {
        kind: "screenshot",
        runId: execId,
        filename: `${c.id}.png`,
      });
      screenshot = kept.relPath;
    }
    return {
      caseId: c.id,
      suite: c.suite,
      ok,
      outcome,
      fields: grade.fields,
      silentWrong: grade.silentWrong,
      safeStop,
      heals,
      ms,
      execCostUsd: usage.costUsd,
      modelCalls: usage.calls,
      provider: providerLabel(usage.providers),
      ...(errorCode ? { errorCode } : {}),
      skill: c.skill,
      portalId: c.portalId,
      ui: c.portal.ui,
      operators: c.portal.mutation?.operators ?? [],
      ...(c.expectedCategory ? { expectedCategory: c.expectedCategory } : {}),
      repair: c.suite === "agentic" ? "none" : (deps.repair?.mode ?? "none"),
      ...(deps.seed !== undefined ? { seed: deps.seed } : {}),
      ...(deps.concurrency !== undefined ? { concurrency: deps.concurrency } : {}),
      ...(error ? { error: error.slice(0, 400) } : {}),
      ...(screenshot ? { screenshot } : {}),
    };
  } finally {
    await lease.release();
  }
}

/** The first-run goal: the task and every value, field by field, as the form wants them typed. */
function goalFor(def: PortalDef, skill: Skill, params: Record<string, ParamValue>): string {
  const lines: string[] = [];
  for (const b of fieldBindings(skill, def).bindings) {
    if (b.params.some((p) => params[p] === undefined)) continue;
    if (b.field.type === "file") {
      const p = params[b.params[0] as string];
      if (isFileParam(p))
        lines.push(`- ${b.field.label}: attach "${p.filename}" (attach_file slot "${b.params[0]}")`);
    } else if (b.field.type === "checkbox") {
      lines.push(`- ${b.field.label}: ${b.template === "true" ? "checked" : "unchecked"}`);
    } else {
      lines.push(`- ${b.field.label}: ${renderTemplate(b.template, params)}`);
    }
  }
  return `${def.title}. Use exactly these values and leave every other field as it is:\n${lines.join("\n")}\nThen submit.`;
}

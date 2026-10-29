// Dockhand's loop on real, unmodified third-party software: EspoCRM 10 (AGPLv3), run natively by
// apps/oss/espocrm/start.ps1. The workflow creates a Lead (11 fields) and ends at Save, the commit control.
//
//   first run   Muse computer use (runComputerUse, the same input runFirstRun builds) from the goal and a
//               hand-written draft; the commit gate auto-approves only because EspoCRM is on 127.0.0.1.
//   --compile   the first successful trace is compiled like compileRun (compile, Spark annotation, two dry
//               runs) and replayed for a fresh fictional lead with no repairers: zero model calls.
//   --replay    replays a saved skill once (fresh lead) with the rungs asked for; with --drift, applies that
//               drift through EspoCRM's admin API first and reverts it afterwards.
// Ground truth: the Lead EspoCRM stored, read back field by field through its REST API.
//
// Usage: META_MODE=live tsx scripts/live/espocrm-run.ts [--runs 1] [--compile] [--draft teach-draft.json]
//          [--effort low] [--max-cost 1]
//        META_MODE=live tsx scripts/live/espocrm-run.ts --replay <skill.json> [--drift label|layout|required, comma-separated]
//          [--rungs none|open_weights|computer_use|both] [--answer "TX-48213-CW"] [--step-timeout 5000]
//        (a replay with --rungs none makes no model call; the ledger shows 0)

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createBrowserPool, runComputerUse } from "../../packages/browser/src/index.ts";
import {
  type Effort,
  type Lease,
  type ParamValue,
  type Repairer,
  type RunResult,
  type Skill,
  type SkillDraft,
  type Trace,
  ulid,
} from "../../packages/core/src/index.ts";
import { approveIfLocal } from "../../packages/evals/src/portals.ts";
import { withExamples } from "../../packages/orchestrator/src/params.ts";
import {
  annotateSkillDetailed,
  compile,
  createCuRepairer,
  createOpenWeightsRepairer,
  diffSkills,
  rebaseSkill,
  runCanary,
  runSkill,
} from "../../packages/skills/src/index.ts";
import {
  ESPO_PORTAL_ID,
  ESPO_URL,
  ensureEspoLogin,
  espoUp,
  espoWriteGuard,
  gradeLead,
  LEAD_COMMIT,
  LEAD_FIELDS,
  LEAD_SKILL,
  LEAD_START_URL,
  leadsSince,
  syntheticLead,
  waitForLeadForm,
} from "../oss/espocrm.ts";
import { DRIFTS, type DriftName, REQUIRED_DRIFT_ATTR } from "../oss/espocrm-drift.ts";
import { observeModel, openLive, type TurnLog } from "./lib.ts";

const { values } = parseArgs({
  options: {
    model: { type: "string", default: "muse-spark-1.3" },
    effort: { type: "string", default: "low" },
    runs: { type: "string", default: "1" },
    "max-cost": { type: "string", default: "1" },
    compile: { type: "boolean", default: false },
    replay: { type: "string" },
    drift: { type: "string" },
    rungs: { type: "string", default: "both" },
    answer: { type: "string" },
    draft: { type: "string" },
    seed: { type: "string", default: "1" },
    // Per-step wait before a broken step climbs the ladder (the eval harness uses 5 s).
    "step-timeout": { type: "string", default: "5000" },
    headed: { type: "boolean", default: false },
  },
});
const MAX_COST = Math.min(1, Number(values["max-cost"]));
process.env.DOCKHAND_VAR_DIR ||= join(process.cwd(), "var", "agent-oss");
const live = openLive("espocrm");
const varDir = process.env.DOCKHAND_VAR_DIR as string;
const outDir = join(varDir, "espocrm");
mkdirSync(outDir, { recursive: true });
const stateDir = join(varDir, "state");
const pool = createBrowserPool({ headless: !values.headed, maxContexts: 1, storageStateDir: stateDir });

// Without --draft: a hand-written draft (teach from a goal). With --draft: the Muse Wonder draft from
// scripts/oss/espocrm-teach.ts, its param names mapped to the adapter's (unmapped ones are left alone).
const taught = values.draft
  ? (JSON.parse(readFileSync(values.draft, "utf8")) as { draft: SkillDraft; map: Record<string, string> })
  : null;
const COMMIT = taught?.draft.commitStep || LEAD_COMMIT;
const GOAL = taught
  ? `${taught.draft.goal} Work on EspoCRM. Use exactly the values given below and leave every other field as it is. When every field is filled, ask for approval with request_commit before you click "${COMMIT}". Finish when the screen shows: ${taught.draft.success}`
  : "Create a new Lead in EspoCRM for the buyer below. Use exactly the values given and leave every other field " +
    `as it is. When every field is filled, ask for approval with request_commit before you click "${LEAD_COMMIT}". Finish when the saved lead's detail page shows.`;
const GUIDANCE = taught
  ? taught.draft.steps.map((s) =>
      s.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g, (_, n: string) =>
        taught.map[n] ? `{{${taught.map[n]}}}` : "(leave as it is)",
      ),
    )
  : [
      "On the Leads create form, type {{first_name}} into First Name and {{last_name}} into Last Name.",
      "Type {{account_name}} into Account Name.",
      "Type {{email}} into Email.",
      "Type {{title}} into Title and {{website}} into Website.",
      "In Address, type {{city}} into City and {{country}} into Country.",
      "Type {{opportunity_amount}} into Opportunity Amount.",
      "Status and Source are dropdowns: click the Status box and pick {{status}}, then the Source box and pick {{source}}.",
      `Click ${LEAD_COMMIT}.`,
    ];

async function lease(runId: string): Promise<Lease> {
  return pool.lease({ portalId: ESPO_PORTAL_ID, runId, ttlMs: 30 * 60_000 });
}

function usage(runId: string) {
  return live.db.raw
    .prepare(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(images),0) AS images, COALESCE(SUM(cost_usd),0) AS usd,
              MAX(latency_ms) AS maxMs, SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END) AS notOk
       FROM model_calls WHERE run_id LIKE ?`,
    )
    .get(`${runId}%`) as { calls: number; images: number; usd: number; maxMs: number; notOk: number };
}

async function firstRun(
  i: number,
): Promise<{ ok: boolean; trace: Trace; runId: string; params: Record<string, ParamValue> }> {
  const runId = `live-espo-${ulid()}`;
  const dir = join(outDir, runId);
  mkdirSync(dir, { recursive: true });
  const params = syntheticLead(i + Number(values.seed) * 10, runId.slice(-4).toLowerCase());
  const turnLog: TurnLog[] = [];
  const instructions: string[] = [];
  const model = observeModel(
    live.models.computerUse({ model: values.model as string, effort: values.effort as Effort }),
    turnLog,
    instructions,
  );
  const l = await lease(runId);
  const approvals: string[] = [];
  const t0 = performance.now();
  const since = Date.now();
  let res: Awaited<ReturnType<typeof runComputerUse>>;
  try {
    await l.page.goto(LEAD_START_URL, { waitUntil: "load" });
    await waitForLeadForm(l.page);
    res = await runComputerUse(
      model,
      {
        page: l.page,
        portalId: ESPO_PORTAL_ID,
        runId,
        goal: GOAL,
        guidance: GUIDANCE,
        params,
        attachments: {},
        commitPolicy: "gate",
        commitHints: [COMMIT],
        writeGuard: espoWriteGuard,
        limits: { maxActions: 60, maxWallMs: 12 * 60_000, maxCostUsd: MAX_COST, rolloverAfterImages: 20 },
        costSoFar: () => live.ledger.totals({ runId }).costUsd,
        artifacts: live.artifacts,
      },
      {
        approveCommit: async (r) => {
          approvals.push(
            `${r.summary} | readback: ${(r.readback ?? []).map((x) => `${x.label}=${x.value}`).join("; ")}`,
          );
          // Local sandbox only (fictional data): automatic and logged while the page is on a local origin.
          return approveIfLocal(l.page);
        },
        approveSafety: async () => approveIfLocal(l.page),
        progress: (p) => {
          if (p.action % 15 === 0 || p.note.startsWith("waiting"))
            console.log(`  progress ${p.action}: ${p.note}`);
        },
      },
      { purpose: "cu_first_run", jobId: "live-espocrm", runId, timeoutMs: 90_000 },
    );
    await l.page.waitForTimeout(1500);
  } finally {
    await l.release();
  }
  const seconds = (performance.now() - t0) / 1000;
  const leads = await leadsSince(since);
  const g = gradeLead(leads.at(-1), params);
  const u = usage(runId);
  const steps = res.trace.steps;
  const ok = leads.length === 1 && g.mismatches.length === 0;
  const summary = {
    runId,
    ok,
    outcome: res.outcome,
    message: res.message,
    leadsCreated: leads.length,
    fields: `${g.correct}/${g.total}`,
    mismatches: g.mismatches,
    actions: steps.filter((s) => s.action.type !== "screenshot" && s.action.type !== "fn").length,
    calls: u.calls,
    notOk: u.notOk,
    images: u.images,
    maxTurnMs: u.maxMs,
    costUsd: Number(u.usd.toFixed(4)),
    seconds: Number(seconds.toFixed(1)),
    approvals,
    finalUrl: res.trace.final.url,
  };
  writeFileSync(join(dir, "trace.json"), JSON.stringify(res.trace, null, 1));
  writeFileSync(join(dir, "turns.json"), JSON.stringify({ instructions, turnLog }, null, 1));
  writeFileSync(join(dir, "summary.json"), JSON.stringify(summary, null, 1));
  console.log(
    `first run ${i}: ${ok ? "SUCCESS" : "FAIL"} ${res.outcome} fields ${g.correct}/${g.total} leads ${leads.length} actions ${summary.actions} calls ${u.calls} $${summary.costUsd} ${seconds.toFixed(0)}s${ok ? "" : ` (${(res.message ?? "").slice(0, 160)}; ${g.mismatches.slice(0, 4).join("; ")})`}`,
  );
  return { ok, trace: res.trace, runId, params };
}

async function compileSkill(
  trace: Trace,
  runId: string,
  params: Record<string, ParamValue>,
): Promise<Skill | null> {
  const specs = LEAD_FIELDS.map((f) => f.spec);
  const { skill: body0, warnings } = compile(trace, {
    name: LEAD_SKILL,
    title: "Create a Lead in EspoCRM",
    params: specs,
    createdFrom: { kind: taught ? "video" : "goal", traceRunId: runId },
  });
  console.log(
    `compiled ${body0.steps.length} steps, ${body0.params.length} params; warnings: ${warnings.map((w) => `${w.code} ${w.detail}`).join(" | ") || "none"}`,
  );
  const report = await annotateSkillDetailed(
    { ...body0, params: withExamples(body0.params, trace.params) },
    trace,
    null,
    live.models,
    { jobId: "live-espocrm", runId, timeoutMs: 60_000 },
  );
  const renames = Object.fromEntries(
    report.applied.flatMap((line) => {
      const m = /^rename (\S+) -> (\S+)$/.exec(line);
      return m?.[1] && m[2] ? [[m[1], m[2]]] : [];
    }),
  );
  // compile() itself refuses a skill that would not write a value the first run wrote.
  const skill: Skill = { ...report.body, version: 1, parentVersion: null };
  const rename = (p: Record<string, ParamValue>) =>
    Object.fromEntries(Object.entries(p).map(([k, v]) => [renames[k] ?? k, v]));
  const sets = [rename(params), rename(syntheticLead(97, `c${runId.slice(-3).toLowerCase()}`))];
  let current: Lease | undefined;
  let n = 0;
  const canary = await runCanary(
    async () => {
      await current?.release();
      current = await lease(`${runId}-c${n++}`);
      return current.page;
    },
    rebaseSkill(skill, ESPO_URL),
    sets,
    {
      artifacts: live.artifacts,
      writeGuard: espoWriteGuard,
      stepTimeoutMs: 8_000,
      runIdFor: (i) => `${runId}-c${i}`,
    },
  );
  await current?.release();
  console.log(
    `annotate: ${report.applied.length} applied, ${report.rejected.length} rejected; canary ${canary.passed}/${canary.total}${canary.failures.length ? ` (${JSON.stringify(canary.failures).slice(0, 400)})` : ""}`,
  );
  const file = join(outDir, `${LEAD_SKILL}-v1-${runId}.json`);
  writeFileSync(file, JSON.stringify({ skill, renames, canary }, null, 1));
  console.log(`skill: ${file}`);
  return canary.passed === canary.total ? skill : null;
}

function repairers(): Repairer[] {
  const want = values.rungs as string;
  const out: Repairer[] = [];
  if ((want === "open_weights" || want === "both") && live.models.hasOpenWeights())
    out.push(
      createOpenWeightsRepairer(live.models, { model: live.config.openWeights.model, ledger: live.ledger }),
    );
  if (want === "computer_use" || want === "both")
    out.push(
      createCuRepairer({
        model: live.models.computerUse({ model: values.model as string, effort: values.effort as Effort }),
        runComputerUse,
        artifacts: live.artifacts,
        writeGuard: espoWriteGuard,
        ledger: live.ledger,
      }),
    );
  return out;
}

async function replay(skill: Skill, tag: string, ladder: Repairer[], answer: string | undefined) {
  const runId = `live-espo-r-${ulid()}`;
  const params = syntheticLead(Number(values.seed) * 31 + 7, runId.slice(-4).toLowerCase());
  // A param the rep added earlier (a healed v2's tax_id) takes the --answer value.
  for (const p of skill.params) if (!(p.name in params) && answer !== undefined) params[p.name] = answer;
  const asked: string[] = [];
  const l = await lease(runId);
  const since = Date.now();
  const t0 = performance.now();
  let r: RunResult;
  try {
    r = await runSkill(
      l.page,
      rebaseSkill(skill, ESPO_URL),
      params,
      {
        approveCommit: async () => approveIfLocal(l.page),
        approveSafety: async () => "rejected",
        askRep: async (q) => {
          asked.push(`${q.label}${q.options ? ` [${q.options.join(", ")}]` : ""}`);
          return answer ?? null;
        },
        repairers: ladder,
      },
      {
        runId,
        stepTimeoutMs: Number(values["step-timeout"]),
        successTimeoutMs: 20_000,
        screenshots: "fail_only",
        allowFallbackHeal: true,
        artifacts: live.artifacts,
        writeGuard: espoWriteGuard,
      },
    );
    await l.page.waitForTimeout(1000);
  } finally {
    await l.release();
  }
  const seconds = (performance.now() - t0) / 1000;
  const extra: Record<string, string> =
    tag.split("+").includes("required") && answer !== undefined ? { [REQUIRED_DRIFT_ATTR]: answer } : {};
  const leads = await leadsSince(since, Object.keys(extra));
  const g = gradeLead(leads.at(-1), params, extra);
  const u = usage(runId);
  const heals = r.steps
    .filter((s) => s.status !== "ok")
    .map((s) => `${s.stepId}:${s.status}${s.rung ? `/${s.rung}` : ""}`);
  console.log(
    `replay [${tag}]: ${r.outcome}${r.error ? ` (${r.errorCode}: ${r.error.slice(0, 200)})` : ""} leads ${leads.length} fields ${g.correct}/${g.total} model calls ${u.calls} $${u.usd.toFixed(4)} ${seconds.toFixed(1)}s heals ${heals.join(", ") || "none"}${asked.length ? ` asked: ${asked.join("; ")}` : ""}${g.mismatches.length && leads.length ? ` mismatches ${g.mismatches.slice(0, 4).join("; ")}` : ""}`,
  );
  const file = join(outDir, `${runId}-${tag}.json`);
  writeFileSync(file, JSON.stringify({ tag, params, result: r, leads, grade: g, asked, usage: u }, null, 1));
  if (r.patched) {
    const v2: Skill = { ...r.patched, version: skill.version + 1, parentVersion: skill.version };
    writeFileSync(
      join(outDir, `${LEAD_SKILL}-v${v2.version}-${tag}.json`),
      JSON.stringify({ skill: v2 }, null, 1),
    );
    const diff = diffSkills(skill, v2);
    console.log(`  patched -> v${v2.version}: ${JSON.stringify(diff).slice(0, 600)}`);
  }
  return { r, g, leads, u };
}

try {
  if (!(await espoUp()))
    throw new Error(`EspoCRM is not answering at ${ESPO_URL}: run apps/oss/espocrm/start.ps1`);
  const loginMs = await ensureEspoLogin(stateDir, { fresh: true });
  console.log(`EspoCRM at ${ESPO_URL}; signed in through its login page in ${loginMs} ms`);

  if (values.replay) {
    const saved = JSON.parse(readFileSync(values.replay, "utf8")) as { skill: Skill };
    // Several drifts at once: --drift label,layout (applied in order, reverted in reverse).
    const drifts = (values.drift?.split(",").filter(Boolean) ?? []) as DriftName[];
    const bad = drifts.filter((d) => !DRIFTS[d]);
    if (bad.length > 0)
      throw new Error(`unknown drift ${bad.join(", ")} (${Object.keys(DRIFTS).join(" | ")})`);
    const applied: DriftName[] = [];
    try {
      for (const d of drifts) {
        console.log(`drift ${d}: ${await DRIFTS[d].apply()}`);
        applied.push(d);
      }
      await replay(
        saved.skill,
        drifts.join("+") || "plain",
        values.rungs === "none" ? [] : repairers(),
        values.answer,
      );
    } finally {
      for (const d of applied.reverse()) console.log(`revert ${d}: ${await DRIFTS[d].revert()}`);
    }
  } else {
    for (let i = 1; i <= Number(values.runs); i++) {
      const fr = await firstRun(i);
      console.log(`spent so far (ledger): $${live.spentUsd().toFixed(4)}`);
      if (fr.ok && values.compile) {
        const skill = await compileSkill(fr.trace, fr.runId, fr.params);
        if (skill) await replay(skill, "fresh-lead", [], undefined);
        values.compile = false;
      }
    }
  }
} finally {
  await pool.closeAll();
  console.log(`\n${live.report()}`);
  live.close();
}

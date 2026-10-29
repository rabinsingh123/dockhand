// Live supplier-onboarding first run (flow 3), the way the orchestrator does it: the Acme invitation's
// Understanding plus the company kit go through buildPlan (zero-shot: no teach draft), runComputerUse gets the
// same input as runFirstRun (W-9 and COI as attach_file slots, commit gate, write guard, limits), and the
// commit gate auto-approves (local mock portal only). Ground truth: GET /api/__test/submissions?runId=.
// With --compile, a successful run is compiled like compileRun (compile, Spark annotation, two dry runs) and
// the skill is replayed on the Globex tenant with no repairers: zero model calls.
//
// Usage: META_MODE=live tsx scripts/live/supplier-run.ts [--runs 1] [--model muse-spark-1.3] [--effort low]
//          [--max-cost 1.5] [--compile] [--headed]

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type PortalHandle, startSupplierPortal } from "../../apps/portals/src/index.ts";
import { createBrowserPool, runComputerUse } from "../../packages/browser/src/index.ts";
import {
  type ArtifactRef,
  type Effort,
  type Lease,
  type ParamValue,
  type Skill,
  type Trace,
  type Understanding,
  ulid,
} from "../../packages/core/src/index.ts";
import { approveIfLocal } from "../../packages/evals/src/portals.ts";
import {
  inferSpecs,
  paramsFromProfile,
  syntheticParamSets,
  withExamples,
} from "../../packages/orchestrator/src/params.ts";
import {
  type BuildPlanContext,
  buildPlan,
  FIRST_RUN_LIMITS,
  SUPPLIER_SKILL,
} from "../../packages/orchestrator/src/plan.ts";
import { PORTAL_DEFAULTS, SUPPLIER, WRITE_GUARD_ALLOW } from "../../packages/orchestrator/src/portals.ts";
import { loadCompanyKit } from "../../packages/orchestrator/src/profile.ts";
import {
  annotateSkillDetailed,
  compile,
  rebaseSkill,
  runCanary,
  runSkill,
} from "../../packages/skills/src/index.ts";
import { fixturePath } from "../lib/files.ts";
import { observeModel, openLive, type TurnLog } from "./lib.ts";

const { values } = parseArgs({
  options: {
    model: { type: "string", default: "muse-spark-1.3" },
    effort: { type: "string" },
    runs: { type: "string", default: "1" },
    "max-cost": { type: "string", default: "1.5" },
    compile: { type: "boolean", default: false },
    headed: { type: "boolean", default: false },
    port: { type: "string", default: "5102" },
  },
});
const MAX_COST = Math.min(3, Number(values["max-cost"]));

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
      .once("error", () => resolve(false))
      .once("listening", () => srv.close(() => resolve(true)))
      .listen(port, "127.0.0.1");
  });
}

const norm = (v: unknown) =>
  String(v ?? "")
    .normalize("NFC")
    .trim();

interface Sub {
  fields: Record<string, unknown>;
  files?: { field: string; filename: string; sha256: string }[];
  tenant?: string;
  inviteCode?: string;
}

/** Field-level grade of the run's last submission against the company profile (files by filename). */
function grade(subs: Sub[], profile: Record<string, string>) {
  const sub = subs.at(-1);
  const mismatches: string[] = [];
  let total = 0;
  for (const [key, want] of Object.entries(profile)) {
    total++;
    if (key.endsWith("File")) {
      const file = sub?.files?.find((f) => f.field === key);
      const filename = want.split("/").pop();
      if (file?.filename !== filename)
        mismatches.push(`${key}: got ${file?.filename ?? "(none)"}, want ${filename}`);
    } else if (norm(sub?.fields[key]) !== norm(want)) {
      mismatches.push(`${key}: got ${JSON.stringify(sub?.fields[key])}, want ${JSON.stringify(want)}`);
    }
  }
  return { submissions: subs.length, correct: total - mismatches.length, total, mismatches };
}

const live = openLive(`supplier-${values.model}`);
const varDir = process.env.DOCKHAND_VAR_DIR as string;
let portal: PortalHandle | undefined;
const pool = createBrowserPool({
  headless: !values.headed,
  maxContexts: 1,
  storageStateDir: join(varDir, "state"),
});

async function submissions(runId: string): Promise<Sub[]> {
  return (await (
    await fetch(`${portal?.url}/api/__test/submissions?runId=${encodeURIComponent(runId)}`)
  ).json()) as Sub[];
}

async function lease(runId: string): Promise<Lease> {
  return pool.lease({
    portalId: SUPPLIER,
    runId,
    cookies: await (portal as PortalHandle).session({ runId }),
    ttlMs: 30 * 60_000,
  });
}

try {
  const wanted = Number(values.port);
  portal = await startSupplierPortal({ port: (await portFree(wanted)) ? wanted : 0 });
  console.log(`Supplier portal at ${portal.url}`);
  const kit = await loadCompanyKit(live.artifacts);
  const invitation = JSON.parse(
    readFileSync(fixturePath("inbound/acme-supplier-invitation.expected.json"), "utf8"),
  ) as {
    understanding: Understanding;
  };
  const supplierPortal = {
    ...(PORTAL_DEFAULTS[SUPPLIER] as (typeof PORTAL_DEFAULTS)[string]),
    url: portal.url,
  };
  const ctx = {
    jobId: "live-supplier",
    skills: { active: () => undefined, list: () => [], draftForPortal: () => undefined },
    rep: {
      phone: "5511999990001",
      name: "Ana Ribeiro",
      tz: "America/Sao_Paulo",
      locale: "pt-BR",
      languageBias: [],
    },
    company: kit.profile,
    attachments: [],
    clock: { now: () => Date.now() },
    portals: { [SUPPLIER]: supplierPortal },
    companyFiles: kit.files,
  } as unknown as BuildPlanContext;
  const planned = buildPlan(invitation.understanding, ctx);
  if (planned.type !== "plan") throw new Error(`buildPlan did not plan: ${JSON.stringify(planned)}`);
  const action = planned.plan.actions[0];
  if (action?.kind !== "computer_use") throw new Error(`expected a computer_use action, got ${action?.kind}`);
  const attachments: Record<string, ArtifactRef> = {};
  for (const [k, v] of Object.entries(action.params)) if (typeof v === "object") attachments[k] = v.file;

  const rows: string[] = [];
  for (let i = 1; i <= Number(values.runs); i++) {
    const runId = `live-sup-${ulid()}`;
    const dir = join(varDir, "runs", runId);
    mkdirSync(dir, { recursive: true });
    const turnLog: TurnLog[] = [];
    const instructions: string[] = [];
    const model = observeModel(
      live.models.computerUse({
        model: values.model as string,
        ...(values.effort ? { effort: values.effort as Effort } : {}),
      }),
      turnLog,
      instructions,
    );
    const l = await lease(runId);
    const approvals: string[] = [];
    let lastProgress = "";
    const t0 = performance.now();
    let res: Awaited<ReturnType<typeof runComputerUse>>;
    try {
      await l.page.goto(action.startUrl, { waitUntil: "load" });
      res = await runComputerUse(
        model,
        {
          page: l.page,
          portalId: SUPPLIER,
          runId,
          goal: action.goal,
          guidance: [],
          params: action.params,
          attachments,
          commitPolicy: "gate",
          commitHints: [],
          writeGuard: { origins: [new URL(portal.url).origin], allow: WRITE_GUARD_ALLOW[SUPPLIER] ?? [] },
          limits: {
            maxActions: FIRST_RUN_LIMITS[SUPPLIER],
            maxWallMs: 15 * 60_000,
            maxCostUsd: MAX_COST,
            rolloverAfterImages: 20,
          },
          costSoFar: () => live.ledger.totals({ runId }).costUsd,
          artifacts: live.artifacts,
        },
        {
          approveCommit: async (r) => {
            approvals.push(r.summary);
            return approveIfLocal(l.page);
          },
          approveSafety: async () => approveIfLocal(l.page),
          progress: (p) => {
            lastProgress = `${p.action}: ${p.note}`;
            if (p.action % 20 === 0 || p.note.startsWith("waiting"))
              console.log(`  progress ${lastProgress}`);
          },
        },
        { purpose: "cu_first_run", jobId: "live-supplier", runId, timeoutMs: 90_000 },
      );
    } finally {
      await l.release();
    }
    const seconds = (performance.now() - t0) / 1000;
    const g = grade(await submissions(runId), kit.profile);
    const steps = res.trace.steps;
    const usage = live.db.raw
      .prepare(
        `SELECT COUNT(*) AS calls, COALESCE(SUM(images),0) AS images, COALESCE(SUM(cost_usd),0) AS usd,
                MAX(latency_ms) AS maxMs, SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END) AS notOk
         FROM model_calls WHERE run_id = ?`,
      )
      .get(runId) as Record<string, number>;
    const ok = g.submissions === 1 && g.mismatches.length === 0;
    const summary = {
      runId,
      ok,
      outcome: res.outcome,
      message: res.message,
      ...g,
      actions: steps.filter((s) => s.action.type !== "screenshot" && s.action.type !== "fn").length,
      fnCalls: steps.filter((s) => s.action.type === "fn").map((s) => (s.action as { name: string }).name),
      blocked: steps.filter((s) => s.tags.includes("blocked")).length,
      calls: usage.calls,
      notOk: usage.notOk,
      maxTurnMs: usage.maxMs,
      rollovers: turnLog.filter((t) => t.reply === "rollover").length,
      costUsd: Number((usage.usd ?? 0).toFixed(4)),
      seconds: Number(seconds.toFixed(1)),
      approvals,
      finalUrl: res.trace.final.url,
    };
    writeFileSync(join(dir, "trace.json"), JSON.stringify(res.trace, null, 1));
    writeFileSync(join(dir, "turns.json"), JSON.stringify({ instructions, turnLog }, null, 1));
    writeFileSync(join(dir, "summary.json"), JSON.stringify(summary, null, 1));
    rows.push(
      `run ${i}: ${ok ? "SUCCESS" : "FAIL"} ${res.outcome} fields ${g.correct}/${g.total} actions ${summary.actions} calls ${usage.calls} rollovers ${summary.rollovers} $${summary.costUsd} ${seconds.toFixed(0)}s max turn ${usage.maxMs} ms${ok ? "" : ` (${(res.message ?? "").slice(0, 120)}; ${g.mismatches.slice(0, 4).join("; ")})`}`,
    );
    console.log(rows.at(-1));
    console.log(`spent so far (ledger): $${live.spentUsd().toFixed(4)}`);

    if (ok && values.compile) await compileAndReplay(res.trace, runId, action.params, kit);
  }
  console.log(`\n${rows.join("\n")}`);
} finally {
  await pool.closeAll();
  await portal?.close();
  console.log(`\n${live.report()}`);
  live.close();
}

/** compileRun's pipeline, then the Globex replay with no repairers (no model can be called). */
async function compileAndReplay(
  trace: Trace,
  runId: string,
  params: Record<string, ParamValue>,
  kit: Awaited<ReturnType<typeof loadCompanyKit>>,
): Promise<void> {
  const p = portal as PortalHandle;
  const writeGuard = { origins: [new URL(p.url).origin], allow: WRITE_GUARD_ALLOW[SUPPLIER] ?? [] };
  const { skill: body0, warnings } = compile(trace, {
    name: SUPPLIER_SKILL,
    title: "Supplier Portal task",
    params: inferSpecs(params),
    createdFrom: { kind: "goal", traceRunId: runId },
  });
  console.log(
    `compiled ${body0.steps.length} steps, ${body0.params.length} params, ${warnings.length} warnings`,
  );
  const report = await annotateSkillDetailed(
    { ...body0, params: withExamples(body0.params, trace.params) },
    trace,
    null,
    live.models,
    { jobId: "live-supplier", runId, timeoutMs: 45_000 },
  );
  const renames = Object.fromEntries(
    report.applied.flatMap((line) => {
      const m = /^rename (\S+) -> (\S+)$/.exec(line);
      return m?.[1] && m[2] ? [[m[1], m[2]]] : [];
    }),
  );
  const skill: Skill = { ...report.body, version: 1, parentVersion: null };
  const firstValues = Object.fromEntries(Object.entries(params).map(([k, v]) => [renames[k] ?? k, v]));
  const sets = [firstValues, ...syntheticParamSets(skill, firstValues, 1)];
  let current: { release(): Promise<void> } | undefined;
  let n = 0;
  const canary = await runCanary(
    async () => {
      await current?.release();
      const l = await lease(`${runId}-c${n++}`);
      current = l;
      return l.page;
    },
    rebaseSkill(skill, p.url),
    sets,
    { artifacts: live.artifacts, writeGuard, stepTimeoutMs: 5_000, runIdFor: (i) => `${runId}-c${i}` },
  );
  await current?.release();
  console.log(
    `annotate: ${report.applied.length} applied, ${report.rejected.length} rejected; canary ${canary.passed}/${canary.total}${canary.failures.length ? ` (${JSON.stringify(canary.failures).slice(0, 300)})` : ""}`,
  );
  writeFileSync(join(varDir, "runs", runId, "skill.json"), JSON.stringify(skill, null, 1));

  const m = paramsFromProfile(skill.params, kit.profile, {
    tenant: "globex",
    inviteCode: "GLOBEX-2048",
    files: kit.files,
  });
  if (m.missing.length > 0) console.log(`globex params missing: ${m.missing.map((s) => s.name).join(", ")}`);
  const globexRun = `${runId}-globex`;
  const l = await lease(globexRun);
  const t0 = performance.now();
  try {
    const r = await runSkill(
      l.page,
      rebaseSkill(skill, p.url),
      m.params,
      {
        approveCommit: async () => approveIfLocal(l.page),
        approveSafety: async () => "rejected",
        askRep: async () => null,
      },
      {
        runId: globexRun,
        stepTimeoutMs: 5_000,
        successTimeoutMs: 15_000,
        screenshots: "fail_only",
        allowFallbackHeal: true,
        artifacts: live.artifacts,
        writeGuard,
      },
    );
    const g = grade(await submissions(globexRun), kit.profile);
    const calls = live.ledger.totals({ runId: globexRun }).calls;
    const heals = r.steps.filter((s) => s.status === "healed").map((s) => `${s.stepId}:${s.rung}`);
    console.log(
      `globex replay: ${r.outcome}${r.error ? ` (${r.error.slice(0, 160)})` : ""} fields ${g.correct}/${g.total} model calls ${calls} ${((performance.now() - t0) / 1000).toFixed(1)}s heals ${heals.join(", ") || "none"}${g.mismatches.length ? ` mismatches ${g.mismatches.slice(0, 5).join("; ")}` : ""}`,
    );
  } finally {
    await l.release();
  }
}

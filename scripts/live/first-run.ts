// Live computer-use first run on Caravela Partner Hub, the way the orchestrator does it (runFirstRun in
// packages/orchestrator/src/flows/browser.ts): buildPlan turns the referral's Understanding plus the teach
// draft into a computer_use action, a fresh leased context opens the start URL, runComputerUse runs with the
// same input (guidance = draft steps, commit gate, write guard, limits), and the commit gate auto-approves
// (local mock portal only). Ground truth: the portal's GET /api/__test/submissions?runId=.
//
// Usage: META_MODE=live tsx scripts/live/first-run.ts [--model muse-spark-1.3] [--effort low] [--runs 1]
//          [--ui v1|v2] [--max-cost 1.5] [--headed] [--draft path/to/draft.json] [--rollover 20]

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type PortalHandle, startPartnerPortal } from "../../apps/portals/src/index.ts";
import { createBrowserPool, runComputerUse } from "../../packages/browser/src/index.ts";
import {
  type ComputerUseModel,
  type CuSession,
  type Effort,
  type SkillDraft,
  type Understanding,
  ulid,
} from "../../packages/core/src/index.ts";
import { type BuildPlanContext, buildPlan, FIRST_RUN_LIMITS } from "../../packages/orchestrator/src/plan.ts";
import { CARAVELA, PORTAL_DEFAULTS, WRITE_GUARD_ALLOW } from "../../packages/orchestrator/src/portals.ts";
import { fixturePath } from "../lib/files.ts";
import { openLive } from "./lib.ts";

const { values } = parseArgs({
  options: {
    model: { type: "string", default: "muse-spark-1.3" },
    effort: { type: "string" },
    runs: { type: "string", default: "1" },
    ui: { type: "string", default: "v1" },
    "max-cost": { type: "string", default: "1.5" },
    rollover: { type: "string", default: "20" },
    headed: { type: "boolean", default: false },
    draft: { type: "string" },
    referral: { type: "string", default: "inbound/referral-cafe-aurora.expected.json" },
    port: { type: "string", default: "5101" },
    // approved (default) | rejected: what the commit gate answers; rejected checks that nothing is submitted.
    commit: { type: "string", default: "approved" },
  },
});
const MAX_COST = Math.min(3, Number(values["max-cost"]));

interface TurnLog {
  at: number;
  ms: number;
  reply: string;
  note?: string;
  output?: string;
  summary?: string;
  imagesInChain: number;
  turns: unknown;
  error?: string;
}

/** Wraps a computer-use model so every turn (reply sent, items returned) lands in a log. */
function observe(model: ComputerUseModel, log: TurnLog[], instructions: string[]): ComputerUseModel {
  return {
    provider: model.provider,
    model: model.model,
    open(o) {
      instructions.push(o.instructions);
      const s: CuSession = model.open(o);
      return {
        imagesInChain: () => s.imagesInChain(),
        async send(reply, ctx) {
          const t0 = Date.now();
          const entry: TurnLog = {
            at: t0,
            ms: 0,
            reply: reply.kind,
            imagesInChain: 0,
            turns: null,
            ...(reply.kind === "computer_output" && reply.note ? { note: reply.note } : {}),
            ...(reply.kind === "function_output" ? { output: reply.output } : {}),
            ...(reply.kind === "rollover" ? { summary: reply.summary } : {}),
          };
          log.push(entry);
          try {
            const turns = await s.send(reply, ctx);
            entry.turns = turns;
            return turns;
          } catch (err) {
            entry.error = (err as Error).message;
            throw err;
          } finally {
            entry.ms = Date.now() - t0;
            entry.imagesInChain = s.imagesInChain();
          }
        },
      };
    },
  };
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
      .once("error", () => resolve(false))
      .once("listening", () => srv.close(() => resolve(true)))
      .listen(port, "127.0.0.1");
  });
}

function norm(v: unknown): string {
  return String(v ?? "")
    .normalize("NFC")
    .trim();
}

const live = openLive(`first-run-${values.model}`);
let portal: PortalHandle | undefined;
const pool = createBrowserPool({
  headless: !values.headed,
  maxContexts: 1,
  storageStateDir: join(process.env.DOCKHAND_VAR_DIR as string, "state"),
});

try {
  const wanted = Number(values.port);
  const port = (await portFree(wanted)) ? wanted : 0;
  portal = await startPartnerPortal({ port, version: values.ui === "v2" ? "v2" : "v1" });
  console.log(`Caravela Partner Hub at ${portal.url}${port === 0 ? ` (port ${wanted} was busy)` : ""}`);

  const draft: SkillDraft = values.draft
    ? ((JSON.parse(readFileSync(values.draft, "utf8")) as { draft?: SkillDraft } & SkillDraft).draft ??
      (JSON.parse(readFileSync(values.draft, "utf8")) as SkillDraft))
    : (
        JSON.parse(readFileSync(fixturePath("teach/caravela-register-deal.expected.json"), "utf8")) as {
          draft: SkillDraft;
        }
      ).draft;
  const referral = JSON.parse(readFileSync(fixturePath(values.referral as string), "utf8")) as {
    understanding: Understanding;
    partnerPortalSubmission: Record<string, unknown>;
  };

  const portals = {
    [CARAVELA]: { ...(PORTAL_DEFAULTS[CARAVELA] as (typeof PORTAL_DEFAULTS)[string]), url: portal.url },
  };
  const ctx = {
    jobId: "live-first-run",
    skills: {
      active: () => undefined,
      list: () => [],
      draftForPortal: (id: string) => (id === CARAVELA ? { id: "draft-live", draft } : undefined),
    },
    rep: {
      phone: "5511999990001",
      name: "Ana Ribeiro",
      tz: "America/Sao_Paulo",
      locale: "pt-BR",
      languageBias: [],
    },
    company: {},
    attachments: [],
    clock: { now: () => Date.now() },
    portals,
    companyFiles: {},
  } as unknown as BuildPlanContext;
  const planned = buildPlan(referral.understanding, ctx);
  if (planned.type !== "plan") throw new Error(`buildPlan did not plan: ${JSON.stringify(planned)}`);
  const action = planned.plan.actions[0];
  if (action?.kind !== "computer_use") throw new Error(`expected a computer_use action, got ${action?.kind}`);

  const runs = Number(values.runs);
  const rows: string[] = [];
  for (let i = 1; i <= runs; i++) {
    const runId = `live-fr-${ulid()}`;
    const dir = join(process.env.DOCKHAND_VAR_DIR as string, "runs", runId);
    mkdirSync(dir, { recursive: true });
    const turnLog: TurnLog[] = [];
    const instructions: string[] = [];
    const model = observe(
      live.models.computerUse({
        model: values.model as string,
        ...(values.effort ? { effort: values.effort as Effort } : {}),
      }),
      turnLog,
      instructions,
    );
    const lease = await pool.lease({
      portalId: CARAVELA,
      runId,
      cookies: await portal.session({ runId }),
      ttlMs: 30 * 60_000,
    });
    const approvals: string[] = [];
    const safety: unknown[] = [];
    const t0 = performance.now();
    let res: Awaited<ReturnType<typeof runComputerUse>>;
    try {
      await lease.page.goto(action.startUrl, { waitUntil: "load" });
      res = await runComputerUse(
        model,
        {
          page: lease.page,
          portalId: CARAVELA,
          runId,
          goal: action.goal,
          guidance: draft.steps,
          params: action.params,
          attachments: {},
          commitPolicy: "gate",
          commitHints: draft.commitStep ? [draft.commitStep] : [],
          writeGuard: { origins: [new URL(portal.url).origin], allow: WRITE_GUARD_ALLOW[CARAVELA] ?? [] },
          limits: {
            maxActions: FIRST_RUN_LIMITS[CARAVELA],
            maxWallMs: 15 * 60_000,
            maxCostUsd: MAX_COST,
            rolloverAfterImages: Number(values.rollover),
          },
          costSoFar: () => live.ledger.totals({ runId }).costUsd,
          artifacts: live.artifacts,
        },
        {
          approveCommit: async (r) => {
            approvals.push(
              `${r.summary} | readback: ${(r.readback ?? []).map((x) => `${x.label}=${x.value}`).join("; ")}`,
            );
            return values.commit === "rejected" ? "rejected" : "approved";
          },
          approveSafety: async (r) => {
            safety.push(r.checks);
            return "approved";
          },
          progress: (p) => console.log(`  progress: action ${p.action}, ${p.note}`),
        },
        { purpose: "cu_first_run", jobId: "live-first-run", runId, timeoutMs: 120_000 },
      );
    } finally {
      await lease.release();
    }
    const seconds = (performance.now() - t0) / 1000;

    const subs = (await (
      await fetch(`${portal.url}/api/__test/submissions?runId=${encodeURIComponent(runId)}`)
    ).json()) as {
      fields: Record<string, unknown>;
    }[];
    const want = referral.partnerPortalSubmission;
    const got = subs.at(-1)?.fields ?? {};
    const mismatches = Object.entries(want)
      .filter(([k, v]) => norm(got[k]) !== norm(v))
      .map(([k, v]) => `${k}: got ${JSON.stringify(got[k])}, want ${JSON.stringify(v)}`);
    const extras = Object.keys(got).filter(
      (k) => !(k in want) && got[k] !== "" && got[k] !== null && got[k] !== false,
    );
    const correct = Object.keys(want).length - mismatches.length;
    const steps = res.trace.steps;
    const actions = steps.filter((s) => s.action.type !== "screenshot" && s.action.type !== "fn").length;
    const usage = live.db.raw
      .prepare(
        `SELECT COUNT(*) AS calls, COALESCE(SUM(images),0) AS images, COALESCE(SUM(cost_usd),0) AS usd,
                COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(cached_input_tokens),0) AS cached,
                COALESCE(SUM(output_tokens),0) AS output, COALESCE(SUM(reasoning_tokens),0) AS reasoning,
                SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END) AS notOk
         FROM model_calls WHERE run_id = ?`,
      )
      .get(runId) as Record<string, number>;
    const rollovers = turnLog.filter((t) => t.reply === "rollover").length;
    const blocked = steps.filter((s) => s.tags.includes("blocked")).length;
    const ok =
      values.commit === "rejected"
        ? subs.length === 0 && res.outcome === "rejected" && approvals.length === 1
        : subs.length === 1 && mismatches.length === 0;

    writeFileSync(join(dir, "trace.json"), JSON.stringify(res.trace, null, 1));
    writeFileSync(
      join(dir, "turns.json"),
      JSON.stringify({ instructions, turnLog, approvals, safety }, null, 1),
    );
    const summary = {
      runId,
      model: values.model,
      effort: values.effort ?? "(api default)",
      ok,
      outcome: res.outcome,
      message: res.message,
      submissions: subs.length,
      fields: `${correct}/${Object.keys(want).length}`,
      mismatches,
      extras,
      actions,
      steps: steps.length,
      blocked,
      calls: usage.calls,
      notOk: usage.notOk,
      images: usage.images,
      rollovers,
      tokens: { input: usage.input, cached: usage.cached, output: usage.output, reasoning: usage.reasoning },
      costUsd: Number(usage.usd?.toFixed(4)),
      seconds: Number(seconds.toFixed(1)),
      approvals,
      safety,
      finalUrl: res.trace.final.url,
    };
    writeFileSync(join(dir, "summary.json"), JSON.stringify(summary, null, 1));
    console.log(JSON.stringify(summary, null, 1));
    rows.push(
      `${values.model} ${values.effort ?? "default"} run ${i}: ${ok ? "SUCCESS" : "FAIL"} ${res.outcome} fields ${correct}/${Object.keys(want).length} actions ${actions} calls ${usage.calls} images ${usage.images} rollovers ${rollovers} $${usage.usd?.toFixed(3)} ${seconds.toFixed(0)}s${ok ? "" : ` (${(res.message ?? mismatches.join("; ")).slice(0, 160)})`}`,
    );
    console.log(`spent so far (ledger): $${live.spentUsd().toFixed(4)}`);
  }
  console.log(`\n${rows.join("\n")}`);
} finally {
  await pool.closeAll();
  await portal?.close();
  console.log(`\n${live.report()}`);
  live.close();
}

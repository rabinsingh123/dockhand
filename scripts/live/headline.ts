// The real-model evals behind the headline chart. Every number comes from live Meta
// and Baseten calls (provider meta/baseten in the ledger); scripted and cassette runs are refused.
//
//   firstruns --k 8 [--goal-only]   fresh Caravela first runs (orchestrator path: buildPlan + runComputerUse)
//   compile                         compile the first successful video-guided run (compile, annotate, 2 dry runs)
//   replays --n 50 [--seed 201]     the compiled skill on randomized params, jittered latency, no repairers
//   heal --seeds 101,102,103        the mutation suite on the compiled skill with live rungs 2 and 3
//   report                          summaries + charts into evals/results/
//
// Usage: META_MODE=live tsx scripts/live/headline.ts <command> [options]
// Raw rows: evals/results/live/*.jsonl. Ledgers: var/agent-live/{dockhand,evals}.sqlite.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type PortalHandle, startPartnerPortal } from "../../apps/portals/src/index.ts";
import { createBrowserPool, runComputerUse } from "../../packages/browser/src/index.ts";
import {
  type EvalSuite,
  type Lease,
  type ParamSpec,
  type ParamValue,
  type Repairer,
  Skill,
  SkillDraft,
  type Trace,
  type Understanding,
  ulid,
  workspaceRoot,
} from "../../packages/core/src/index.ts";
import {
  createEvalLedger,
  type EvalRecord,
  generateCases,
  mutationChartHtml,
  portalDef,
  type RunCaseDeps,
  renderChart,
  runCase,
} from "../../packages/evals/src/index.ts";
import { approveIfLocal } from "../../packages/evals/src/portals.ts";
import { inferSpecs, syntheticParamSets, withExamples } from "../../packages/orchestrator/src/params.ts";
import { type BuildPlanContext, buildPlan, FIRST_RUN_LIMITS } from "../../packages/orchestrator/src/plan.ts";
import { CARAVELA, PORTAL_DEFAULTS, WRITE_GUARD_ALLOW } from "../../packages/orchestrator/src/portals.ts";
import {
  annotateSkillDetailed,
  compile,
  createCuRepairer,
  createOpenWeightsRepairer,
  rebaseSkill,
  runCanary,
} from "../../packages/skills/src/index.ts";
import { fixturePath } from "../lib/files.ts";
import { type Live, openLive } from "./lib.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    k: { type: "string", default: "8" },
    "goal-only": { type: "boolean", default: false },
    n: { type: "string", default: "50" },
    seed: { type: "string", default: "201" },
    seeds: { type: "string", default: "101,102,103" },
  },
});
const command = positionals[0] ?? "report";
const MODEL = "muse-spark-1.3";
const RESULTS = join(workspaceRoot(), "evals", "results");
const RAW = join(RESULTS, "live");
mkdirSync(RAW, { recursive: true });
const HEADLINE = join(workspaceRoot(), "var", "agent-live", "headline");
mkdirSync(HEADLINE, { recursive: true });
const SKILL_FILE = join(HEADLINE, "caravela-skill.json");
const today = new Date().toISOString().slice(0, 10);

const norm = (v: unknown) =>
  String(v ?? "")
    .normalize("NFC")
    .trim();

function readJsonl<T>(prefix: string): T[] {
  return readdirSync(RAW)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".jsonl"))
    .flatMap((f) =>
      readFileSync(join(RAW, f), "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as T),
    );
}

function assertLive(live: Live): void {
  if (live.config.meta.mode !== "live") throw new Error("headline evals run only with META_MODE=live");
}

/** The live Wonder draft recorded from the teach video (fixtures/cassettes/teach), as the gateway returns it. */
function liveTeachDraft(): SkillDraft {
  const dir = join(workspaceRoot(), "fixtures", "cassettes", "teach");
  const file = readdirSync(dir).find((f) => f.endsWith(".json"));
  if (!file) throw new Error("no teach cassette");
  const resp = (
    JSON.parse(readFileSync(join(dir, file), "utf8")) as { exchanges: { response: unknown }[] }
  ).exchanges.at(-1)?.response as {
    output: { type: string; phase?: string; content?: { text: string }[] }[];
  };
  const text =
    resp.output.find((o) => o.type === "message" && o.phase !== "commentary")?.content?.[0]?.text ?? "";
  const dropNulls = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(dropNulls)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .filter(([, x]) => x !== null)
              .map(([k, x]) => [k, dropNulls(x)]),
          )
        : v;
  return SkillDraft.parse(dropNulls(JSON.parse(text)));
}

// ---------- first runs ----------

interface FirstRunRow {
  kind: "first_run";
  provider: "meta";
  model: string;
  effort: "low";
  guidance: "video" | "goal";
  runId: string;
  date: string;
  ok: boolean;
  outcome: string;
  fields: string;
  actions: number;
  calls: number;
  costUsd: number;
  seconds: number;
  message?: string;
}

async function firstRuns(): Promise<void> {
  const live = openLive("headline-firstruns");
  assertLive(live);
  const goalOnly = values["goal-only"];
  // A fresh portal per run: a registration left by an earlier run on the same portal let the model "finish"
  // by opening that one (seen live), so runs never share portal state.
  let portal = await startPartnerPortal({ port: 0 });
  const pool = createBrowserPool({
    headless: true,
    maxContexts: 1,
    storageStateDir: join(HEADLINE, "state"),
  });
  const out = join(RAW, `firstrun-caravela-${goalOnly ? "goal" : "video"}-${today}.jsonl`);
  try {
    const draft = liveTeachDraft();
    const referral = JSON.parse(
      readFileSync(fixturePath("inbound/referral-cafe-aurora.expected.json"), "utf8"),
    ) as {
      understanding: Understanding;
      partnerPortalSubmission: Record<string, unknown>;
    };
    const ctx = {
      jobId: "headline",
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
      portals: {
        [CARAVELA]: { ...(PORTAL_DEFAULTS[CARAVELA] as (typeof PORTAL_DEFAULTS)[string]), url: portal.url },
      },
      companyFiles: {},
    } as unknown as BuildPlanContext;
    const planned = buildPlan(referral.understanding, ctx);
    if (planned.type !== "plan")
      throw new Error(`buildPlan did not plan: ${JSON.stringify(planned).slice(0, 300)}`);
    const action = planned.plan.actions[0];
    if (action?.kind !== "computer_use") throw new Error("expected a computer_use action");
    // Goal-only: the same values and commit rule, no steps from the video.
    const goal = goalOnly
      ? "Register this end customer's deal on Caravela Partner Hub. Use exactly the values given below. When every field is filled, ask for approval with request_commit before you submit. Finish when the screen shows the registration confirmation with its registration ID."
      : action.goal;
    for (let i = 1; i <= Number(values.k); i++) {
      if (i > 1) {
        await portal.close();
        portal = await startPartnerPortal({ port: 0 });
      }
      const runId = `hl-${goalOnly ? "goal" : "video"}-${ulid()}`;
      const lease = await pool.lease({
        portalId: CARAVELA,
        runId,
        cookies: await portal.session({ runId }),
        ttlMs: 30 * 60_000,
      });
      const t0 = performance.now();
      let res: Awaited<ReturnType<typeof runComputerUse>>;
      try {
        await lease.page.goto(`${portal.url}${new URL(action.startUrl).pathname}`, { waitUntil: "load" });
        res = await runComputerUse(
          live.models.computerUse({ model: MODEL }),
          {
            page: lease.page,
            portalId: CARAVELA,
            runId,
            goal,
            guidance: goalOnly ? [] : draft.steps,
            params: action.params,
            attachments: {},
            commitPolicy: "gate",
            commitHints: goalOnly ? [] : [draft.commitStep],
            writeGuard: { origins: [new URL(portal.url).origin], allow: WRITE_GUARD_ALLOW[CARAVELA] ?? [] },
            limits: {
              maxActions: FIRST_RUN_LIMITS[CARAVELA],
              maxWallMs: 15 * 60_000,
              maxCostUsd: 1.5,
              rolloverAfterImages: 20,
            },
            costSoFar: () => live.ledger.totals({ runId }).costUsd,
            artifacts: live.artifacts,
          },
          {
            approveCommit: async () => approveIfLocal(lease.page),
            approveSafety: async () => approveIfLocal(lease.page),
          },
          { purpose: "cu_first_run", jobId: "headline", runId, timeoutMs: 90_000 },
        );
      } finally {
        await lease.release();
      }
      const seconds = (performance.now() - t0) / 1000;
      const subs = (await (await fetch(`${portal.url}/api/__test/submissions?runId=${runId}`)).json()) as {
        fields: Record<string, unknown>;
      }[];
      const want = referral.partnerPortalSubmission;
      const got = subs.at(-1)?.fields ?? {};
      const wrong = Object.entries(want).filter(([k, v]) => norm(got[k]) !== norm(v)).length;
      const t = live.ledger.totals({ runId });
      const real = live.db.raw
        .prepare("SELECT COUNT(*) AS n FROM model_calls WHERE run_id = ? AND provider = 'meta'")
        .get(runId) as { n: number };
      if (real.n !== t.calls) throw new Error(`run ${runId} has non-live ledger rows`);
      const row: FirstRunRow = {
        kind: "first_run",
        provider: "meta",
        model: MODEL,
        effort: "low",
        guidance: goalOnly ? "goal" : "video",
        runId,
        date: today,
        ok: subs.length === 1 && wrong === 0,
        outcome: res.outcome,
        fields: `${Object.keys(want).length - wrong}/${Object.keys(want).length}`,
        actions: res.trace.steps.filter((s) => s.action.type !== "screenshot" && s.action.type !== "fn")
          .length,
        calls: t.calls,
        costUsd: Number(t.costUsd.toFixed(4)),
        seconds: Number(seconds.toFixed(1)),
        ...(res.message ? { message: res.message.slice(0, 200) } : {}),
      };
      appendFileSync(out, `${JSON.stringify(row)}\n`);
      writeFileSync(
        join(HEADLINE, `${runId}.trace.json`),
        JSON.stringify({ trace: res.trace, params: action.params }),
      );
      console.log(
        `${row.guidance} ${i}: ${row.ok ? "ok" : "FAIL"} ${row.outcome} fields ${row.fields} actions ${row.actions} calls ${row.calls} $${row.costUsd} ${row.seconds}s`,
      );
    }
  } finally {
    await pool.closeAll();
    await portal.close();
    console.log(`spent (ledger, all live): $${live.spentUsd().toFixed(3)}`);
    live.close();
  }
}

// ---------- compile ----------

interface CompileRow {
  kind: "compile";
  provider: "meta";
  fromRunId: string;
  date: string;
  steps: number;
  params: number;
  annotateCostUsd: number;
  canary: string;
  ok: boolean;
}

async function compileFirst(): Promise<void> {
  const live = openLive("headline-compile");
  assertLive(live);
  const first = readJsonl<FirstRunRow>("firstrun-caravela-video").find((r) => r.ok);
  if (!first) throw new Error("no successful video-guided first run to compile");
  const { trace, params } = JSON.parse(readFileSync(join(HEADLINE, `${first.runId}.trace.json`), "utf8")) as {
    trace: Trace;
    params: Record<string, ParamValue>;
  };
  const draft = liveTeachDraft();
  const specs: ParamSpec[] = [...draft.params];
  for (const s of inferSpecs(params)) if (!specs.some((p) => p.name === s.name)) specs.push(s);
  const { skill: body0 } = compile(trace, {
    name: draft.name,
    title: draft.title,
    params: specs,
    createdFrom: { kind: "video", traceRunId: first.runId },
  });
  const before = live.ledger.totals({ runId: first.runId }).costUsd;
  const report = await annotateSkillDetailed(
    { ...body0, params: withExamples(body0.params, trace.params) },
    trace,
    draft,
    live.models,
    { jobId: "headline", runId: first.runId, timeoutMs: 90_000 },
  );
  const annotateCostUsd = live.ledger.totals({ runId: first.runId }).costUsd - before;
  const renames = Object.fromEntries(
    report.applied.flatMap((line) => {
      const m = /^rename (\S+) -> (\S+)$/.exec(line);
      return m?.[1] && m[2] ? [[m[1], m[2]]] : [];
    }),
  );
  const skill = Skill.parse({ ...report.body, version: 1, parentVersion: null });
  const firstValues = Object.fromEntries(Object.entries(params).map(([k, v]) => [renames[k] ?? k, v]));
  const portal = await startPartnerPortal({ port: 0 });
  const pool = createBrowserPool({
    headless: true,
    maxContexts: 1,
    storageStateDir: join(HEADLINE, "state"),
  });
  let current: Lease | undefined;
  let n = 0;
  try {
    const canary = await runCanary(
      async () => {
        await current?.release();
        const id = `${first.runId}-c${n++}`;
        current = await pool.lease({
          portalId: CARAVELA,
          runId: id,
          cookies: await portal.session({ runId: id }),
          ttlMs: 600_000,
        });
        return current.page;
      },
      rebaseSkill(skill, portal.url),
      [firstValues, ...syntheticParamSets(skill, firstValues, 1)],
      {
        artifacts: live.artifacts,
        writeGuard: { origins: [new URL(portal.url).origin], allow: WRITE_GUARD_ALLOW[CARAVELA] ?? [] },
        stepTimeoutMs: 5_000,
        runIdFor: (i) => `${first.runId}-c${i}`,
      },
    );
    await current?.release();
    const row: CompileRow = {
      kind: "compile",
      provider: "meta",
      fromRunId: first.runId,
      date: today,
      steps: skill.steps.length,
      params: skill.params.length,
      annotateCostUsd: Number(annotateCostUsd.toFixed(4)),
      canary: `${canary.passed}/${canary.total}`,
      ok: canary.passed === canary.total,
    };
    writeFileSync(join(RAW, `compile-caravela-${today}.jsonl`), `${JSON.stringify(row)}\n`);
    if (row.ok) writeFileSync(SKILL_FILE, JSON.stringify(skill, null, 1));
    console.log(JSON.stringify(row));
  } finally {
    await pool.closeAll();
    await portal.close();
    live.close();
  }
}

// ---------- replays and heals (eval harness) ----------

async function evalSuite(suite: EvalSuite, seeds: number[], n: number, withRepair: boolean): Promise<void> {
  const live = openLive(`headline-${suite}`);
  assertLive(live);
  if (!existsSync(SKILL_FILE)) throw new Error("run `compile` first");
  const skill = Skill.parse(JSON.parse(readFileSync(SKILL_FILE, "utf8")));
  const db = live.db;
  const ledger = createEvalLedger(db);
  const def = portalDef("caravela");
  const portal: PortalHandle = await def.start({ latencyMs: [50, 400] });
  const pool = createBrowserPool({
    headless: true,
    maxContexts: 1,
    storageStateDir: join(HEADLINE, "state"),
  });
  if (withRepair && !live.models.hasOpenWeights()) throw new Error("rung 2 needs BASETEN_API_KEY");
  try {
    for (const seed of seeds) {
      const out = join(RAW, `${suite}-caravela-live-s${seed}.jsonl`);
      const cases = generateCases(suite, skill, n, seed, { today: portal.config().serverDate });
      console.log(`${suite} seed ${seed}: ${cases.length} cases`);
      const deps: RunCaseDeps = {
        portal,
        pool,
        skill,
        ledger,
        failures: live.artifacts,
        seed,
        concurrency: 1,
        ...(withRepair
          ? {
              repair: {
                mode: "live" as const,
                rungs: ["open_weights", "computer_use"],
                build: (c): Repairer[] => [
                  createOpenWeightsRepairer(live.models, { model: live.config.openWeights.model, ledger }),
                  createCuRepairer({
                    model: live.models.computerUse({ model: MODEL }),
                    runComputerUse,
                    artifacts: c.artifacts,
                    writeGuard: c.writeGuard,
                    ledger,
                  }),
                ],
              },
            }
          : {}),
      };
      for (const c of cases) {
        const since = Date.now();
        const r = await runCase(c, deps);
        // Rung attempts from the ledger: one (run, step) per attempt; latency and cost per rung.
        const rows = db.raw
          .prepare(
            `SELECT purpose, provider, step_idx AS step, latency_ms AS ms, cost_usd AS usd FROM model_calls
             WHERE ts >= ? AND run_id LIKE ?`,
          )
          .all(since, `${c.id}.%`) as {
          purpose: string;
          provider: string;
          step: number;
          ms: number;
          usd: number;
        }[];
        if (rows.some((x) => x.provider !== "meta" && x.provider !== "baseten"))
          throw new Error("non-live rows");
        const rung = (purpose: string) => {
          const mine = rows.filter((x) => x.purpose === purpose);
          return {
            attempts: new Set(mine.map((x) => x.step)).size,
            calls: mine.length,
            ms: mine.reduce((s, x) => s + x.ms, 0),
            costUsd: Number(mine.reduce((s, x) => s + x.usd, 0).toFixed(5)),
          };
        };
        const record = {
          ...r,
          live: true,
          model: { rung2: live.config.openWeights.model, rung3: MODEL },
          date: today,
          rungs: { open_weights: rung("heal_match"), computer_use: rung("cu_repair") },
        };
        appendFileSync(out, `${JSON.stringify(record)}\n`);
        const tag = r.silentWrong ? "SILENT WRONG" : r.ok ? "ok" : r.safeStop ? "safe stop" : "FAILED";
        console.log(
          `  ${c.id} ${tag} ${r.outcome} heals ${JSON.stringify(r.heals)} ${r.ms} ms $${r.execCostUsd.toFixed(4)}${r.ok ? "" : ` (${(r.error ?? "").slice(0, 100)})`}`,
        );
      }
    }
  } finally {
    await pool.closeAll();
    await portal.close();
    console.log(`spent (ledger, all live): $${live.spentUsd().toFixed(3)}`);
    live.close();
  }
}

// ---------- report ----------

type LiveRecord = EvalRecord & {
  rungs: Record<
    "open_weights" | "computer_use",
    { attempts: number; calls: number; ms: number; costUsd: number }
  >;
};

const INK = { primary: "#0b0b0b", secondary: "#52514e", muted: "#898781", grid: "#e1e0d9", axis: "#c3c2b7" };
const COLORS = { compile: "#2a78d6", cu: "#1baf7a" };

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Cumulative cost over run count, compile-once vs pure computer use (one y-axis: USD). */
function cumulativeChartHtml(
  series: { label: string; color: string; points: number[]; measured: number; failures: number[] }[],
  breakEven: number | null,
  note: string,
): string {
  const W = 960;
  const H = 520;
  const L = 80;
  const R = 220;
  const T = 96;
  const B = 120;
  const runs = Math.max(...series.map((s) => s.points.length));
  const maxY = Math.max(...series.flatMap((s) => s.points)) * 1.08;
  const x = (i: number) => L + ((i - 1) / Math.max(1, runs - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - v / maxY) * (H - T - B);
  let svg = "";
  svg += `<text x="32" y="40" font-size="20" font-weight="600" fill="${INK.primary}">Pure computer use vs compile once, cumulative cost</text>`;
  svg += `<text x="32" y="64" font-size="13" fill="${INK.secondary}">${esc(note)}</text>`;
  const step = maxY > 4 ? 1 : maxY > 2 ? 0.5 : maxY > 1 ? 0.25 : 0.1;
  for (let v = 0; v <= maxY; v += step) {
    svg += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${INK.grid}"/>`;
    svg += `<text x="${L - 10}" y="${y(v) + 4}" font-size="12" text-anchor="end" fill="${INK.muted}" style="font-variant-numeric:tabular-nums">$${v.toFixed(2)}</text>`;
  }
  for (const i of [1, 10, 20, 30, 40, 50, 60, 70, 80, runs].filter(
    (v, k, a) => v <= runs && a.indexOf(v) === k,
  )) {
    svg += `<text x="${x(i)}" y="${H - B + 22}" font-size="12" text-anchor="middle" fill="${INK.muted}">${i}</text>`;
  }
  svg += `<text x="${(L + W - R) / 2}" y="${H - B + 46}" font-size="13" text-anchor="middle" fill="${INK.secondary}">Run</text>`;
  svg += `<line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" stroke="${INK.axis}"/>`;
  if (breakEven) {
    svg += `<line x1="${x(breakEven)}" x2="${x(breakEven)}" y1="${T - 8}" y2="${y(0)}" stroke="${INK.muted}" stroke-dasharray="3 4"/>`;
    svg += `<text x="${x(breakEven) + 6}" y="${T + 4}" font-size="12" fill="${INK.secondary}">break-even: run ${breakEven}</text>`;
  }
  for (const s of series) {
    const measured = s.points.slice(0, s.measured);
    const projected = s.points.slice(s.measured - 1);
    const path = (pts: number[], offset: number) =>
      pts.map((v, i) => `${i === 0 ? "M" : "L"}${x(i + offset).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    svg += `<path d="${path(measured, 1)}" fill="none" stroke="${s.color}" stroke-width="2"/>`;
    if (projected.length > 1)
      svg += `<path d="${path(projected, s.measured)}" fill="none" stroke="${s.color}" stroke-width="2" stroke-dasharray="6 5"/>`;
    for (const f of s.failures) {
      svg += `<circle cx="${x(f)}" cy="${y(s.points[f - 1] ?? 0)}" r="5" fill="#fcfcfb" stroke="${s.color}" stroke-width="2"/>`;
    }
    const last = s.points.at(-1) ?? 0;
    svg += `<text x="${W - R + 10}" y="${y(last) + 4}" font-size="13" fill="${INK.primary}">${esc(s.label)}</text>`;
    svg += `<text x="${W - R + 10}" y="${y(last) + 21}" font-size="12" fill="${INK.secondary}" style="font-variant-numeric:tabular-nums">$${last.toFixed(2)} at run ${s.points.length}</text>`;
  }
  // Legend (two series: also direct-labelled at the line ends).
  let lx = L;
  for (const s of series) {
    svg += `<line x1="${lx}" x2="${lx + 22}" y1="${H - 40}" y2="${H - 40}" stroke="${s.color}" stroke-width="2"/>`;
    svg += `<text x="${lx + 28}" y="${H - 36}" font-size="12" fill="${INK.secondary}">${esc(s.label)}</text>`;
    lx += 300;
  }
  const anyFailure = series.some((s) => s.failures.length > 0);
  svg += `<text x="${L}" y="${H - 12}" font-size="12" fill="${INK.muted}">Dashed: projected from the measured mean${anyFailure ? " · ○ run without a correct submission" : ""}</text>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#fcfcfb;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}svg{display:block}</style></head><body><svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="system-ui,-apple-system,Segoe UI,sans-serif">${svg}</svg></body></html>`;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "n/a");

async function report(): Promise<void> {
  const video = readJsonl<FirstRunRow>("firstrun-caravela-video");
  const goal = readJsonl<FirstRunRow>("firstrun-caravela-goal");
  const compileRow = readJsonl<CompileRow>("compile-caravela").at(-1);
  const replays = readJsonl<LiveRecord>("replay-caravela-live");
  const heals = [
    ...readJsonl<LiveRecord>("mutation-caravela-live"),
    ...readJsonl<LiveRecord>("repair-caravela-live"),
  ];
  for (const r of [...video, ...goal]) if (r.provider !== "meta") throw new Error("non-live first run");
  for (const r of [...replays, ...heals])
    if (r.provider !== "none" && !/meta|baseten/.test(r.provider))
      throw new Error(`non-live row ${r.caseId} (${r.provider})`);

  // 1. heal rates per rung
  const rungStats = (key: "open_weights" | "computer_use") => {
    const tried = heals.filter((r) => r.rungs[key].attempts > 0);
    const healed = heals.filter((r) => r.heals.some((h) => h.rung === key));
    const attempts = tried.reduce((s, r) => s + r.rungs[key].attempts, 0);
    const healedSteps = heals.reduce((s, r) => s + (r.heals.find((h) => h.rung === key)?.count ?? 0), 0);
    const calls = tried.reduce((s, r) => s + r.rungs[key].calls, 0);
    const cost = tried.reduce((s, r) => s + r.rungs[key].costUsd, 0);
    const ms = tried.reduce((s, r) => s + r.rungs[key].ms, 0);
    return {
      attempts,
      healedSteps,
      share: pct(healedSteps, attempts),
      casesTried: tried.length,
      casesHealed: healed.length,
      calls,
      costUsd: Number(cost.toFixed(4)),
      costPerAttemptUsd: Number((attempts ? cost / attempts : 0).toFixed(4)),
      msPerAttempt: Math.round(attempts ? ms / attempts : 0),
    };
  };
  const free = (rung: "fallback" | "similarity") =>
    heals.reduce((s, r) => s + (r.heals.find((h) => h.rung === rung)?.count ?? 0), 0);
  const mustFail = heals.filter((r) => r.expectedCategory === "must_fail_safe");
  const healSummary = {
    cases: heals.length,
    seeds: [...new Set(heals.map((r) => r.seed))],
    ok: heals.filter((r) => r.ok).length,
    falseHeals: heals.filter((r) => r.silentWrong).length,
    safeStops: { correct: mustFail.filter((r) => r.safeStop).length, of: mustFail.length },
    failedNoWrite: heals.filter((r) => !r.ok && !r.silentWrong && !r.safeStop).length,
    freeHeals: { fallback: free("fallback"), similarity: free("similarity") },
    rung2: rungStats("open_weights"),
    rung3: rungStats("computer_use"),
    perOperator: Object.fromEntries(
      [...new Set(heals.flatMap((r) => r.operators))].map((op) => {
        const rs = heals.filter((r) => r.operators.includes(op));
        return [op, `${rs.filter((r) => r.ok).length}/${rs.length}`];
      }),
    ),
  };

  // 2. pure CU vs compile once (+ the held-out drift events)
  const cuCosts = video.map((r) => r.costUsd);
  const cuMean = mean(cuCosts);
  // The compiled run may predate the current baseline (prefix-*: same task, earlier loop build).
  const firstRun = [...video, ...readJsonl<FirstRunRow>("prefix-commitclick-firstrun")].find(
    (r) => r.runId === compileRow?.fromRunId,
  );
  const compileCost = (firstRun?.costUsd ?? 0) + (compileRow?.annotateCostUsd ?? 0);
  const sequence = [
    { cost: compileCost, ok: firstRun?.ok ?? false },
    ...replays.map((r) => ({ cost: r.execCostUsd, ok: r.ok })),
    ...heals.map((r) => ({ cost: r.execCostUsd, ok: r.ok || r.safeStop })),
  ];
  const compileCum: number[] = [];
  for (const [i, s] of sequence.entries()) compileCum.push((compileCum[i - 1] ?? 0) + s.cost);
  const cuCum = sequence.map((_, i) =>
    i < cuCosts.length ? cuCosts.slice(0, i + 1).reduce((a, b) => a + b, 0) : cuMean * (i + 1),
  );
  const breakEven = cuCum.findIndex((c, i) => c >= (compileCum[i] ?? Infinity)) + 1 || null;
  const comparison = {
    pureCu: {
      runs: video.length,
      ok: video.filter((r) => r.ok).length,
      meanCostUsd: Number(cuMean.toFixed(4)),
      meanSeconds: Number(mean(video.map((r) => r.seconds)).toFixed(1)),
    },
    compileOnce: {
      firstRunCostUsd: firstRun?.costUsd ?? null,
      annotateCostUsd: compileRow?.annotateCostUsd ?? null,
      canary: compileRow?.canary ?? null,
      replays: {
        runs: replays.length,
        ok: replays.filter((r) => r.ok).length,
        modelCalls: replays.reduce((s, r) => s + r.modelCalls, 0),
        meanMs: Math.round(mean(replays.map((r) => r.ms))),
      },
      driftEvents: {
        runs: heals.length,
        okOrSafeStop: heals.filter((r) => r.ok || r.safeStop).length,
        costUsd: Number(heals.reduce((s, r) => s + r.execCostUsd, 0).toFixed(4)),
      },
    },
    totalRuns: sequence.length,
    cumulativeUsd: {
      compileOnce: Number((compileCum.at(-1) ?? 0).toFixed(3)),
      pureCuProjected: Number((cuCum.at(-1) ?? 0).toFixed(3)),
    },
    breakEvenRun: breakEven,
  };

  // 3. video-guided vs goal-only
  const arm = (rows: FirstRunRow[]) => ({
    runs: rows.length,
    ok: rows.filter((r) => r.ok).length,
    meanActions: Number(mean(rows.map((r) => r.actions)).toFixed(1)),
    meanCostUsd: Number(mean(rows.map((r) => r.costUsd)).toFixed(4)),
    meanSeconds: Number(mean(rows.map((r) => r.seconds)).toFixed(1)),
    perRun: rows.map((r) => `${r.ok ? "ok" : "fail"} ${r.fields} ${r.actions}a $${r.costUsd} ${r.seconds}s`),
  });
  const ablation = {
    videoGuidedFirst3: arm(video.slice(0, 3)),
    videoGuidedAll: arm(video),
    goalOnly: arm(goal),
  };

  const summary = {
    label: `LIVE: muse-spark-1.3 (low) computer use, meta-models/muse-spark-open (low) rung 2, Standard list prices, ${today}`,
    healRates: healSummary,
    pureCuVsCompile: comparison,
    videoVsGoal: ablation,
  };
  writeFileSync(join(RESULTS, "live-headline.json"), `${JSON.stringify(summary, null, 2)}\n`);

  const note = `LIVE · muse-spark-1.3 low · ${video.length} pure computer-use runs (Café Aurora) vs 1 first run + compile + ${replays.length} replays + ${heals.length} held-out drift cases · ${today}`;
  const html = cumulativeChartHtml(
    [
      {
        label: "Compile once + heal",
        color: COLORS.compile,
        points: compileCum,
        measured: compileCum.length,
        failures: sequence.flatMap((s, i) => (s.ok ? [] : [i + 1])),
      },
      {
        label: "Pure computer use",
        color: COLORS.cu,
        points: cuCum,
        measured: Math.min(cuCosts.length, cuCum.length),
        failures: video.flatMap((r, i) => (r.ok ? [] : [i + 1])),
      },
    ],
    breakEven,
    note,
  );
  writeFileSync(join(RESULTS, "live-cu-vs-compile.png"), await renderChart({ html, w: 960, h: 520 }));
  const mutation = mutationChartHtml(heals as EvalRecord[], {
    title: "Held-out drift · live heal ladder · Caravela",
    scope: `seeds ${healSummary.seeds.join("/")} · LIVE`,
    date: today,
  });
  writeFileSync(join(RESULTS, "live-heal-rates.png"), await renderChart(mutation));

  const md = [
    `# Live headline evals (${today})`,
    "",
    "Real Meta and Baseten calls only (ledger providers meta/baseten); costs at Standard list price. Raw rows: `evals/results/live/`. Script: `scripts/live/headline.ts`.",
    "",
    "## 1. Heal ladder on held-out drift (Caravela: every mutation operator, plus the v2 UI and the model-heal operators)",
    `Seeds ${healSummary.seeds.join(", ")} (not used in development), ${heals.length} cases, compiled from a live first run. ${healSummary.ok} correct, ${healSummary.falseHeals} false heals (silent wrong), must-fail-safe stopped ${healSummary.safeStops.correct}/${healSummary.safeStops.of}, ${healSummary.failedNoWrite} failed without writing.`,
    "",
    "| Rung | Steps tried | Healed | Share | Cost per attempt | Latency per attempt |",
    "|---|---|---|---|---|---|",
    `| Free (fallback + similarity) | | ${healSummary.freeHeals.fallback + healSummary.freeHeals.similarity} | | $0 | |`,
    `| 2: Muse Spark Open (Baseten, low) | ${healSummary.rung2.attempts} | ${healSummary.rung2.healedSteps} | ${healSummary.rung2.share} | $${healSummary.rung2.costPerAttemptUsd} | ${healSummary.rung2.msPerAttempt} ms |`,
    `| 3: Muse Spark 1.3 computer use (low, ≤8 actions) | ${healSummary.rung3.attempts} | ${healSummary.rung3.healedSteps} | ${healSummary.rung3.share} | $${healSummary.rung3.costPerAttemptUsd} | ${healSummary.rung3.msPerAttempt} ms |`,
    "",
    `Per operator (correct/cases): ${Object.entries(healSummary.perOperator)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}.`,
    "",
    "![heal rates](live-heal-rates.png)",
    "",
    "## 2. Pure computer use vs compile once",
    `Pure computer use: ${comparison.pureCu.ok}/${comparison.pureCu.runs} correct, $${comparison.pureCu.meanCostUsd} and ${comparison.pureCu.meanSeconds} s per run. Compile once: first run $${comparison.compileOnce.firstRunCostUsd} (same task, loop build before the harness-click fix 5b2164a) + annotation $${comparison.compileOnce.annotateCostUsd} (dry runs ${comparison.compileOnce.canary}), then ${comparison.compileOnce.replays.ok}/${comparison.compileOnce.replays.runs} replays correct with ${comparison.compileOnce.replays.modelCalls} model calls (${comparison.compileOnce.replays.meanMs} ms mean, randomized params, jittered latency), then ${comparison.compileOnce.driftEvents.runs} drift cases (${comparison.compileOnce.driftEvents.okOrSafeStop} correct or safe stop, $${comparison.compileOnce.driftEvents.costUsd}). Over ${comparison.totalRuns} runs: $${comparison.cumulativeUsd.compileOnce} vs $${comparison.cumulativeUsd.pureCuProjected} (pure computer use projected from its measured mean after run ${video.length}). Break-even at run ${comparison.breakEvenRun}.`,
    "",
    "![cumulative cost](live-cu-vs-compile.png)",
    "",
    "## 3. Video-guided vs goal-only first run",
    "| Arm | Runs | Correct | Mean actions | Mean cost | Mean time |",
    "|---|---|---|---|---|---|",
    ...(
      [
        ["Video-guided (live Wonder teach draft), first 3", ablation.videoGuidedFirst3],
        ["Video-guided, all", ablation.videoGuidedAll],
        ["Goal only (no steps)", ablation.goalOnly],
      ] as const
    ).map(
      ([name, a]) =>
        `| ${name} | ${a.runs} | ${a.ok} | ${a.meanActions} | $${a.meanCostUsd} | ${a.meanSeconds} s |`,
    ),
    "",
  ].join("\n");
  writeFileSync(join(RESULTS, "live-headline.md"), md);
  console.log(md);
}

if (command === "firstruns") await firstRuns();
else if (command === "compile") await compileFirst();
else if (command === "replays") await evalSuite("replay", [Number(values.seed)], Number(values.n), false);
else if (command === "heal") await evalSuite("mutation", values.seeds.split(",").map(Number), 11, true);
// The repair suite adds the v2 UI (renamed submit, swapped product widget), where rung 3 has to work.
else if (command === "repair") await evalSuite("repair", values.seeds.split(",").map(Number), 3, true);
else if (command === "report") await report();
else throw new Error(`unknown command ${command}`);

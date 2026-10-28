// pnpm eval --suite replay|mutation|repair|agentic|all --skill caravela|supplier
//   [--n 50] [--seed 1] [--concurrency 4] [--repair none|fake|live] [--cu-model muse-spark-1.3] [--refresh-skill]
// Writes evals/results/<suite>-<skill>-<seed>.jsonl, summary.json, summary.md and the chart PNGs.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createBrowserPool } from "@dockhand/browser";
import {
  type ComputerUseModel,
  type Config,
  createArtifactStore,
  createLogger,
  type EvalCase,
  type EvalSuite,
  loadConfig,
  openDb,
  systemClock,
} from "@dockhand/core";
import { createModelGateway } from "@dockhand/meta";
import { bootstrapSkill } from "./bootstrap.ts";
import { generateCases } from "./cases.ts";
import { costChartHtml, mutationChartHtml, renderChart, replayChartHtml } from "./charts.ts";
import { createEvalLedger } from "./ledger.ts";
import { evalsDbPath, evalsVarDir, resultsDir } from "./paths.ts";
import { EVAL_PORTALS, type EvalPortal, portalDef } from "./portals.ts";
import { CU_REPAIR_MODEL, REPAIR_MODES, type RepairMode, repairSetup } from "./repairers.ts";
import { type EvalRecord, gradeSubmissions, type RunCaseDeps, runCase } from "./run.ts";
import { headline, renderMarkdown, summarize } from "./summary.ts";

const SUITES = ["replay", "mutation", "repair", "agentic"] as const;
type CliSuite = (typeof SUITES)[number];

function fail(msg: string): never {
  process.stderr.write(`eval: ${msg}\n`);
  process.exit(2);
}

function parse() {
  const { values } = parseArgs({
    options: {
      suite: { type: "string", default: "replay" },
      skill: { type: "string", default: "caravela" },
      n: { type: "string", default: "50" },
      seed: { type: "string", default: "1" },
      concurrency: { type: "string", default: "4" },
      repair: { type: "string", default: "none" },
      "cu-model": { type: "string", default: CU_REPAIR_MODEL },
      "refresh-skill": { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  const suite = values.suite as string;
  if (suite !== "all" && !(SUITES as readonly string[]).includes(suite))
    fail(`--suite must be ${SUITES.join("|")}|all`);
  if (!(EVAL_PORTALS as readonly string[]).includes(values.skill as string))
    fail(`--skill must be ${EVAL_PORTALS.join("|")}`);
  if (!(REPAIR_MODES as readonly string[]).includes(values.repair as string))
    fail(`--repair must be ${REPAIR_MODES.join("|")}`);
  const int = (name: string, v: string, min: number) => {
    const x = Number(v);
    if (!Number.isInteger(x) || x < min) fail(`--${name} must be an integer >= ${min}`);
    return x;
  };
  return {
    suites: (suite === "all" ? [...SUITES] : [suite]) as CliSuite[],
    skill: values.skill as EvalPortal,
    n: int("n", values.n as string, 1),
    seed: int("seed", values.seed as string, 0),
    concurrency: int("concurrency", values.concurrency as string, 1),
    repair: values.repair as RepairMode,
    cuModel: values["cu-model"] as string,
    refreshSkill: values["refresh-skill"] as boolean,
  };
}

function liveConfig(): Config | null {
  const config = loadConfig();
  return config.meta.mode === "live" && config.meta.apiKey ? config : null;
}

async function runAll<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i] as T, i);
      }
    }),
  );
  return out;
}

/** A case that crashed outside the runner still gets graded: a crash after a submit can still be silent wrong. */
function crashRecord(c: EvalCase, deps: RunCaseDeps, err: unknown, seed: number): EvalRecord {
  const grade = gradeSubmissions(c.expected, deps.portal.submissions({ runId: c.portal.runId }));
  return {
    caseId: c.id,
    suite: c.suite,
    ok: false,
    outcome: "failed",
    fields: grade.fields,
    silentWrong: grade.silentWrong,
    safeStop: false,
    heals: [],
    ms: 0,
    execCostUsd: 0,
    modelCalls: 0,
    provider: "none",
    errorCode: "TOOL_ERROR",
    skill: c.skill,
    portalId: c.portalId,
    ui: c.portal.ui,
    operators: c.portal.mutation?.operators ?? [],
    ...(c.expectedCategory ? { expectedCategory: c.expectedCategory } : {}),
    repair: deps.repair?.mode ?? "none",
    seed,
    error: `eval harness: ${err instanceof Error ? err.message : String(err)}`.slice(0, 400),
  };
}

function readRecords(dir: string): { file: string; mtime: number; rows: EvalRecord[] }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const path = join(dir, f);
      const rows = readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as EvalRecord);
      return { file: f, mtime: statSync(path).mtimeMs, rows };
    });
}

async function writeCharts(
  dir: string,
  files: ReturnType<typeof readRecords>,
  date: string,
): Promise<string[]> {
  const written: string[] = [];
  const newest = (prefix: string) =>
    files.filter((f) => f.file.startsWith(prefix)).sort((a, b) => b.mtime - a.mtime)[0];
  for (const key of EVAL_PORTALS) {
    const def = portalDef(key);
    const scopeOf = (rows: EvalRecord[]) =>
      `seed ${rows[0]?.seed ?? "?"} · repair ${rows[0]?.repair ?? "none"}`;
    const mutation = newest(`mutation-${key}-`);
    if (mutation && mutation.rows.length > 0) {
      const chart = mutationChartHtml(mutation.rows, {
        title: `Mutation robustness · ${def.title.replace(/^Register (a deal on )?/, "")}`,
        scope: scopeOf(mutation.rows),
        date,
      });
      writeFileSync(join(dir, `mutation-${key}.png`), await renderChart(chart));
      written.push(`mutation-${key}.png`);
    }
    const replay = newest(`replay-${key}-`);
    if (replay && replay.rows.length > 0) {
      const chart = replayChartHtml(replay.rows, {
        title: `Replay timing and success · ${key}`,
        scope: scopeOf(replay.rows),
        date,
      });
      writeFileSync(join(dir, `replay-${key}.png`), await renderChart(chart));
      written.push(`replay-${key}.png`);
    }
  }
  const all = files.flatMap((f) => f.rows);
  const cost = costChartHtml(all, { title: "Cost per run by mode", scope: "all seeds", date });
  writeFileSync(join(dir, "cost-per-run.png"), await renderChart(cost));
  written.push("cost-per-run.png");
  return written;
}

async function main(): Promise<void> {
  const args = parse();
  const def = portalDef(args.skill);
  const config = args.repair === "live" || args.suites.includes("agentic") ? liveConfig() : null;
  const suites = args.suites.filter((s) => {
    if (s !== "agentic" || config) return true;
    if (args.suites.length === 1)
      fail(
        "the agentic suite needs a live Meta key (META_MODE=live, MODEL_API_KEY); scripted runs never count as agentic",
      );
    process.stdout.write("eval: skipping agentic (no live Meta key; scripted runs never count as agentic)\n");
    return false;
  });

  const dir = resultsDir();
  mkdirSync(dir, { recursive: true });
  const db = openDb(evalsDbPath());
  const ledger = createEvalLedger(db);
  const failures = createArtifactStore(db, evalsVarDir());
  const portal = await def.start();
  const pool = createBrowserPool({
    headless: true,
    maxContexts: args.concurrency,
    storageStateDir: join(evalsVarDir(), "state"),
  });
  const log = (m: string) => process.stdout.write(`${m}\n`);
  try {
    const skill = await bootstrapSkill(args.skill, { portal, pool, refresh: args.refreshSkill, log });
    const repair = repairSetup(args.repair, { ledger, artifacts: failures, ...(config ? { config } : {}) });
    let agentModel: ComputerUseModel | undefined;
    if (config && suites.includes("agentic")) {
      const gateway = createModelGateway({
        config,
        ledger,
        artifacts: failures,
        clock: systemClock,
        log: createLogger({ level: config.logLevel, fields: { mod: "evals" } }),
      });
      agentModel = gateway.computerUse({ model: args.cuModel });
    }
    const deps: RunCaseDeps = {
      portal,
      pool,
      skill,
      ledger,
      repair,
      failures,
      seed: args.seed,
      concurrency: args.concurrency,
      ...(agentModel ? { agentModel } : {}),
    };
    for (const suite of suites) {
      const cases = generateCases(suite as EvalSuite, skill, args.n, args.seed, {
        today: portal.config().serverDate,
      });
      log(
        `eval: ${suite} · ${args.skill} · seed ${args.seed} · repair ${repair.mode} · ${cases.length} cases`,
      );
      const records = await runAll(cases, args.concurrency, async (c, i) => {
        let r: EvalRecord;
        try {
          r = await runCase(c, deps);
        } catch (err) {
          r = crashRecord(c, deps, err, args.seed);
        }
        const tag = r.silentWrong ? "SILENT WRONG" : r.ok ? "ok" : r.safeStop ? "safe stop" : "FAILED";
        log(
          `  [${i + 1}/${cases.length}] ${c.id} ${tag} ${r.outcome} ${r.ms} ms${r.error && !r.ok ? ` (${r.error.slice(0, 120)})` : ""}`,
        );
        return r;
      });
      const file = join(dir, `${suite}-${args.skill}-${args.seed}.jsonl`);
      writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
      for (const g of summarize(records).groups) log(`eval: ${headline(g)}`);
    }
    const files = readRecords(dir);
    const date = new Date().toISOString().slice(0, 10);
    const charts = await writeCharts(dir, files, date);
    const summary = summarize(files.flatMap((f) => f.rows));
    writeFileSync(join(dir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    writeFileSync(join(dir, "summary.md"), renderMarkdown(summary, charts));
    log(`eval: silent wrong ${summary.totals.silentWrong} of ${summary.totals.runs} runs (all result files)`);
    log(`eval: wrote ${dir} (summary.json, summary.md, ${charts.join(", ")})`);
  } finally {
    await pool.closeAll();
    await portal.close();
    db.close();
  }
}

main().catch((err) => {
  process.stderr.write(`eval: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});

// Live heal-ladder check: replays the compiled Caravela skill on mutated portals with only the rungs asked
// for (free rungs always run first): rung 2 = Muse Spark Open on Baseten (heal_match), rung 3 = Muse computer
// use (cu_repair, <=8 actions, propose_only on commit steps). Ground truth and grading are the eval
// harness's own (runCase); results go to var/agent-live/evals, never to evals/results.
//
// Usage: META_MODE=live tsx scripts/live/repair.ts --rungs open_weights|computer_use|both
//          [--suite repair|mutation] [--ops button_rename,combobox_to_radio] [--n 6] [--seed 7]

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createBrowserPool, runComputerUse } from "../../packages/browser/src/index.ts";
import {
  createArtifactStore,
  createLogger,
  type EvalSuite,
  loadConfig,
  openDb,
  type Repairer,
  systemClock,
} from "../../packages/core/src/index.ts";
import {
  bootstrapSkill,
  createEvalLedger,
  generateCases,
  portalDef,
  type RunCaseDeps,
  runCase,
} from "../../packages/evals/src/index.ts";
import { createModelGateway } from "../../packages/meta/src/index.ts";
import { createCuRepairer, createOpenWeightsRepairer } from "../../packages/skills/src/index.ts";
import { LIVE_VAR_DIR } from "./lib.ts";

const { values } = parseArgs({
  options: {
    rungs: { type: "string", default: "both" },
    suite: { type: "string", default: "repair" },
    ops: { type: "string" },
    n: { type: "string", default: "6" },
    seed: { type: "string", default: "7" },
    "cu-model": { type: "string", default: "muse-spark-1.3" },
  },
});
process.env.DOCKHAND_VAR_DIR ||= LIVE_VAR_DIR;
const config = loadConfig();
if (config.meta.mode !== "live") throw new Error("run with META_MODE=live");
const dir = join(process.env.DOCKHAND_VAR_DIR, "evals");
mkdirSync(dir, { recursive: true });
const db = openDb(join(process.env.DOCKHAND_VAR_DIR, "evals.sqlite"));
const ledger = createEvalLedger(db);
const artifacts = createArtifactStore(db, dir);
const gateway = createModelGateway({
  config,
  ledger,
  artifacts,
  clock: systemClock,
  log: createLogger({ level: "warn", fields: { script: "repair" } }),
  ...(process.env.DEBUG_POSTS
    ? {
        // Prints the calls each model response makes (the proposed target's coordinates, for one).
        fetch: (async (input, init) => {
          const res = await fetch(input, init);
          const text = await res.clone().text();
          try {
            const out = (JSON.parse(text) as { output?: Record<string, unknown>[] }).output ?? [];
            for (const o of out) {
              if (o.type === "function_call") console.log(`  [model] ${o.name} ${o.arguments}`);
              if (o.type === "computer_call") console.log(`  [model] actions ${JSON.stringify(o.actions)}`);
            }
          } catch {}
          return res;
        }) as typeof fetch,
      }
    : {}),
});
const wantOw = values.rungs === "open_weights" || values.rungs === "both";
const wantCu = values.rungs === "computer_use" || values.rungs === "both";
if (wantOw && !gateway.hasOpenWeights())
  throw new Error("rung 2 needs BASETEN_API_KEY and OPEN_WEIGHTS_MODEL");

const def = portalDef("caravela");
const portal = await def.start();
const pool = createBrowserPool({ headless: true, maxContexts: 1, storageStateDir: join(dir, "state") });
if (process.env.DEBUG_POSTS) {
  // Logs every write the page sends and what became of it (diagnoses a submit that never lands).
  const lease = pool.lease.bind(pool);
  pool.lease = async (o) => {
    const l = await lease(o);
    const tag = (r: { method(): string; url(): string }) => `${r.method()} ${new URL(r.url()).pathname}`;
    l.page.on("request", (r) => r.method() !== "GET" && console.log(`  [net] -> ${tag(r)}`));
    l.page.on("requestfailed", (r) => console.log(`  [net] x ${tag(r)} ${r.failure()?.errorText}`));
    l.page.on(
      "response",
      (r) => r.request().method() !== "GET" && console.log(`  [net] <- ${r.status()} ${tag(r.request())}`),
    );
    return l;
  };
}
const out = join(dir, `repair-${values.rungs}-${values.suite}-${values.seed}-${Date.now()}.jsonl`);
const since = Date.now();
try {
  const skill = await bootstrapSkill("caravela", { portal, pool, log: () => undefined });
  const ops = values.ops?.split(",").filter(Boolean);
  const cases = generateCases(values.suite as EvalSuite, skill, Number(values.n), Number(values.seed), {
    today: portal.config().serverDate,
  }).filter((c) => !ops || (c.portal.mutation?.operators ?? []).some((o) => ops.includes(o)));
  const deps: RunCaseDeps = {
    portal,
    pool,
    skill,
    ledger,
    failures: artifacts,
    repair: {
      mode: "live",
      rungs: [...(wantOw ? (["open_weights"] as const) : []), ...(wantCu ? (["computer_use"] as const) : [])],
      build: (ctx): Repairer[] => [
        ...(wantOw ? [createOpenWeightsRepairer(gateway, { model: config.openWeights.model, ledger })] : []),
        ...(wantCu
          ? [
              createCuRepairer({
                model: gateway.computerUse({ model: values["cu-model"] as string }),
                runComputerUse,
                artifacts: ctx.artifacts,
                writeGuard: ctx.writeGuard,
                ledger,
              }),
            ]
          : []),
      ],
    },
  };
  console.log(`${cases.length} cases (${values.suite}, rungs ${values.rungs}, seed ${values.seed})`);
  for (const c of cases) {
    const r = await runCase(c, deps);
    appendFileSync(out, `${JSON.stringify(r)}\n`);
    const tag = r.silentWrong ? "SILENT WRONG" : r.ok ? "ok" : r.safeStop ? "safe stop" : "FAILED";
    console.log(
      `${c.id} [${c.portal.ui} ${(c.portal.mutation?.operators ?? []).join(",") || "-"}] ${tag} ${r.outcome} heals ${JSON.stringify(r.heals)} ${r.ms} ms $${r.execCostUsd.toFixed(4)} calls ${r.modelCalls}${r.ok ? "" : ` (${(r.error ?? "").slice(0, 140)})`}`,
    );
  }
  const rows = db.raw
    .prepare(
      `SELECT purpose, model, status, COUNT(*) AS calls, AVG(latency_ms) AS avgMs, MAX(latency_ms) AS maxMs,
              SUM(cost_usd) AS usd, AVG(output_tokens) AS avgOut, AVG(COALESCE(reasoning_tokens,0)) AS avgReasoning
       FROM model_calls WHERE ts >= ? GROUP BY purpose, model, status`,
    )
    .all(since) as Record<string, number | string>[];
  for (const r of rows) {
    console.log(
      `${r.purpose} ${r.model} ${r.status}: ${r.calls} calls, avg ${Math.round(Number(r.avgMs))} ms (max ${r.maxMs}), avg out ${Math.round(Number(r.avgOut))} (reasoning ${Math.round(Number(r.avgReasoning))}), $${Number(r.usd).toFixed(4)}`,
    );
  }
  console.log(`results: ${out}`);
} finally {
  await pool.closeAll();
  await portal.close();
  db.close();
}

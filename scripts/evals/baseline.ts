// Baseline for the headline's held-out drift result (evals/results/live-headline.md, section 1): the same 42
// cases run by an ordinary recorded script and by the runner with its heal ladder off, graded by the same
// field-by-field grader. Zero model calls: mock portal only, no model client is created, and the run fails if
// the eval ledger gets a single model-call row.
//
//   run      every arm on the 42 cases, plus the unchanged-portal controls, then `report`
//   report   evals/results/baseline-recorded-script.json -> baseline-vs-dockhand.png and the Baseline section
//
// Arms: script (the compiled skill's Playwright export, run as-is), noHealNoReadBack and noHealReadBack (the v1
// program, primary selector per step, no similarity / widget swap / repairers / rep answers; with and without the
// read-back gate). Dockhand's numbers are the live rows of section 1; nothing here calls a model.
//
// Usage: pnpm exec tsx scripts/evals/baseline.ts run|report

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { Page } from "playwright";
import { createBrowserPool } from "../../packages/browser/src/index.ts";
import {
  type EvalCase,
  openDb,
  type ParamValue,
  Skill,
  type Step,
  workspaceRoot,
} from "../../packages/core/src/index.ts";
import {
  createEvalLedger,
  type EvalRecord,
  generateCases,
  gradeSubmissions,
  portalDef,
  primarySelectorsOnly,
  type RecordedScript,
  type RunCaseDeps,
  renderChart,
  runCase,
} from "../../packages/evals/src/index.ts";
import { isLocalUrl } from "../../packages/evals/src/portals.ts";
import { displayName, exportPlaywright, rebaseSkill, stepTarget } from "../../packages/skills/src/index.ts";
import {
  ARMS,
  type ArmKey,
  type ArmResult,
  type ArmSummary,
  addOutcome,
  BASELINE_JSON,
  BASELINE_PNG,
  type BaselineSummary,
  baselineChartHtml,
  baselineMarkdown,
  type CaseRow,
  type Counts,
  changeOf,
  emptyCounts,
  outcomeOf,
  upsertBaselineSection,
} from "./baseline-report.ts";

const ROOT = workspaceRoot();
const RESULTS = join(ROOT, "evals", "results");
const HEADLINE_RAW = join(RESULTS, "live");
const HEADLINE_MD = join(RESULTS, "live-headline.md");
/** The compiled v1 skill the headline's heal run replayed (written by `headline.ts compile`). */
const SKILL_FILE = join(ROOT, "var", "agent-live", "headline", "caravela-skill.json");
const VAR = join(ROOT, "var", "agent-baseline");
const LEDGER_FILE = join(VAR, "evals.sqlite");
const SEEDS = [101, 102, 103];
/**
 * The calendar date the headline generated its cases with (`portal.config().serverDate` on its run day; the rows'
 * `date`). Close dates are generated relative to it, so the same date gives the same 42 cases.
 */
const CASE_DATE = "2026-10-28";
const LATENCY_MS: [number, number] = [50, 400];
/** No case takes this long (the script arm's longest wait is two 30 s timeouts); longer means the host slept. */
const MAX_CASE_MS = 180_000;
const RUNNER_ARMS = ["script", "scriptPrimary", "noHealNoReadBack", "noHealReadBack"] as const;
type RunnerArm = (typeof RUNNER_ARMS)[number];
const CONTROL_ARMS: RunnerArm[] = ["script", "scriptPrimary", "noHealReadBack"];

const rel = (p: string) => relative(ROOT, p).replace(/\\/g, "/");
const firstLine = (s: string) => (s.split("\n")[0] ?? "").trim();
/** First line of an error, plus the locator a Playwright timeout was waiting for (from its call log). */
function errorText(s: string): string {
  const waiting = /waiting for (.+)/.exec(s)?.[1]?.trim();
  return waiting ? `${firstLine(s)} (waiting for ${waiting})` : firstLine(s);
}
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function readHeadlineRows(): EvalRecord[] {
  return readdirSync(HEADLINE_RAW)
    .filter((f) => /^(mutation|repair)-caravela-live-s\d+\.jsonl$/.test(f))
    .flatMap((f) =>
      readFileSync(join(HEADLINE_RAW, f), "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as EvalRecord & { date?: string }),
    );
}

/** The headline's 42 cases, in its run order (mutation seeds, then repair seeds). */
function headlineCases(skill: Skill): { c: EvalCase; seed: number }[] {
  const mutation = SEEDS.flatMap((seed) =>
    generateCases("mutation", skill, 11, seed, { today: CASE_DATE }).map((c) => ({ c, seed })),
  );
  const repair = SEEDS.flatMap((seed) =>
    generateCases("repair", skill, 3, seed, { today: CASE_DATE }).map((c) => ({ c, seed })),
  );
  return [...mutation, ...repair];
}

/** Same ids as the headline rows and the same number of graded fields (rows without extra fields). */
function sameAsHeadline(cases: { c: EvalCase }[], headline: EvalRecord[]): boolean {
  const byId = new Map(headline.map((r) => [r.caseId, r]));
  if (byId.size !== cases.length) return false;
  return cases.every(({ c }) => {
    const h = byId.get(c.id);
    if (!h) return false;
    const extras = h.fields.mismatches.filter((m) => m.expected === "(absent)").length;
    return h.fields.total - extras === Object.keys(c.expected).length;
  });
}

// ---------- the recorded script ----------

type ExportFn = (page: Page, p: Record<string, ParamValue>) => Promise<Record<string, string>>;

interface ScriptNote {
  requests: string[];
  /** Line numbers of the script file in the error's stack, innermost first. */
  lines: number[];
}

interface Exported {
  fn: ExportFn;
  file: string;
  code: string;
}

/** Writes the skill's Playwright export (rebased to this portal) to disk and imports it unchanged. */
async function loadExport(skill: Skill, portalUrl: string, tag: string): Promise<Exported> {
  const code = exportPlaywright(rebaseSkill(skill, portalUrl));
  const file = join(VAR, `${skill.name}.${tag}.playwright.ts`);
  writeFileSync(file, code);
  const fnName = skill.name.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
  const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  const fn = mod[fnName];
  if (typeof fn !== "function") throw new Error(`the export has no function ${fnName}`);
  return { fn: fn as ExportFn, file, code };
}

/**
 * The script as a caller would run it: every declared param passed, a blank string for an optional value the case
 * leaves out (the script fills every field it recorded). Non-GET requests and the failing line are noted.
 */
function scriptFor(caseId: string, fn: ExportFn, skill: Skill, file: string, notes: Map<string, ScriptNote>) {
  const run: RecordedScript = async (page, params) => {
    const note: ScriptNote = { requests: [], lines: [] };
    notes.set(caseId, note);
    page.on("request", (req) => {
      if (req.method() !== "GET") note.requests.push(`${req.method()} ${new URL(req.url()).pathname}`);
    });
    const p: Record<string, ParamValue> = { ...params };
    for (const spec of skill.params) if (p[spec.name] === undefined) p[spec.name] = "";
    try {
      await fn(page, p);
    } catch (err) {
      const name = file.split(/[\\/]/).at(-1) ?? "";
      const stack = err instanceof Error ? (err.stack ?? "") : "";
      const at = new RegExp(`${name.replace(/\./g, "\\.")}:(\\d+):\\d+`, "g");
      note.lines = [...stack.matchAll(at)].map((m) => Number(m[1]));
      throw err;
    }
  };
  return run;
}

/** "s13 Product" for a step id; the script's failing line maps to the step comment above it. */
function stepLabel(skill: Skill, id: string): string {
  const step = skill.steps.find((s) => s.id === id) as Step | undefined;
  if (!step) return id;
  const name = displayName(stepTarget(step)?.fingerprint);
  if (name) return `${id} ${name}`;
  if (step.op === "waitFor") return `${id} wait for ${step.urlIncludes ?? step.text ?? "page"}`;
  return `${id} ${step.op}`;
}

function scriptStop(skill: Skill, code: string, lines: number[]): string | undefined {
  const src = code.split("\n");
  for (const line of lines) {
    for (let i = Math.min(line, src.length) - 1; i >= 0; i--) {
      const l = src[i] ?? "";
      const m = /^\s*\/\/ (s\d+): /.exec(l);
      if (m?.[1]) return stepLabel(skill, m[1]);
      if (/^\s*\/\/ Success check/.test(l)) return "success check after the submit click";
      if (/^(export )?async function /.test(l)) break; // inside a helper (pick): try the next frame
    }
  }
  return undefined;
}

// ---------- run ----------

function armResult(r: EvalRecord, stoppedAt: string | undefined, requests?: string[]): ArmResult {
  const outcome = outcomeOf(r);
  return {
    outcome,
    fields: `${r.fields.correct}/${r.fields.total}`,
    ...(r.fields.mismatches.length ? { mismatches: r.fields.mismatches } : {}),
    ...(outcome !== "correct" && stoppedAt ? { stoppedAt } : {}),
    ...(outcome !== "correct" && r.error ? { error: errorText(r.error).slice(0, 240) } : {}),
    ms: r.ms,
    ...(requests ? { requests } : {}),
  };
}

function runnerStop(skill: Skill, r: EvalRecord): string | undefined {
  const m = /^(s\d+) \(/.exec(r.error ?? "");
  return m?.[1] ? stepLabel(skill, m[1]) : undefined;
}

/** A case that crashed outside the runner is still graded from the portal's log (as the eval CLI does). */
function crashRecord(c: EvalCase, deps: RunCaseDeps, err: unknown): EvalRecord {
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
    repair: "none",
    error: `eval harness: ${err instanceof Error ? err.message : String(err)}`.slice(0, 400),
  };
}

function control(c: EvalCase, arm: RunnerArm): EvalCase {
  const { expectedCategory: _drop, ...rest } = c;
  return { ...rest, portal: { ui: "v1", mutation: null, runId: `${c.id}~control-${arm}` } };
}

async function run(only?: string): Promise<void> {
  if (!existsSync(SKILL_FILE))
    throw new Error(`no compiled skill at ${rel(SKILL_FILE)} (headline.ts compile)`);
  const skillText = readFileSync(SKILL_FILE, "utf8");
  const skill = Skill.parse(JSON.parse(skillText));
  if (skill.params.some((p) => p.type === "file"))
    throw new Error("file params are not wired into this baseline");
  const headline = readHeadlineRows();
  const dates = new Set(headline.map((r) => (r as EvalRecord & { date?: string }).date));
  if (dates.size !== 1 || !dates.has(CASE_DATE))
    throw new Error(`headline rows are not all from ${CASE_DATE}`);
  const cases = headlineCases(skill);
  const same = sameAsHeadline(cases, headline);
  if (!same) throw new Error("the regenerated cases do not match the headline rows");
  console.log(`${cases.length} cases, same ids and field counts as the headline rows`);
  // Smoke runs (`run <id substring>`) print their rows and write nothing.
  const picked = only ? cases.filter(({ c }) => c.id.includes(only)) : cases;

  mkdirSync(VAR, { recursive: true });
  rmSync(LEDGER_FILE, { force: true });
  const db = openDb(LEDGER_FILE);
  const ledger = createEvalLedger(db);
  const def = portalDef("caravela");
  const portal = await def.start({ latencyMs: LATENCY_MS });
  if (!isLocalUrl(portal.url)) throw new Error(`not a local mock portal: ${portal.url}`);
  const newPool = () =>
    createBrowserPool({
      headless: true,
      maxContexts: 1,
      storageStateDir: join(VAR, "state"),
      hud: null,
      capture: null,
    });
  let pool = newPool();
  const arms = () =>
    Object.fromEntries(RUNNER_ARMS.map((a) => [a, new Map()])) as Record<RunnerArm, Map<string, EvalRecord>>;
  const records = arms();
  const controls = arms();
  const notes = new Map<string, ScriptNote>();
  const exports: Partial<Record<RunnerArm, Exported>> = {};
  try {
    // As exported (each step tries its stored selectors in rank order), and with one selector per step.
    exports.script = await loadExport(skill, portal.url, "as-exported");
    exports.scriptPrimary = await loadExport(primarySelectorsOnly(skill), portal.url, "one-selector");
    const baselineFor = (arm: RunnerArm, c: EvalCase): RunCaseDeps["baseline"] => {
      const ex = exports[arm];
      return ex
        ? { script: scriptFor(c.portal.runId, ex.fn, skill, ex.file, notes) }
        : { noHeal: { readBack: arm === "noHealReadBack" } };
    };
    // A harness failure (the browser died) or a wall time no case can take (the machine slept) measures nothing
    // about the arm: the case is retried once on a fresh browser, and a second such failure aborts the run.
    const runOne = async (arm: RunnerArm, c: EvalCase, seed: number): Promise<EvalRecord> => {
      for (let attempt = 1; ; attempt++) {
        const deps: RunCaseDeps = {
          portal,
          pool,
          skill,
          ledger,
          seed,
          concurrency: 1,
          baseline: baselineFor(arm, c),
        };
        let r: EvalRecord;
        let invalid: string | undefined;
        try {
          r = await runCase(c, deps);
          if (r.ms > MAX_CASE_MS) invalid = `${r.ms} ms wall time`;
        } catch (err) {
          r = crashRecord(c, deps, err);
          invalid = r.error;
        }
        if (!invalid) return r;
        if (attempt === 2) throw new Error(`${c.id} (${arm}) is not measurable twice: ${invalid}`);
        console.log(`  retrying ${c.id} (${arm}) on a fresh browser: ${invalid}`);
        await pool.closeAll().catch(() => undefined);
        pool = newPool();
      }
    };
    for (const arm of RUNNER_ARMS) {
      console.log(`arm ${arm}`);
      for (const { c, seed } of picked) {
        const mine = { ...c, portal: { ...c.portal, runId: `${c.id}~${arm}` } };
        const r = await runOne(arm, mine, seed);
        records[arm].set(c.id, r);
        console.log(
          `  ${c.id} ${outcomeOf(r)} ${r.fields.correct}/${r.fields.total} ${r.ms} ms ${firstLine(r.error ?? "").slice(0, 110)}`,
        );
      }
    }
    for (const arm of CONTROL_ARMS) {
      console.log(`control ${arm} (unchanged v1 portal, same params)`);
      for (const { c, seed } of picked) {
        const r = await runOne(arm, control(c, arm), seed);
        controls[arm].set(c.id, r);
        if (outcomeOf(r) !== "correct") console.log(`  ${c.id} ${outcomeOf(r)} ${firstLine(r.error ?? "")}`);
      }
    }
  } finally {
    await pool.closeAll();
    await portal.close();
  }

  // Zero model calls: per run and in the whole ledger.
  const all = [
    ...RUNNER_ARMS.flatMap((a) => [...records[a].values()]),
    ...CONTROL_ARMS.flatMap((a) => [...controls[a].values()]),
  ];
  const bad = all.filter((r) => r.modelCalls !== 0 || r.provider !== "none" || r.execCostUsd !== 0);
  if (bad.length > 0) throw new Error(`model calls in ${bad.map((r) => r.caseId).join(", ")}`);
  const ledgerRows = (db.raw.prepare("SELECT COUNT(*) AS n FROM model_calls").get() as { n: number }).n;
  db.close();
  if (ledgerRows !== 0) throw new Error(`the eval ledger has ${ledgerRows} model-call rows`);

  // Rows and summary.
  const headlineById = new Map(headline.map((r) => [r.caseId, r]));
  const rows: CaseRow[] = picked.map(({ c }) => {
    const h = headlineById.get(c.id) as EvalRecord;
    const scriptArm = (arm: RunnerArm): ArmResult => {
      const note = notes.get(`${c.id}~${arm}`);
      const code = exports[arm]?.code ?? "";
      return armResult(
        records[arm].get(c.id) as EvalRecord,
        scriptStop(skill, code, note?.lines ?? []),
        note?.requests ?? [],
      );
    };
    return {
      caseId: c.id,
      change: changeOf({ operators: c.portal.mutation?.operators ?? [], ui: c.portal.ui }),
      ...(c.expectedCategory ? { expectedCategory: c.expectedCategory } : {}),
      arms: {
        script: scriptArm("script"),
        scriptPrimary: scriptArm("scriptPrimary"),
        noHealNoReadBack: armResult(
          records.noHealNoReadBack.get(c.id) as EvalRecord,
          runnerStop(skill, records.noHealNoReadBack.get(c.id) as EvalRecord),
        ),
        noHealReadBack: armResult(
          records.noHealReadBack.get(c.id) as EvalRecord,
          runnerStop(skill, records.noHealReadBack.get(c.id) as EvalRecord),
        ),
        dockhand: armResult(h, runnerStop(skill, h)),
      },
    };
  });
  const tally = (key: ArmKey) => {
    const counts = emptyCounts();
    const perChange: Record<string, Counts> = {};
    for (const r of rows) {
      const o = r.arms[key]?.outcome;
      if (!o) continue;
      addOutcome(counts, o);
      perChange[r.change] ??= emptyCounts();
      addOutcome(perChange[r.change] as Counts, o);
    }
    return { counts, perChange };
  };
  const controlCounts = (arm: RunnerArm): Counts => {
    const c = emptyCounts();
    for (const r of controls[arm].values()) addOutcome(c, outcomeOf(r));
    return c;
  };
  if (only) {
    console.log(JSON.stringify(rows, null, 1));
    return;
  }
  // The grader's own ok flag must agree with the outcome classes.
  for (const arm of RUNNER_ARMS) {
    const ok = [...records[arm].values()].filter((r) => r.ok).length;
    if (ok !== tally(arm).counts.handled)
      throw new Error(`${arm}: ok ${ok} vs handled ${tally(arm).counts.handled}`);
  }
  const arm = (key: ArmKey, label: string, method: string, ctl?: Counts): ArmSummary => ({
    label,
    method,
    ...tally(key),
    ...(ctl ? { control: ctl } : {}),
    modelCalls: key === "dockhand" ? headline.reduce((n, r) => n + r.modelCalls, 0) : 0,
  });
  const summary: BaselineSummary = {
    label:
      "Baseline: an ordinary recorded script, and the runner with its heal ladder off, on the headline's 42 held-out UI-change cases (Caravela mock portal). Baseline arms make no model calls.",
    measured: new Date().toISOString().slice(0, 10),
    cases: {
      count: cases.length,
      seeds: SEEDS,
      suites: {
        mutation: cases.filter(({ c }) => c.suite === "mutation").length,
        repair: cases.filter(({ c }) => c.suite === "repair").length,
      },
      caseDate: CASE_DATE,
      sameAsHeadline: same,
    },
    skill: { file: rel(SKILL_FILE), sha256: sha256(skillText), name: skill.name, version: skill.version },
    portal: { id: def.portalId, latencyMs: LATENCY_MS, local: true },
    ledger: { file: rel(LEDGER_FILE), modelCallRows: ledgerRows },
    arms: {
      script: arm(
        "script",
        "Recorded script: the Playwright export of the same compiled v1 skill, run as-is",
        "the Playwright TypeScript export of the same compiled v1 skill (`exportPlaywright` in packages/skills), run as-is in a fresh browser context per case with Playwright's default 30 s timeouts. Like a recorded script it has no healing, no read-back and no approval gate. It is more forgiving than a one-selector codegen recording: each step tries its stored selectors in rank order (test id, role, label, CSS, placeholder) and takes the first that matches exactly one element. A value a case leaves out (optional field) is passed as an empty string, since the script fills every field it recorded.",
        controlCounts("script"),
      ),
      scriptPrimary: arm(
        "scriptPrimary",
        "Recorded script, one selector per step: the same export from the skill cut to each step's primary selector",
        "the same export generated from the skill with every step cut to its primary (first-ranked) selector, one locator per action as a codegen recording has (test id for most steps; role and name for the two dropdowns and the consent checkbox), run as-is the same way.",
        controlCounts("scriptPrimary"),
      ),
      noHealNoReadBack: arm(
        "noHealNoReadBack",
        "Dockhand's runner, heal ladder off, read-back gate off",
        "the same v1 program in Dockhand's runner with each step's primary selector only, no similarity match, no widget swap, no repair models and no questions to the rep; the read-back still runs but does not block the submit.",
      ),
      noHealReadBack: arm(
        "noHealReadBack",
        "Dockhand's runner, heal ladder off, read-back gate on",
        "as above, with the read-back gate on: every written value is read back and a mismatch stops the run before the submit.",
        controlCounts("noHealReadBack"),
      ),
      dockhand: arm(
        "dockhand",
        "Dockhand: heal ladder and read-back (section 1, live)",
        "the live heal-ladder rows of section 1 (evals/results/live/, 2026-10-28), not re-run here.",
      ),
    },
    rows,
  };
  writeFileSync(BASELINE_JSON, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`wrote ${rel(BASELINE_JSON)} (ledger: ${ledgerRows} model-call rows)`);
  await report();
}

// ---------- report ----------

async function report(): Promise<void> {
  if (!existsSync(BASELINE_JSON)) throw new Error(`no ${rel(BASELINE_JSON)}: run first`);
  const s = JSON.parse(readFileSync(BASELINE_JSON, "utf8")) as BaselineSummary;
  writeFileSync(join(RESULTS, BASELINE_PNG), await renderChart(baselineChartHtml(s)));
  const section = baselineMarkdown(s);
  writeFileSync(HEADLINE_MD, upsertBaselineSection(readFileSync(HEADLINE_MD, "utf8"), section));
  for (const k of ARMS) {
    const c = s.arms[k].counts;
    console.log(
      `${k}: ${c.correct} correct, ${c.safeStop} stopped as required, ${c.stopped} stopped, ${c.wrongWrite} wrong writes (handled ${c.handled}/${c.cases})`,
    );
  }
  console.log(`wrote ${BASELINE_PNG} and the Baseline section of ${rel(HEADLINE_MD)}`);
}

const command = process.argv[2] ?? "report";
if (command === "run") await run(process.argv[3]);
else if (command === "report") await report();
else throw new Error(`unknown command ${command} (run | report)`);

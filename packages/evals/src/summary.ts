// Summary math over eval records (pure), and the markdown report. Honesty rules: every line states the
// provider and N; scripted or fake rows never count as agentic first runs; silent wrong leads the report.

import type { EvalResult, HealRung } from "@dockhand/core";
import type { EvalRecord } from "./run.ts";

export const RUNGS: readonly HealRung[] = [
  "fallback",
  "similarity",
  "open_weights",
  "computer_use",
  "ask_rep",
];

export type Bucket = "clean" | `healed_${HealRung}` | "safe_stop" | "failed" | "silent_wrong";
export const BUCKETS: readonly Bucket[] = [
  "clean",
  ...RUNGS.map((r) => `healed_${r}` as const),
  "safe_stop",
  "failed",
  "silent_wrong",
];

/** Providers whose numbers may be reported as model results. */
export const REAL_PROVIDERS: readonly EvalResult["provider"][] = ["meta", "baseten"];

/** One outcome per run: silent wrong first, then safe stop, then pass by the most expensive rung used. */
export function bucketOf(r: EvalRecord): Bucket {
  if (r.silentWrong) return "silent_wrong";
  if (r.safeStop) return "safe_stop";
  if (!r.ok) return "failed";
  const used = RUNGS.filter((rung) => r.heals.some((h) => h.rung === rung && h.count > 0));
  const top = used.at(-1);
  return top ? `healed_${top}` : "clean";
}

/** Nearest-rank percentile (q in 0..1); 0 for no values. */
export function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[rank - 1] as number;
}

export interface OperatorSummary {
  operator: string;
  expectedCategory?: string;
  n: number;
  buckets: Record<Bucket, number>;
}

export interface GroupSummary {
  suite: EvalRecord["suite"];
  skill: string;
  seed: number | null;
  repair: EvalRecord["repair"];
  /** Rows counted (agentic: real-provider rows only). */
  n: number;
  /** Agentic rows left out because a scripted or fake model produced them. */
  excludedScripted: number;
  /** provider -> rows. */
  providers: Record<string, number>;
  /** Correct outcomes: a submission with every field right, or a required safe stop. */
  ok: number;
  /** Correct submissions only (ok minus required safe stops). */
  submittedCorrect: number;
  successRate: number;
  silentWrong: number;
  safeStops: number;
  failed: number;
  /** Runs that needed each rung, and the steps it healed. */
  heals: Record<HealRung, { runs: number; steps: number }>;
  healedRuns: number;
  ms: { p50: number; p90: number; mean: number };
  modelCalls: number;
  costUsd: number;
  costPerRunUsd: number;
  byOperator: OperatorSummary[];
}

export interface Summary {
  generatedAt: string;
  totals: { runs: number; silentWrong: number; excludedScripted: number };
  groups: GroupSummary[];
}

function emptyBuckets(): Record<Bucket, number> {
  return Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<Bucket, number>;
}

/** The provider label for a set of rows: one name, or "mixed (none 40, baseten 10)". */
export function providerText(providers: Record<string, number>): string {
  const entries = Object.entries(providers).filter(([, n]) => n > 0);
  if (entries.length === 0) return "none";
  if (entries.length === 1) return (entries[0] as [string, number])[0];
  return `mixed (${entries.map(([p, n]) => `${p} ${n}`).join(", ")})`;
}

export function summarizeGroup(rows: readonly EvalRecord[]): GroupSummary {
  const first = rows[0];
  if (!first) throw new Error("summarizeGroup needs at least one row");
  const agentic = first.suite === "agentic";
  const counted = agentic ? rows.filter((r) => REAL_PROVIDERS.includes(r.provider)) : [...rows];
  const providers: Record<string, number> = {};
  for (const r of counted) providers[r.provider] = (providers[r.provider] ?? 0) + 1;
  const heals = Object.fromEntries(RUNGS.map((r) => [r, { runs: 0, steps: 0 }])) as GroupSummary["heals"];
  for (const r of counted) {
    for (const h of r.heals) {
      if (h.count <= 0) continue;
      heals[h.rung].runs++;
      heals[h.rung].steps += h.count;
    }
  }
  const ops = new Map<string, OperatorSummary>();
  for (const r of counted) {
    const key = r.operators.length > 0 ? r.operators.join("+") : r.ui === "v2" ? "ui_v2" : "none";
    const op = ops.get(key) ?? { operator: key, n: 0, buckets: emptyBuckets() };
    if (r.expectedCategory) op.expectedCategory = r.expectedCategory;
    op.n++;
    op.buckets[bucketOf(r)]++;
    ops.set(key, op);
  }
  const ms = counted.map((r) => r.ms);
  const cost = counted.reduce((s, r) => s + r.execCostUsd, 0);
  const ok = counted.filter((r) => r.ok).length;
  return {
    suite: first.suite,
    skill: first.skill,
    seed: first.seed ?? null,
    repair: first.repair,
    n: counted.length,
    excludedScripted: rows.length - counted.length,
    providers,
    ok,
    submittedCorrect: counted.filter((r) => r.ok && !r.safeStop).length,
    successRate: counted.length > 0 ? ok / counted.length : 0,
    silentWrong: counted.filter((r) => r.silentWrong).length,
    safeStops: counted.filter((r) => r.safeStop).length,
    failed: counted.filter((r) => bucketOf(r) === "failed").length,
    heals,
    healedRuns: counted.filter((r) => r.ok && r.heals.some((h) => h.count > 0)).length,
    ms: {
      p50: percentile(ms, 0.5),
      p90: percentile(ms, 0.9),
      mean: ms.length > 0 ? Math.round(ms.reduce((s, x) => s + x, 0) / ms.length) : 0,
    },
    modelCalls: counted.reduce((s, r) => s + r.modelCalls, 0),
    costUsd: cost,
    costPerRunUsd: counted.length > 0 ? cost / counted.length : 0,
    byOperator: [...ops.values()],
  };
}

/** Groups rows by suite, skill, seed and repair mode. */
export function summarize(rows: readonly EvalRecord[], now = new Date()): Summary {
  const groups = new Map<string, EvalRecord[]>();
  for (const r of rows) {
    const key = [r.suite, r.skill, r.seed ?? "", r.repair].join("|");
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const out = [...groups.values()].map(summarizeGroup);
  return {
    generatedAt: now.toISOString(),
    totals: {
      runs: out.reduce((s, g) => s + g.n, 0),
      silentWrong: out.reduce((s, g) => s + g.silentWrong, 0),
      excludedScripted: out.reduce((s, g) => s + g.excludedScripted, 0),
    },
    groups: out,
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const secs = (ms: number) => `${(ms / 1000).toFixed(2)} s`;

/** "fallback 12 runs (40 steps), similarity 1 run (1 step)" or "none". */
export function healText(g: GroupSummary): string {
  const parts = RUNGS.filter((r) => g.heals[r].runs > 0).map(
    (r) =>
      `${r} ${g.heals[r].runs} run${g.heals[r].runs === 1 ? "" : "s"} (${g.heals[r].steps} step${g.heals[r].steps === 1 ? "" : "s"})`,
  );
  return parts.length > 0 ? parts.join(", ") : "none";
}

/** One line per group; each states the provider and N. */
export function headline(g: GroupSummary): string {
  const label = g.suite === "agentic" ? "agentic first run" : g.suite;
  const scope = `${label} · ${g.skill} · seed ${g.seed ?? "?"} · repair ${g.repair} · provider ${providerText(g.providers)} · N=${g.n}`;
  if (g.n === 0) {
    return `${scope}: no reportable runs${g.excludedScripted > 0 ? ` (${g.excludedScripted} scripted rows excluded)` : ""}`;
  }
  return [
    `${scope}: correct ${g.ok}/${g.n} (${pct(g.successRate)}${g.ok > g.submittedCorrect ? `: ${g.submittedCorrect} right submissions + ${g.ok - g.submittedCorrect} required safe stops` : ""})`,
    `silent wrong ${g.silentWrong}`,
    `safe stops ${g.safeStops}`,
    `failed ${g.failed}`,
    `heals ${healText(g)}`,
    `p50 ${secs(g.ms.p50)}, p90 ${secs(g.ms.p90)}`,
    `${g.modelCalls} model calls, $${g.costPerRunUsd.toFixed(4)}/run`,
  ].join(" · ");
}

const CATEGORY_NOTE: Record<string, string> = {
  heal_deterministic: "free heal expected",
  heal_deterministic_or_model: "free or model heal expected",
  heal_model: "needs a model rung",
  must_fail_safe: "must stop and ask",
};

export function renderMarkdown(s: Summary, charts: string[] = []): string {
  const lines: string[] = [];
  lines.push("# Dockhand eval results", "");
  lines.push(
    `**Silent wrong: ${s.totals.silentWrong} of ${s.totals.runs} runs** (a submission with any wrong field; the number that must stay at 0).`,
    "",
  );
  lines.push(
    `Generated ${s.generatedAt}. Ground truth is each portal's own submission log. Scripted and fake runs are labeled by provider and never reported as agentic or first runs${s.totals.excludedScripted > 0 ? ` (${s.totals.excludedScripted} such rows excluded)` : ""}.`,
    "",
  );
  lines.push("## Runs", "");
  for (const g of s.groups) lines.push(`- ${headline(g)}`);
  for (const g of s.groups.filter((x) => x.suite === "mutation" || x.suite === "repair")) {
    lines.push(
      "",
      `## ${g.suite} by change · ${g.skill} · seed ${g.seed ?? "?"} · repair ${g.repair} · provider ${providerText(g.providers)} · N=${g.n}`,
      "",
    );
    lines.push("| Change | Expected | N | Clean | Healed | Safe stop | Failed | Silent wrong |");
    lines.push("|---|---|---|---|---|---|---|---|");
    for (const op of g.byOperator) {
      const healed = RUNGS.filter((r) => op.buckets[`healed_${r}`] > 0)
        .map((r) => `${op.buckets[`healed_${r}`]} ${r}`)
        .join(", ");
      lines.push(
        `| ${op.operator} | ${op.expectedCategory ? (CATEGORY_NOTE[op.expectedCategory] ?? op.expectedCategory) : ""} | ${op.n} | ${op.buckets.clean} | ${healed || 0} | ${op.buckets.safe_stop} | ${op.buckets.failed} | ${op.buckets.silent_wrong} |`,
      );
    }
  }
  if (charts.length > 0) {
    lines.push("", "## Charts", "");
    for (const c of charts) lines.push(`![${c}](${c})`);
  }
  return `${lines.join("\n")}\n`;
}

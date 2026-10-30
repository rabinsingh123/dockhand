// The baseline's summary shape, its Markdown section and its chart. Pure: scripts/evals/baseline.ts writes the
// summary and calls these; scripts/live/headline.ts `report` appends the same section when the summary exists.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { workspaceRoot } from "../../packages/core/src/index.ts";
import { BUCKET_STYLE, type EvalRecord } from "../../packages/evals/src/index.ts";

export const BASELINE_JSON = join(workspaceRoot(), "evals", "results", "baseline-recorded-script.json");
export const BASELINE_PNG = "baseline-vs-dockhand.png";
export const BASELINE_HEADING = "## 4. Baseline: an ordinary recorded script on the same 42 cases";

/**
 * script: the Playwright export as-is · scriptPrimary: the same export with one selector per step ·
 * noHealNoReadBack / noHealReadBack: the runner with its heal ladder off · dockhand: section 1's live rows.
 */
export const ARMS = ["script", "scriptPrimary", "noHealNoReadBack", "noHealReadBack", "dockhand"] as const;
export type ArmKey = (typeof ARMS)[number];

/**
 * correct: submitted, every field right · safe_stop: stopped without writing where stopping is required (a new
 * required field) · stopped: stopped without writing where a submission was due · wrong_write: submitted with a
 * wrong, missing or extra field (silent wrong).
 */
export type Outcome = "correct" | "safe_stop" | "stopped" | "wrong_write";

export interface Counts {
  cases: number;
  correct: number;
  safeStop: number;
  stopped: number;
  wrongWrite: number;
  /** correct + safe_stop: what the eval grader counts as ok. */
  handled: number;
}

export interface ArmResult {
  outcome: Outcome;
  /** Correct fields / graded fields in the stored submission ("0/12" when nothing was submitted). */
  fields: string;
  mismatches?: { field: string; expected: string; actual: string }[];
  /** Step the run stopped at ("s13 Product"), when it stopped. */
  stoppedAt?: string;
  error?: string;
  ms: number;
  /** Recorded script only: the non-GET requests it sent (method and path). */
  requests?: string[];
}

export interface CaseRow {
  caseId: string;
  /** The UI change: the mutation operator, or "ui v2". */
  change: string;
  expectedCategory?: string;
  arms: Partial<Record<ArmKey, ArmResult>>;
}

export interface ArmSummary {
  label: string;
  method: string;
  counts: Counts;
  perChange: Record<string, Counts>;
  /** The same arm on the unchanged v1 portal with the same 42 parameter sets (no UI change). */
  control?: Counts;
  modelCalls: number;
}

export interface BaselineSummary {
  label: string;
  measured: string;
  cases: {
    count: number;
    seeds: number[];
    suites: Record<string, number>;
    /** The portal calendar date the headline generated its cases with (close dates are relative to it). */
    caseDate: string;
    /** Every case id is in the headline rows with the same number of graded fields. */
    sameAsHeadline: boolean;
  };
  skill: { file: string; sha256: string; name: string; version: number };
  portal: { id: string; latencyMs: [number, number]; local: boolean };
  ledger: { file: string; modelCallRows: number };
  arms: Record<ArmKey, ArmSummary>;
  rows: CaseRow[];
}

export function emptyCounts(): Counts {
  return { cases: 0, correct: 0, safeStop: 0, stopped: 0, wrongWrite: 0, handled: 0 };
}

export function addOutcome(c: Counts, o: Outcome): void {
  c.cases++;
  if (o === "correct") c.correct++;
  else if (o === "safe_stop") c.safeStop++;
  else if (o === "stopped") c.stopped++;
  else c.wrongWrite++;
  if (o === "correct" || o === "safe_stop") c.handled++;
}

/** The outcome class of one graded run, from the same grade the headline uses. */
export function outcomeOf(r: Pick<EvalRecord, "fields" | "silentWrong" | "expectedCategory">): Outcome {
  if (r.silentWrong) return "wrong_write";
  const submitted = r.fields.correct > 0 || r.fields.mismatches.length > 0;
  if (submitted) return "correct";
  return r.expectedCategory === "must_fail_safe" ? "safe_stop" : "stopped";
}

/** The UI change a case carries, named as the headline's heal chart names it. */
export function changeOf(r: { operators: string[]; ui: string }): string {
  return r.operators.join("+") || (r.ui === "v2" ? "ui v2" : "no change");
}

export function readBaselineSummary(): BaselineSummary | null {
  return existsSync(BASELINE_JSON)
    ? (JSON.parse(readFileSync(BASELINE_JSON, "utf8")) as BaselineSummary)
    : null;
}

// ---------- Markdown ----------

const ARM_TITLE: Record<ArmKey, string> = {
  script: "Recorded script: the Playwright export, as-is",
  scriptPrimary: "Recorded script, one selector per step",
  noHealNoReadBack: "Dockhand runner, heal ladder off, read-back off",
  noHealReadBack: "Dockhand runner, heal ladder off, read-back on",
  dockhand: "Dockhand: heal ladder + read-back (section 1, live)",
};

function stoppedText(c: Counts): string {
  const n = c.stopped + c.safeStop;
  if (n === 0) return "0";
  return c.safeStop === 0 ? String(n) : `${n} (${c.safeStop} required)`;
}

/** Where an arm stopped on one change ("s13 Product", "s2 Go to deal registrations ×2"). */
function stopSites(rows: CaseRow[], change: string, arm: ArmKey): string {
  const sites = new Map<string, number>();
  for (const r of rows) {
    if (r.change !== change) continue;
    const a = r.arms[arm];
    if (!a || a.outcome === "correct" || a.outcome === "wrong_write" || !a.stoppedAt) continue;
    sites.set(a.stoppedAt, (sites.get(a.stoppedAt) ?? 0) + 1);
  }
  return [...sites].map(([s, n]) => (n > 1 ? `${s} ×${n}` : s)).join(", ");
}

function cell(c: Counts, sites = ""): string {
  const parts: string[] = [];
  if (c.correct) parts.push(`${c.correct} correct`);
  if (c.safeStop) parts.push(`${c.safeStop} stopped as required`);
  if (c.stopped) parts.push(`${c.stopped} stopped${sites ? ` (${sites})` : ""}`);
  if (c.wrongWrite) parts.push(`**${c.wrongWrite} wrong write${c.wrongWrite === 1 ? "" : "s"}**`);
  return parts.join(", ") || "none";
}

/** What the read-back gate alone changed, from the two runner arms that differ only in it. */
function readBackLine(s: BaselineSummary): string {
  const off = s.arms.noHealNoReadBack.counts;
  const on = s.arms.noHealReadBack.counts;
  const baseline: ArmKey[] = ["script", "scriptPrimary", "noHealNoReadBack", "noHealReadBack"];
  const wrong = baseline.reduce((n, k) => n + s.arms[k].counts.wrongWrite, 0);
  if (off.wrongWrite === 0) {
    return `Read-back alone: with the heal ladder off, no case wrote a wrong value even without the read-back gate (${off.wrongWrite} wrong writes with the gate off, ${on.wrongWrite} with it on), so on these cases it had nothing to prevent.${wrong === 0 ? " Every baseline failure was a stop where a recorded selector or dropdown option no longer matched; none submitted wrong data." : ""}`;
  }
  return `Read-back alone: with the heal ladder off, the read-back gate turned ${off.wrongWrite - on.wrongWrite} of ${off.wrongWrite} wrong writes into stops.`;
}

/** The Baseline section of evals/results/live-headline.md. */
export function baselineMarkdown(s: BaselineSummary): string {
  const changes = Object.keys(s.arms.dockhand.perChange);
  const suites = Object.entries(s.cases.suites)
    .map(([k, v]) => `${v} ${k}`)
    .join(" + ");
  const control = (k: ArmKey) => {
    const c = s.arms[k].control;
    return c ? `${c.correct}/${c.cases}` : "–";
  };
  const lines = [
    BASELINE_HEADING,
    `Same mock portal (Caravela), same held-out seeds (${s.cases.seeds.join(", ")}), the same ${s.cases.count} cases (${suites}, regenerated from the seeds with the headline's case date ${s.cases.caseDate}; every case id and graded-field count matches section 1) and the same field-by-field grader against the portal's stored submission. No model calls: no model client is created and the eval ledger has ${s.ledger.modelCallRows} model-call rows. Measured ${s.measured}. Script: \`scripts/evals/baseline.ts\`; rows: \`evals/results/baseline-recorded-script.json\`.`,
    "",
    "| Arm | Correct submission | Stopped without submitting | Wrong write (silent) | Handled | Unchanged UI, same params (control) |",
    "|---|---|---|---|---|---|",
    ...ARMS.map((k) => {
      const c = s.arms[k].counts;
      return `| ${ARM_TITLE[k]} | ${c.correct} | ${stoppedText(c)} | ${c.wrongWrite} | ${c.handled}/${c.cases} | ${control(k)} |`;
    }),
    "",
    "Handled = a correct submission, or a stop where stopping is required (the new required field; guessing it would be a wrong write). Required stops are counted in the stopped column.",
    "",
    "Method. Recorded script: `exportPlaywright` (packages/skills) of the same compiled v1 skill, run as-is in a fresh browser per case with Playwright's default 30 s timeouts: no healing, no read-back, no approval gate. Each exported step tries its stored selectors in rank order (test id, role, label, CSS, placeholder), which is more forgiving than a codegen recording, so the second row runs the same export cut to each step's primary selector (test id for most steps; role and name for the two dropdowns and the consent checkbox). Optional values a case leaves out are passed as empty strings. Runner rows: the same v1 program in Dockhand's runner with the primary selector only and the heal ladder off (no similarity, no widget swap, no repair models, no rep answers); they differ only in the read-back gate before the submit. Dockhand: the live rows of section 1, not re-run.",
    "",
    readBackLine(s),
    "",
    "| UI change | Cases | Script, as exported | One selector per step | Heal off, read-back off | Heal off, read-back on | Dockhand |",
    "|---|---|---|---|---|---|---|",
    ...changes.map((ch) => {
      const n = s.arms.dockhand.perChange[ch]?.cases ?? 0;
      const get = (k: ArmKey) =>
        cell(s.arms[k].perChange[ch] ?? emptyCounts(), k === "dockhand" ? "" : stopSites(s.rows, ch, k));
      return `| ${ch} | ${n} | ${ARMS.map(get).join(" | ")} |`;
    }),
    "",
    `![recorded script vs Dockhand](${BASELINE_PNG})`,
    "",
  ];
  return lines.join("\n");
}

/** `md` with the Baseline section replaced (or appended when it is not there yet). */
export function upsertBaselineSection(md: string, section: string): string {
  const start = md.indexOf(BASELINE_HEADING);
  if (start < 0) return `${md.replace(/\s*$/, "\n")}\n${section}`;
  const next = md.indexOf("\n## ", start + BASELINE_HEADING.length);
  return md.slice(0, start) + section + (next < 0 ? "" : md.slice(next + 1));
}

// ---------- chart ----------

const INK = { primary: "#0b0b0b", secondary: "#52514e", muted: "#898781", grid: "#e1e0d9", axis: "#c3c2b7" };
const SURFACE = "#fcfcfb";
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

/** Outcome colors are the eval charts' bucket colors (clean pass, safe stop, failed, silent wrong). */
export const OUTCOME_STYLE: Record<Outcome, { label: string; color: string; ink: string }> = {
  correct: { label: "Correct submission", color: BUCKET_STYLE.clean.color, ink: BUCKET_STYLE.clean.ink },
  safe_stop: {
    label: "Stopped, as required (new required field)",
    color: BUCKET_STYLE.safe_stop.color,
    ink: BUCKET_STYLE.safe_stop.ink,
  },
  stopped: {
    label: "Stopped without submitting",
    color: BUCKET_STYLE.failed.color,
    ink: BUCKET_STYLE.failed.ink,
  },
  wrong_write: {
    label: "Wrong write (silent)",
    color: BUCKET_STYLE.silent_wrong.color,
    ink: BUCKET_STYLE.silent_wrong.ink,
  },
};
const ORDER: Outcome[] = ["correct", "safe_stop", "stopped", "wrong_write"];

const ARM_CHART: Record<ArmKey, { name: string; sub: string; column: string }> = {
  script: {
    name: "Recorded script",
    sub: "Playwright export of the same skill, as-is",
    column: "Script, as exported",
  },
  scriptPrimary: {
    name: "Recorded script, one selector",
    sub: "the same export, primary selector per step",
    column: "One selector",
  },
  noHealNoReadBack: {
    name: "Runner, heal off, read-back off",
    sub: "primary selector only, no read-back gate",
    column: "Heal off, no read-back",
  },
  noHealReadBack: {
    name: "Runner, heal off, read-back on",
    sub: "primary selector only + read-back gate",
    column: "Heal off + read-back",
  },
  dockhand: { name: "Dockhand", sub: "heal ladder + read-back (live, Oct 28)", column: "Dockhand" },
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function text(
  x: number,
  y: number,
  s: string,
  o: {
    size?: number;
    fill?: string;
    weight?: number;
    anchor?: "start" | "middle" | "end";
    tabular?: boolean;
  } = {},
): string {
  return `<text x="${x}" y="${y}" font-size="${o.size ?? 13}" fill="${o.fill ?? INK.secondary}" font-weight="${o.weight ?? 400}" text-anchor="${o.anchor ?? "start"}"${o.tabular ? ' style="font-variant-numeric: tabular-nums"' : ""}>${esc(s)}</text>`;
}

/** Horizontal bar segment; `round` gives the data end (right) 4px rounded corners. */
function hbar(x: number, y: number, w: number, h: number, fill: string, round: boolean): string {
  if (w <= 0) return "";
  const r = round ? Math.min(4, w / 2, h / 2) : 0;
  return `<path d="M${x},${y} h${w - r} q${r},0 ${r},${r} v${h - 2 * r} q0,${r} ${-r},${r} h${-(w - r)} z" fill="${fill}"/>`;
}

/**
 * Top: one 100% stacked bar per arm over all cases. Bottom: one square per case, per UI change and arm, so every
 * case is visible. Counts are printed; color is never the only cue.
 */
export function baselineChartHtml(s: BaselineSummary): { html: string; w: number; h: number } {
  const W = 1200;
  const labelX = 32;
  const plotX = 380;
  const plotW = 620;
  const rightX = plotX + plotW + 28;
  const changes = Object.keys(s.arms.dockhand.perChange);
  const rowA = 46;
  const barH = 22;
  const topA = 150;
  const topB = topA + ARMS.length * rowA + 64;
  const rowB = 26;
  const sq = 14;
  const gap = 2;
  const H = topB + 34 + changes.length * rowB + 64;
  const n = s.cases.count;

  let svg = "";
  svg += text(32, 40, `Same ${n} UI changes: an ordinary recorded script vs Dockhand`, {
    size: 20,
    fill: INK.primary,
    weight: 600,
  });
  svg += text(
    32,
    64,
    `Caravela mock portal · held-out seeds ${s.cases.seeds.join("/")} · every mutation operator plus the v2 UI · graded field by field against the portal's stored submission`,
    { size: 13 },
  );

  let lx = 32;
  for (const o of ORDER) {
    const st = OUTCOME_STYLE[o];
    svg += `<rect x="${lx}" y="88" width="12" height="12" rx="3" fill="${st.color}"/>`;
    svg += text(lx + 18, 99, st.label, { size: 12 });
    lx += 34 + st.label.length * 6.4;
  }

  // ---- A: totals per arm ----
  svg += text(labelX, topA - 20, `All ${n} cases`, { size: 13, fill: INK.primary, weight: 600 });
  svg += text(rightX, topA - 20, "Wrong writes", { size: 12, fill: INK.secondary, weight: 600 });
  for (const t of [0, 0.5, 1]) {
    const x = plotX + t * plotW;
    svg += `<line x1="${x}" y1="${topA - 8}" x2="${x}" y2="${topA + ARMS.length * rowA - 14}" stroke="${t === 0 ? INK.axis : INK.grid}" stroke-width="1"/>`;
    svg += text(x, topA + ARMS.length * rowA + 2, `${Math.round(t * n)}`, {
      size: 12,
      fill: INK.muted,
      anchor: "middle",
      tabular: true,
    });
  }
  svg += text(plotX + plotW / 2, topA + ARMS.length * rowA + 20, "Cases", {
    size: 12,
    fill: INK.secondary,
    anchor: "middle",
  });
  ARMS.forEach((k, i) => {
    const y = topA + i * rowA;
    const c = s.arms[k].counts;
    svg += text(labelX, y + 10, ARM_CHART[k].name, { size: 13, fill: INK.primary, weight: 600 });
    svg += text(labelX, y + 26, ARM_CHART[k].sub, { size: 12, fill: INK.muted });
    const parts: [Outcome, number][] = [
      ["correct", c.correct],
      ["safe_stop", c.safeStop],
      ["stopped", c.stopped],
      ["wrong_write", c.wrongWrite],
    ];
    const segs = parts.filter(([, v]) => v > 0);
    let x = plotX;
    segs.forEach(([o, v], j) => {
      const w = (v / c.cases) * plotW;
      const last = j === segs.length - 1;
      const g = last ? 0 : 2;
      svg += hbar(x, y, Math.max(0, w - g), barH, OUTCOME_STYLE[o].color, last);
      const label = String(v);
      if (w - g >= label.length * 8 + 12) {
        svg += text(x + (w - g) / 2, y + 15.5, label, {
          size: 12,
          fill: OUTCOME_STYLE[o].ink,
          weight: 600,
          anchor: "middle",
          tabular: true,
        });
      }
      x += w;
    });
    if (c.wrongWrite > 0) {
      svg += `<rect x="${rightX}" y="${y + 5}" width="12" height="12" rx="3" fill="${OUTCOME_STYLE.wrong_write.color}"/>`;
      svg += text(rightX + 18, y + 16, `${c.wrongWrite} of ${c.cases}`, {
        size: 13,
        fill: INK.primary,
        weight: 700,
      });
    } else {
      svg += text(rightX, y + 16, "0", { size: 13, fill: INK.muted, tabular: true });
    }
  });

  // ---- B: one square per case ----
  const colW = 150;
  svg += text(labelX, topB - 20, "Per UI change, one square per case", {
    size: 13,
    fill: INK.primary,
    weight: 600,
  });
  ARMS.forEach((k, j) => {
    svg += text(plotX + j * colW, topB, ARM_CHART[k].column, { size: 12, fill: INK.secondary, weight: 600 });
  });
  changes.forEach((ch, i) => {
    const y = topB + 16 + i * rowB;
    const rows = s.rows.filter((r) => r.change === ch);
    svg += text(labelX, y + 11, ch, { size: 13, fill: INK.primary, weight: 600 });
    svg += text(labelX + 190, y + 11, `N=${rows.length}`, { size: 12, fill: INK.muted, tabular: true });
    svg += `<line x1="${labelX}" y1="${y + rowB - 5}" x2="${plotX + ARMS.length * colW - 30}" y2="${y + rowB - 5}" stroke="${INK.grid}" stroke-width="1"/>`;
    ARMS.forEach((k, j) => {
      rows.forEach((r, m) => {
        const o = r.arms[k]?.outcome;
        if (!o) return;
        const x = plotX + j * colW + m * (sq + gap);
        svg += `<rect x="${x}" y="${y}" width="${sq}" height="${sq}" rx="3" fill="${OUTCOME_STYLE[o].color}"/>`;
      });
    });
  });

  const controls = ARMS.flatMap((k) => {
    const c = s.arms[k].control;
    return c ? [`${ARM_CHART[k].column.toLowerCase()} ${c.correct}/${c.cases}`] : [];
  });
  svg += text(
    32,
    H - 40,
    `Baseline arms measured ${s.measured} on the mock portal with ${s.ledger.modelCallRows} model calls (eval ledger). Dockhand: the live heal-ladder run of section 1 (2026-10-28), same cases.`,
    { size: 12, fill: INK.muted },
  );
  svg += text(
    32,
    H - 20,
    `${controls.length ? `Same parameters on the unchanged portal (control): ${controls.join(", ")} correct. ` : ""}Ground truth: portal submission log.`,
    { size: 12, fill: INK.muted },
  );

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:${SURFACE};font-family:${FONT}}svg{display:block}</style></head><body><svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family='${FONT}'>${svg}</svg></body></html>`;
  return { html, w: W, h: H };
}

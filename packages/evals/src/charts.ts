// Hand-rolled SVG charts rendered to PNG through the browser package (no chart library). Light surface,
// labeled axes, a footnote with N, seed, date and provider on every chart. Colors are the dataviz reference
// palette; the outcome order below passes the adjacent-pair checks (failed is a deliberate neutral gray).

import type { RenderOptions } from "@dockhand/browser";
import { renderHtml } from "@dockhand/browser";
import type { EvalRecord } from "./run.ts";
import { BUCKETS, type Bucket, bucketOf, percentile, providerText, REAL_PROVIDERS } from "./summary.ts";

const INK = { primary: "#0b0b0b", secondary: "#52514e", muted: "#898781", grid: "#e1e0d9", axis: "#c3c2b7" };
const SURFACE = "#fcfcfb";
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

export const BUCKET_STYLE: Record<Bucket, { label: string; color: string; ink: string }> = {
  clean: { label: "Clean pass", color: "#2a78d6", ink: "#ffffff" },
  healed_fallback: { label: "Healed · fallback", color: "#1baf7a", ink: "#ffffff" },
  healed_similarity: { label: "Healed · similarity", color: "#eda100", ink: "#0b0b0b" },
  healed_open_weights: { label: "Healed · open weights", color: "#e87ba4", ink: "#ffffff" },
  healed_computer_use: { label: "Healed · computer use", color: "#008300", ink: "#ffffff" },
  healed_ask_rep: { label: "Healed · ask rep", color: "#6250d6", ink: "#ffffff" },
  safe_stop: { label: "Safe stop", color: "#eb6834", ink: "#ffffff" },
  failed: { label: "Failed (no write)", color: "#898781", ink: "#ffffff" },
  silent_wrong: { label: "Silent wrong", color: "#d03b3b", ink: "#ffffff" },
};

const CATEGORY_LABEL: Record<string, string> = {
  heal_deterministic: "expected: free heal",
  heal_deterministic_or_model: "expected: free or model heal",
  heal_model: "expected: needs a model",
  must_fail_safe: "expected: stop and ask",
};

export interface ChartMeta {
  title: string;
  /** e.g. "seed 1 · repair none". */
  scope: string;
  date: string;
}

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

/** Column growing up from `base`, rounded at the top (data end). */
function column(x: number, base: number, w: number, h: number, fill: string): string {
  if (h <= 0) return "";
  const r = Math.min(4, w / 2, h);
  return `<path d="M${x},${base} v${-(h - r)} q0,${-r} ${r},${-r} h${w - 2 * r} q${r},0 ${r},${r} v${h - r} z" fill="${fill}"/>`;
}

function page(svg: string, w: number, h: number): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:${SURFACE};font-family:${FONT}}svg{display:block}</style></head><body><svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family='${FONT}'>${svg}</svg></body></html>`;
}

function header(meta: ChartMeta, subtitle: string): string {
  return (
    text(32, 40, meta.title, { size: 20, fill: INK.primary, weight: 600 }) +
    text(32, 64, subtitle, { size: 13 })
  );
}

function footnote(y: number, s: string): string {
  return text(32, y, s, { size: 12, fill: INK.muted });
}

function providerNote(rows: readonly EvalRecord[]): string {
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.provider] = (counts[r.provider] ?? 0) + 1;
  const calls = rows.reduce((s, r) => s + r.modelCalls, 0);
  return `provider ${providerText(counts)} (${calls} model call${calls === 1 ? "" : "s"})`;
}

// ---------- (a) mutation robustness ----------

/** Per operator, a 100% stacked bar of run outcomes, labeled with the operator's expected category. */
export function mutationChartHtml(
  rows: readonly EvalRecord[],
  meta: ChartMeta,
): { html: string; w: number; h: number } {
  const ops = new Map<string, { category?: string; buckets: Record<Bucket, number>; n: number }>();
  for (const r of rows) {
    const key = r.operators.join("+") || (r.ui === "v2" ? "ui v2" : "no change");
    const o = ops.get(key) ?? {
      n: 0,
      buckets: Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<Bucket, number>,
    };
    if (r.expectedCategory) o.category = r.expectedCategory;
    o.n++;
    o.buckets[bucketOf(r)]++;
    ops.set(key, o);
  }
  const present = BUCKETS.filter((b) => b === "silent_wrong" || rows.some((r) => bucketOf(r) === b));
  const W = 1200;
  const labelW = 250;
  const plotX = 32 + labelW;
  const swW = 110;
  const plotW = W - plotX - swW - 40;
  const rowH = 40;
  const barH = 22;
  const top = 132;
  const H = top + ops.size * rowH + 96;
  let svg = header(
    meta,
    "Outcome of each replay after one injected UI change, per operator (share of runs; counts inside).",
  );

  // legend: one row of swatches above the plot
  let lx = 32;
  for (const b of present) {
    const s = BUCKET_STYLE[b];
    svg += `<rect x="${lx}" y="88" width="12" height="12" rx="3" fill="${s.color}"/>`;
    svg += text(lx + 18, 99, s.label, { size: 12, fill: INK.secondary });
    lx += 26 + s.label.length * 6.6;
  }

  // gridlines and x axis (share of runs)
  const plotBottom = top + ops.size * rowH - (rowH - barH) / 2 + 4;
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const x = plotX + t * plotW;
    svg += `<line x1="${x}" y1="${top - 8}" x2="${x}" y2="${plotBottom}" stroke="${t === 0 ? INK.axis : INK.grid}" stroke-width="1"/>`;
    svg += text(x, plotBottom + 18, `${Math.round(t * 100)}%`, {
      size: 12,
      fill: INK.muted,
      anchor: "middle",
      tabular: true,
    });
  }
  svg += text(plotX + plotW / 2, plotBottom + 38, "Share of runs", {
    size: 12,
    fill: INK.secondary,
    anchor: "middle",
  });
  svg += text(plotX + plotW + 28, top - 14, "Silent wrong", { size: 12, fill: INK.secondary, weight: 600 });

  let y = top;
  for (const [op, o] of ops) {
    svg += text(32, y + 10, op, { size: 13, fill: INK.primary, weight: 600 });
    svg += text(
      32,
      y + 26,
      `${o.category ? (CATEGORY_LABEL[o.category] ?? o.category) : ""}${o.category ? " · " : ""}N=${o.n}`,
      {
        size: 12,
        fill: INK.muted,
      },
    );
    const segs = BUCKETS.filter((b) => o.buckets[b] > 0);
    let x = plotX;
    segs.forEach((b, i) => {
      const w = (o.buckets[b] / o.n) * plotW;
      const last = i === segs.length - 1;
      const gap = last ? 0 : 2; // surface gap between touching segments
      svg += hbar(x, y, Math.max(0, w - gap), barH, BUCKET_STYLE[b].color, last);
      const label = String(o.buckets[b]);
      if (w - gap >= label.length * 8 + 12) {
        svg += text(x + (w - gap) / 2, y + 15.5, label, {
          size: 12,
          fill: BUCKET_STYLE[b].ink,
          weight: 600,
          anchor: "middle",
          tabular: true,
        });
      }
      x += w;
    });
    const sw = o.buckets.silent_wrong;
    if (sw > 0) {
      svg += `<rect x="${plotX + plotW + 28}" y="${y + 5}" width="12" height="12" rx="3" fill="${BUCKET_STYLE.silent_wrong.color}"/>`;
      svg += text(plotX + plotW + 46, y + 16, `${sw} of ${o.n}`, {
        size: 13,
        fill: INK.primary,
        weight: 700,
      });
    } else {
      svg += text(plotX + plotW + 28, y + 16, "0", { size: 13, fill: INK.muted, tabular: true });
    }
    y += rowH;
  }
  const silent = rows.filter((r) => r.silentWrong).length;
  svg += footnote(
    H - 22,
    `N=${rows.length} runs · ${meta.scope} · ${meta.date} · ${providerNote(rows)} · silent wrong ${silent} of ${rows.length} · ground truth: portal submission log`,
  );
  return { html: page(svg, W, H), w: W, h: H };
}

// ---------- (b) replay timing and success over N ----------

export function replayChartHtml(
  rows: readonly EvalRecord[],
  meta: ChartMeta,
): { html: string; w: number; h: number } {
  const W = 1200;
  const H = 480;
  const ms = rows.map((r) => r.ms);
  const p50 = percentile(ms, 0.5);
  const p90 = percentile(ms, 0.9);
  const ok = rows.filter((r) => r.ok).length;
  let svg = header(
    meta,
    `Left: wall time per replay (p50 ${(p50 / 1000).toFixed(2)} s, p90 ${(p90 / 1000).toFixed(2)} s). Right: cumulative success rate over the run order.`,
  );

  // histogram
  const px = 90;
  const pw = 470;
  const top = 110;
  const base = 390;
  const bins = 14;
  const start = Math.floor(Math.min(...ms) / 100) * 100;
  const span = Math.max(100, Math.ceil((Math.max(...ms) - start + 1) / bins / 100) * 100);
  const counts = new Array<number>(bins).fill(0);
  for (const v of ms) {
    const bin = Math.min(bins - 1, Math.floor((v - start) / span));
    counts[bin] = (counts[bin] ?? 0) + 1;
  }
  const maxCount = Math.max(...counts, 1);
  const yStep = Math.max(1, Math.ceil(maxCount / 4));
  const yMax = Math.ceil(maxCount / yStep) * yStep;
  for (let c = 0; c <= yMax; c += yStep) {
    const y = base - (c / yMax) * (base - top);
    svg += `<line x1="${px}" y1="${y}" x2="${px + pw}" y2="${y}" stroke="${c === 0 ? INK.axis : INK.grid}" stroke-width="1"/>`;
    svg += text(px - 10, y + 4, String(c), { size: 12, fill: INK.muted, anchor: "end", tabular: true });
  }
  const slot = pw / bins;
  const colW = Math.min(24, slot - 4);
  counts.forEach((c, i) => {
    const h = (c / yMax) * (base - top);
    svg += column(px + i * slot + (slot - colW) / 2, base, colW, h, "#2a78d6");
  });
  const xOf = (v: number) => px + ((v - start) / (span * bins)) * pw;
  for (let i = 0; i <= bins; i += 2) {
    svg += text(px + i * slot, base + 18, `${((start + i * span) / 1000).toFixed(1)}`, {
      size: 12,
      fill: INK.muted,
      anchor: "middle",
      tabular: true,
    });
  }
  // Marker labels sit above the plot (staggered) so they never collide with a tall column.
  for (const [label, v, dy] of [
    ["p50", p50, -14],
    ["p90", p90, 0],
  ] as const) {
    const x = xOf(v);
    svg += `<line x1="${x}" y1="${top - 26}" x2="${x}" y2="${base}" stroke="${INK.primary}" stroke-width="1.5"/>`;
    svg += text(x + 5, top - 12 + dy, `${label} ${(v / 1000).toFixed(2)} s`, {
      size: 12,
      fill: INK.primary,
      weight: 600,
    });
  }
  svg += text(px + pw / 2, base + 40, "Seconds per run", { size: 12, fill: INK.secondary, anchor: "middle" });
  svg += `<text x="34" y="${(top + base) / 2}" font-size="12" fill="${INK.secondary}" text-anchor="middle" transform="rotate(-90 34 ${(top + base) / 2})">Runs</text>`;

  // success over N
  const qx = 700;
  const qw = 440;
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const y = base - t * (base - top);
    svg += `<line x1="${qx}" y1="${y}" x2="${qx + qw}" y2="${y}" stroke="${t === 0 ? INK.axis : INK.grid}" stroke-width="1"/>`;
    svg += text(qx - 10, y + 4, `${t * 100}%`, { size: 12, fill: INK.muted, anchor: "end", tabular: true });
  }
  let passed = 0;
  const pts = rows.map((r, i) => {
    if (r.ok) passed++;
    const x = qx + (rows.length > 1 ? (i / (rows.length - 1)) * qw : qw);
    const y = base - (passed / (i + 1)) * (base - top);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  svg += `<polyline points="${pts.join(" ")}" fill="none" stroke="#2a78d6" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  const last = pts.at(-1)?.split(",").map(Number) ?? [qx + qw, base];
  svg += `<circle cx="${last[0]}" cy="${last[1]}" r="5" fill="#2a78d6" stroke="${SURFACE}" stroke-width="2"/>`;
  svg += text(
    (last[0] as number) - 8,
    (last[1] as number) - 12,
    `${((ok / Math.max(1, rows.length)) * 100).toFixed(1)}% (${ok}/${rows.length})`,
    {
      size: 13,
      fill: INK.primary,
      weight: 600,
      anchor: "end",
    },
  );
  for (const i of [1, Math.ceil(rows.length / 2), rows.length]) {
    const x = qx + (rows.length > 1 ? ((i - 1) / (rows.length - 1)) * qw : qw);
    svg += text(x, base + 18, String(i), { size: 12, fill: INK.muted, anchor: "middle", tabular: true });
  }
  svg += text(qx + qw / 2, base + 40, "Runs so far (N)", { size: 12, fill: INK.secondary, anchor: "middle" });

  svg += footnote(
    H - 22,
    `N=${rows.length} runs · ${meta.scope} · ${meta.date} · ${providerNote(rows)} · ${rows[0]?.concurrency ?? 1} runs in parallel · wall time includes the portal's simulated submit latency`,
  );
  return { html: page(svg, W, H), w: W, h: H };
}

// ---------- (c) cost per run by mode ----------

export type CostMode = "agentic" | "replay" | "repair";

export function costModeOf(r: EvalRecord): CostMode | null {
  if (r.suite === "agentic") return "agentic";
  if (r.suite === "replay") return "replay";
  if (r.suite === "repair" || r.suite === "mutation") return "repair";
  return null;
}

/** Mean execution cost per run by mode, from Meta/Baseten rows only; a labeled empty frame until those exist. */
export function costChartHtml(
  rows: readonly EvalRecord[],
  meta: ChartMeta,
): { html: string; w: number; h: number } {
  const W = 1200;
  const H = 430;
  const live = rows.filter((r) => REAL_PROVIDERS.includes(r.provider) && costModeOf(r) !== null);
  const modes: CostMode[] = ["agentic", "replay", "repair"];
  let svg = header(
    meta,
    "Mean execution cost per run (USD, Standard list price), live Meta / Baseten runs only.",
  );
  const px = 200;
  const pw = 900;
  const top = 110;
  const rowH = 70;
  const base = top + modes.length * rowH;
  const max = Math.max(...live.map((r) => r.execCostUsd), 0);
  const scaleMax = max > 0 ? niceCeil(max) : 1;
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const x = px + t * pw;
    svg += `<line x1="${x}" y1="${top - 10}" x2="${x}" y2="${base}" stroke="${t === 0 ? INK.axis : INK.grid}" stroke-width="1"/>`;
    if (live.length > 0) {
      svg += text(x, base + 18, `$${(t * scaleMax).toFixed(scaleMax < 0.1 ? 3 : 2)}`, {
        size: 12,
        fill: INK.muted,
        anchor: "middle",
        tabular: true,
      });
    }
  }
  svg += text(px + pw / 2, base + 40, "USD per run", { size: 12, fill: INK.secondary, anchor: "middle" });
  modes.forEach((m, i) => {
    const y = top + i * rowH + 14;
    const mRows = live.filter((r) => costModeOf(r) === m);
    svg += text(
      32,
      y + 16,
      m === "agentic" ? "Agentic first run" : m === "replay" ? "Replay" : "Replay + repair",
      {
        size: 13,
        fill: INK.primary,
        weight: 600,
      },
    );
    svg += text(32, y + 32, `N=${mRows.length}`, { size: 12, fill: INK.muted });
    if (mRows.length > 0) {
      const mean = mRows.reduce((s, r) => s + r.execCostUsd, 0) / mRows.length;
      const w = (mean / scaleMax) * pw;
      svg += hbar(px, y, w, 24, "#2a78d6", true);
      svg += text(px + w + 8, y + 17, `$${mean.toFixed(4)}`, {
        size: 13,
        fill: INK.primary,
        weight: 600,
        tabular: true,
      });
    }
  });
  if (live.length === 0) {
    svg += `<rect x="${px + 1}" y="${top - 9}" width="${pw - 2}" height="${base - top + 8}" fill="${SURFACE}" fill-opacity="0.85"/>`;
    svg += text(px + pw / 2, (top + base) / 2 + 6, "Needs live runs (no Meta key yet)", {
      size: 18,
      fill: INK.secondary,
      weight: 600,
      anchor: "middle",
    });
  }
  const excluded = rows.length - live.length;
  svg += footnote(
    H - 22,
    `N=${live.length} live runs · ${meta.scope} · ${meta.date} · provider ${providerText(countBy(live))} · ${excluded} runs without a live model call not plotted (deterministic replays make 0 model calls)`,
  );
  return { html: page(svg, W, H), w: W, h: H };
}

function countBy(rows: readonly EvalRecord[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.provider] = (out[r.provider] ?? 0) + 1;
  return out;
}

function niceCeil(v: number): number {
  const exp = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * exp) return m * exp;
  return 10 * exp;
}

export async function renderChart(
  chart: { html: string; w: number; h: number },
  opts: RenderOptions = {},
): Promise<Uint8Array> {
  return renderHtml(chart.html, { w: chart.w, h: chart.h }, opts);
}

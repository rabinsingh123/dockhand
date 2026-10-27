import { pngSize } from "@dockhand/browser";
import { describe, expect, it } from "vitest";
import { costChartHtml, mutationChartHtml, renderChart, replayChartHtml } from "./charts.ts";
import type { EvalRecord } from "./run.ts";

function row(over: Partial<EvalRecord>): EvalRecord {
  return {
    caseId: "c",
    suite: "mutation",
    ok: true,
    outcome: "success",
    fields: { correct: 12, total: 12, mismatches: [] },
    silentWrong: false,
    safeStop: false,
    heals: [],
    ms: 1200,
    execCostUsd: 0,
    modelCalls: 0,
    provider: "none",
    skill: "caravela_register_deal",
    portalId: "caravela",
    ui: "v1",
    operators: ["reorder_fields"],
    expectedCategory: "heal_deterministic",
    repair: "none",
    seed: 1,
    ...over,
  };
}

const meta = {
  title: "Mutation robustness · Caravela Partner Hub",
  scope: "seed 1 · repair none",
  date: "2026-10-27",
};

describe("charts", () => {
  it("renders the mutation chart to a PNG of the declared size, with categories and silent wrong labeled", async () => {
    const rows = [
      row({}),
      row({ operators: ["testid_churn"], heals: [{ rung: "fallback", count: 12 }] }),
      row({ operators: ["insert_required_field"], expectedCategory: "must_fail_safe", safeStop: true }),
      row({ operators: ["button_rename"], expectedCategory: "heal_model", ok: false, outcome: "failed" }),
      row({ operators: ["label_synonym"], ok: false, silentWrong: true }),
    ];
    const chart = mutationChartHtml(rows, meta);
    expect(chart.html).toContain("expected: stop and ask");
    expect(chart.html).toContain("Silent wrong");
    expect(chart.html).toContain(
      "N=5 runs · seed 1 · repair none · 2026-10-27 · provider none (0 model calls)",
    );
    const png = await renderChart(chart);
    expect(pngSize(png)).toEqual({ width: chart.w, height: chart.h });
  });

  it("replay chart marks p50/p90; cost chart without live rows shows the empty frame, not numbers", () => {
    const rows = [800, 900, 1000, 1500].map((ms, i) =>
      row({ caseId: `r${i}`, suite: "replay", operators: [], ms }),
    );
    const replay = replayChartHtml(rows, { ...meta, title: "Replay" });
    expect(replay.html).toContain("p50 0.90 s");
    expect(replay.html).toContain("p90 1.50 s");
    expect(replay.html).toContain("100.0% (4/4)");
    const empty = costChartHtml(rows, { ...meta, title: "Cost" });
    expect(empty.html).toContain("Needs live runs (no Meta key yet)");
    expect(empty.html).not.toMatch(/\$0\.\d{4}/);
    const live = costChartHtml(
      [...rows, row({ suite: "agentic", provider: "meta", execCostUsd: 0.42, modelCalls: 30 })],
      { ...meta, title: "Cost" },
    );
    expect(live.html).not.toContain("Needs live runs");
    expect(live.html).toContain("$0.4200");
  });
});

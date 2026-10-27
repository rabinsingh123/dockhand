import { describe, expect, it } from "vitest";
import type { EvalRecord } from "./run.ts";
import { bucketOf, headline, percentile, renderMarkdown, summarize } from "./summary.ts";

function row(over: Partial<EvalRecord>): EvalRecord {
  return {
    caseId: "c",
    suite: "replay",
    ok: true,
    outcome: "success",
    fields: { correct: 12, total: 12, mismatches: [] },
    silentWrong: false,
    safeStop: false,
    heals: [],
    ms: 1000,
    execCostUsd: 0,
    modelCalls: 0,
    provider: "none",
    skill: "caravela_register_deal",
    portalId: "caravela",
    ui: "v1",
    operators: [],
    repair: "none",
    seed: 1,
    ...over,
  };
}

describe("summary math", () => {
  it("percentiles use nearest rank", () => {
    const ms = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    expect(percentile(ms, 0.5)).toBe(500);
    expect(percentile(ms, 0.9)).toBe(900);
    expect(percentile([42], 0.9)).toBe(42);
    expect(percentile([], 0.5)).toBe(0);
  });

  it("buckets: silent wrong beats everything, then safe stop, failed, the most expensive rung, clean", () => {
    expect(bucketOf(row({}))).toBe("clean");
    expect(bucketOf(row({ heals: [{ rung: "fallback", count: 3 }] }))).toBe("healed_fallback");
    expect(
      bucketOf(
        row({
          heals: [
            { rung: "fallback", count: 1 },
            { rung: "open_weights", count: 1 },
          ],
        }),
      ),
    ).toBe("healed_open_weights");
    expect(bucketOf(row({ ok: false, outcome: "failed" }))).toBe("failed");
    expect(bucketOf(row({ ok: true, safeStop: true, outcome: "needs_input" }))).toBe("safe_stop");
    expect(bucketOf(row({ ok: false, silentWrong: true, heals: [{ rung: "fallback", count: 1 }] }))).toBe(
      "silent_wrong",
    );
  });

  it("groups by suite/skill/seed/repair and counts success, heals by rung, safe stops, silent wrong", () => {
    const rows: EvalRecord[] = [
      ...[900, 1000, 1100, 1200, 5000].map((ms, i) => row({ caseId: `r${i}`, ms })),
      row({
        caseId: "m1",
        suite: "mutation",
        operators: ["testid_churn"],
        heals: [{ rung: "fallback", count: 12 }],
      }),
      row({
        caseId: "m2",
        suite: "mutation",
        operators: ["testid_churn"],
        heals: [{ rung: "fallback", count: 11 }],
      }),
      row({
        caseId: "m3",
        suite: "mutation",
        operators: ["insert_required_field"],
        expectedCategory: "must_fail_safe",
        outcome: "needs_input",
        safeStop: true,
      }),
      row({ caseId: "m4", suite: "mutation", operators: ["button_rename"], ok: false, outcome: "failed" }),
      row({ caseId: "m5", suite: "mutation", operators: ["label_synonym"], ok: false, silentWrong: true }),
    ];
    const s = summarize(rows, new Date("2026-10-27T12:00:00Z"));
    expect(s.totals).toEqual({ runs: 10, silentWrong: 1, excludedScripted: 0 });
    const replay = s.groups.find((g) => g.suite === "replay");
    expect(replay).toMatchObject({
      n: 5,
      ok: 5,
      successRate: 1,
      silentWrong: 0,
      ms: { p50: 1100, p90: 5000 },
    });
    const mutation = s.groups.find((g) => g.suite === "mutation");
    expect(mutation).toMatchObject({
      n: 5,
      ok: 3,
      submittedCorrect: 2,
      safeStops: 1,
      failed: 1,
      silentWrong: 1,
      healedRuns: 2,
    });
    expect(mutation?.heals.fallback).toEqual({ runs: 2, steps: 23 });
    const churn = mutation?.byOperator.find((o) => o.operator === "testid_churn");
    expect(churn?.buckets.healed_fallback).toBe(2);
    expect(mutation?.byOperator.find((o) => o.operator === "insert_required_field")?.expectedCategory).toBe(
      "must_fail_safe",
    );
  });

  it("never reports scripted or fake rows as agentic first runs", () => {
    const rows = [
      row({ caseId: "a1", suite: "agentic", provider: "scripted", modelCalls: 30 }),
      row({ caseId: "a2", suite: "agentic", provider: "meta", modelCalls: 22, execCostUsd: 0.4 }),
    ];
    const s = summarize(rows);
    const g = s.groups[0];
    expect(g).toMatchObject({ n: 1, excludedScripted: 1, providers: { meta: 1 }, costPerRunUsd: 0.4 });
    expect(s.totals.excludedScripted).toBe(1);
    const onlyScripted = summarize([row({ suite: "agentic", provider: "scripted" })]).groups[0];
    expect(onlyScripted?.n).toBe(0);
    expect(headline(onlyScripted as NonNullable<typeof onlyScripted>)).toMatch(
      /agentic first run .* N=0: no reportable runs \(1 scripted rows excluded\)/,
    );
  });

  it("every headline states provider and N; the report leads with silent wrong", () => {
    const s = summarize([
      row({}),
      row({ caseId: "x", provider: "baseten", modelCalls: 1, execCostUsd: 0.002 }),
    ]);
    for (const g of s.groups) expect(headline(g)).toMatch(/provider .+ · N=\d+/);
    expect(headline(s.groups[0] as (typeof s.groups)[0])).toContain("provider mixed (none 1, baseten 1)");
    const md = renderMarkdown(s, ["cost-per-run.png"]);
    expect(md.split("\n")[2]).toBe(
      "**Silent wrong: 0 of 2 runs** (a submission with any wrong field; the number that must stay at 0).",
    );
    expect(md).toContain("![cost-per-run.png](cost-per-run.png)");
  });
});

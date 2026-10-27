// The per-eval ledger (var/evals.sqlite): model calls of eval runs never mix with the app's ledger.

import { createLedger, type Db, type EvalResult, type Ledger, type Provider } from "@dockhand/core";

export interface RunUsage {
  calls: number;
  costUsd: number;
  providers: Provider[];
}

export interface EvalLedger extends Ledger {
  /** Calls, cost and providers booked under one run id. */
  usage(runId: string): RunUsage;
}

export function createEvalLedger(db: Db): EvalLedger {
  const ledger = createLedger(db);
  const byProvider = db.raw.prepare(
    `SELECT provider, COUNT(*) AS calls, COALESCE(SUM(cost_usd), 0) AS cost
     FROM model_calls WHERE run_id = ? GROUP BY provider`,
  );
  return {
    record: (r) => ledger.record(r),
    totals: (f) => ledger.totals(f),
    usage(runId) {
      const rows = byProvider.all(runId) as { provider: Provider; calls: number; cost: number }[];
      return {
        calls: rows.reduce((n, r) => n + r.calls, 0),
        costUsd: rows.reduce((n, r) => n + r.cost, 0),
        providers: rows.map((r) => r.provider),
      };
    },
  };
}

/**
 * The provider label of a run: a real provider when one was called (Meta first), "scripted" for fake,
 * cassette and scripted models (never part of reported numbers), "none" for zero model calls.
 */
export function providerLabel(providers: readonly Provider[]): EvalResult["provider"] {
  if (providers.includes("meta")) return "meta";
  if (providers.includes("baseten")) return "baseten";
  return providers.length > 0 ? "scripted" : "none";
}

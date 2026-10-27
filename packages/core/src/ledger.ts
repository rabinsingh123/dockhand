import type { SQLInputValue } from "node:sqlite";
import { systemClock } from "./clock.ts";
import type { Clock } from "./contracts/base.ts";
import { type Ledger, PRICES, type PriceTable } from "./contracts/models.ts";
import type { Db } from "./db.ts";
import { createLogger } from "./log.ts";

/** Writes model_calls rows (one per call, inserted in the caller's `finally`) and sums them. */
export function createLedger(db: Db, clock: Clock = systemClock): Ledger {
  const insert = db.raw.prepare(
    `INSERT INTO model_calls (ts, purpose, provider, model, job_id, run_id, step_idx, response_id,
       input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, images, audio_ms, latency_ms,
       cost_usd, status, error_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  return {
    record(r) {
      insert.run(
        clock.now(),
        r.purpose,
        r.provider,
        r.model,
        r.jobId ?? null,
        r.runId ?? null,
        r.stepIdx ?? null,
        r.responseId ?? null,
        r.inputTokens,
        r.cachedInputTokens,
        r.outputTokens,
        r.reasoningTokens ?? null,
        r.images,
        r.audioMs ?? null,
        r.latencyMs,
        r.costUsd,
        r.status,
        r.errorCode ?? null,
      );
    },
    totals(f) {
      const where: string[] = [];
      const params: SQLInputValue[] = [];
      if (f.jobId !== undefined) {
        where.push("job_id = ?");
        params.push(f.jobId);
      }
      if (f.runId !== undefined) {
        where.push("run_id = ?");
        params.push(f.runId);
      }
      if (f.purposes !== undefined) {
        if (f.purposes.length === 0) return { calls: 0, costUsd: 0, latencyMs: 0 };
        where.push(`purpose IN (${f.purposes.map(() => "?").join(", ")})`);
        params.push(...f.purposes);
      }
      const row = db.raw
        .prepare(
          `SELECT COUNT(*) AS calls, COALESCE(SUM(cost_usd), 0) AS cost, COALESCE(SUM(latency_ms), 0) AS latency
           FROM model_calls ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}`,
        )
        .get(...params) as { calls: number; cost: number; latency: number };
      return { calls: row.calls, costUsd: row.cost, latencyMs: row.latency };
    },
  };
}

/**
 * USD at list price. Token models: ((input - cached) * inPerM + cached * cachedPerM + output * outPerM) / 1M.
 * Audio models: perAudioHour * hours. A model missing from the table costs 0 and logs a warning.
 */
export function costOf(
  model: string,
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number; audioMs?: number },
  prices: PriceTable = PRICES,
): number {
  const price = prices[model];
  if (!price) {
    createLogger({ fields: { mod: "ledger" } }).warn("no price for model; cost recorded as 0", { model });
    return 0;
  }
  if ("perAudioHour" in price) return ((usage.audioMs ?? 0) / 3_600_000) * price.perAudioHour;
  const uncached = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return (
    (uncached * price.inPerM +
      usage.cachedInputTokens * price.cachedPerM +
      usage.outputTokens * price.outPerM) /
    1_000_000
  );
}

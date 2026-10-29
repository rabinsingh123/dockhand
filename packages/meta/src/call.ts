import type { ModelCallRecord, Provider } from "@dockhand/core";
import {
  type CallCtx,
  type Clock,
  DockhandError,
  type ErrorCode,
  type Ledger,
  type Logger,
} from "@dockhand/core";
import { type TokenUsage, ZERO_USAGE } from "./cost.ts";
import { type RequestScope, redact } from "./http.ts";

/** One gateway call's abort signal and deadline: ctx.timeoutMs covers the whole call, retries included. */
export interface CallScope extends RequestScope {
  /** Maps any failure to a DockhandError: MODEL_TIMEOUT when our deadline fired. */
  normalize(err: unknown): DockhandError;
}

export function openScope(ctx: CallCtx): CallScope {
  if (!(ctx.timeoutMs > 0))
    throw new DockhandError("MODEL_ERROR", `ctx.timeoutMs must be positive, got ${ctx.timeoutMs}`);
  const timeout = AbortSignal.timeout(ctx.timeoutMs);
  const signal = ctx.signal ? AbortSignal.any([timeout, ctx.signal]) : timeout;
  return {
    signal,
    deadlineAt: Date.now() + ctx.timeoutMs,
    normalize(err) {
      if (err instanceof DockhandError) return err;
      if (timeout.aborted)
        return new DockhandError("MODEL_TIMEOUT", `model call exceeded ${ctx.timeoutMs} ms`);
      if (ctx.signal?.aborted) return new DockhandError("MODEL_ERROR", "model call aborted by the caller");
      const message = err instanceof Error ? err.message : String(err);
      return new DockhandError("MODEL_ERROR", redact(message));
    },
  };
}

/** What a call learned before it finished or failed; written to the ledger in `finally`. */
export interface CallRecord {
  usage: TokenUsage;
  images: number;
  responseId?: string;
  audioMs?: number;
  /** Set when the call returns normally but must not count as ok (invalid output, incomplete). */
  status?: ModelCallRecord["status"];
  errorCode?: ErrorCode;
}

export interface RecordedCall {
  ctx: CallCtx;
  provider: Provider;
  model: string;
  normalize: (err: unknown) => DockhandError;
  /** USD for the call from what was recorded (tokens or audio); 0 for unknown prices. */
  price: (rec: CallRecord) => number;
}

export interface RecorderDeps {
  ledger: Ledger;
  clock: Clock;
  log: Logger;
}

/** Runs one model call and records exactly one ledger row for it, success or failure. */
export async function recordCall<T>(
  deps: RecorderDeps,
  call: RecordedCall,
  fn: (rec: CallRecord) => Promise<T>,
): Promise<T> {
  const startedAt = deps.clock.now();
  const rec: CallRecord = { usage: { ...ZERO_USAGE }, images: 0 };
  let failure: DockhandError | undefined;
  try {
    return await fn(rec);
  } catch (err) {
    failure = call.normalize(err);
    throw failure;
  } finally {
    const errorCode = failure?.code ?? rec.errorCode;
    const status = failure ? statusFor(failure.code) : (rec.status ?? "ok");
    let costUsd = 0;
    try {
      costUsd = call.price(rec);
    } catch (err) {
      deps.log.warn("model call cost not computed", { model: call.model, error: (err as Error).message });
    }
    const row: ModelCallRecord = {
      purpose: call.ctx.purpose,
      provider: call.provider,
      model: call.model,
      ...(call.ctx.jobId !== undefined ? { jobId: call.ctx.jobId } : {}),
      ...(call.ctx.runId !== undefined ? { runId: call.ctx.runId } : {}),
      ...(call.ctx.stepIdx !== undefined ? { stepIdx: call.ctx.stepIdx } : {}),
      ...(rec.responseId !== undefined ? { responseId: rec.responseId } : {}),
      inputTokens: rec.usage.inputTokens,
      cachedInputTokens: rec.usage.cachedInputTokens,
      outputTokens: rec.usage.outputTokens,
      ...(rec.usage.reasoningTokens !== undefined ? { reasoningTokens: rec.usage.reasoningTokens } : {}),
      images: rec.images,
      ...(rec.audioMs !== undefined ? { audioMs: rec.audioMs } : {}),
      latencyMs: Math.max(0, deps.clock.now() - startedAt),
      costUsd,
      status,
      ...(errorCode !== undefined && status !== "ok" ? { errorCode } : {}),
    };
    try {
      deps.ledger.record(row);
    } catch (err) {
      deps.log.error("ledger write failed", {
        purpose: row.purpose,
        model: row.model,
        error: (err as Error).message,
      });
    }
    const summary = {
      purpose: row.purpose,
      provider: row.provider,
      model: row.model,
      status: row.status,
      errorCode: row.errorCode,
      latencyMs: row.latencyMs,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      images: row.images,
      costUsd: row.costUsd,
    };
    if (row.status === "ok") deps.log.debug("model call", summary);
    else deps.log.warn("model call failed", { ...summary, error: failure?.message });
  }
}

function statusFor(code: ErrorCode): ModelCallRecord["status"] {
  if (code === "MODEL_TIMEOUT") return "timeout";
  if (code === "MODEL_INCOMPLETE") return "incomplete";
  return "error";
}

/**
 * Live, one request in a few hundred hangs: a computer-use turn took 108 s against a p99 of ~21 s, and a PDF
 * extraction that usually takes 9-11 s outlived its 45 s deadline. Model requests are idempotent (they write
 * nothing), so one that outlives `slowMs` is abandoned and sent once more; if that one is slow too, the call
 * fails fast with MODEL_TIMEOUT instead of waiting out the whole deadline. `slowMs` 0 sends once, as does a
 * deadline too short for two attempts.
 */
export async function withSlowRetry<T>(
  env: { log: Logger },
  scope: RequestScope,
  send: (s: RequestScope) => Promise<T>,
  slowMs: number,
  what: string,
): Promise<T> {
  if (!(slowMs > 0) || scope.deadlineAt - Date.now() < slowMs * 2) return send(scope);
  for (let attempt = 1; ; attempt++) {
    const slow = AbortSignal.timeout(slowMs);
    try {
      return await send({
        signal: AbortSignal.any([scope.signal, slow]),
        deadlineAt: Math.min(scope.deadlineAt, Date.now() + slowMs),
      });
    } catch (err) {
      if (!slow.aborted || scope.signal.aborted) throw err;
      if (attempt >= 2) throw new DockhandError("MODEL_TIMEOUT", `${what} took over ${slowMs} ms twice`);
      env.log.warn(`${what} is slow; sending it once more`, { afterMs: slowMs });
    }
  }
}

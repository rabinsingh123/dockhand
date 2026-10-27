import { afterEach, describe, expect, it, vi } from "vitest";
import { createFixedClock } from "./clock.ts";
import type { ModelCallRecord } from "./contracts/models.ts";
import { openDb } from "./db.ts";
import { costOf, createLedger } from "./ledger.ts";

const usage = (inputTokens: number, cachedInputTokens: number, outputTokens: number) => ({
  inputTokens,
  cachedInputTokens,
  outputTokens,
});

describe("costOf", () => {
  afterEach(() => vi.restoreAllMocks());

  it("prices token models per 1M with cached input at the cached rate", () => {
    // spark: (10,000 - 4,000) * 1.25 + 4,000 * 0.15 + 2,000 * 4.25 = 7,500 + 600 + 8,500 = 16,600 per 1M
    expect(costOf("muse-spark-1.3", usage(10_000, 4_000, 2_000))).toBeCloseTo(0.0166, 12);
    // wonder: 1M * 4.00 + 100k * 20.00 = 4.00 + 2.00
    expect(costOf("muse-wonder-1.0", usage(1_000_000, 0, 100_000))).toBeCloseTo(6.0, 12);
    // wonder, fully cached input: 200k * 0.20 / 1M
    expect(costOf("muse-wonder-1.0", usage(200_000, 200_000, 0))).toBeCloseTo(0.04, 12);
    // contributor: 1M * 0.10 + 1M * 0.20
    expect(costOf("muse-spark-1.3-contributor", usage(1_000_000, 0, 1_000_000))).toBeCloseTo(0.3, 12);
  });

  it("prices audio models per hour", () => {
    // 90 s = 0.025 h; 0.025 * 0.18 = 0.0045
    expect(costOf("muse-voice-transcribe-1.0", { ...usage(0, 0, 0), audioMs: 90_000 })).toBeCloseTo(
      0.0045,
      12,
    );
    expect(costOf("muse-voice-transcribe-1.0", usage(0, 0, 0))).toBe(0);
  });

  it("accepts a price table (open weights) and never goes negative on odd usage", () => {
    const prices = { "meta-models/muse-spark-open-1026": { inPerM: 0.5, outPerM: 1.5, cachedPerM: 0.5 } };
    // 2M * 0.5 + 1M * 1.5 = 2.5
    expect(costOf("meta-models/muse-spark-open-1026", usage(2_000_000, 0, 1_000_000), prices)).toBeCloseTo(
      2.5,
      12,
    );
    expect(costOf("muse-spark-1.3", usage(100, 500, 0))).toBeGreaterThanOrEqual(0);
  });

  it("returns 0 and logs a warning for an unknown model", () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    expect(costOf("gpt-unknown", usage(1_000, 0, 1_000))).toBe(0);
    const warning = writes.map((w) => JSON.parse(w)).find((w) => w.level === "warn");
    expect(warning).toMatchObject({ model: "gpt-unknown", mod: "ledger" });
  });
});

describe("createLedger", () => {
  const record = (overrides: Partial<ModelCallRecord>): ModelCallRecord => ({
    purpose: "understand",
    provider: "meta",
    model: "muse-spark-1.3",
    inputTokens: 1_000,
    cachedInputTokens: 0,
    outputTokens: 100,
    images: 0,
    latencyMs: 100,
    costUsd: 0.01,
    status: "ok",
    ...overrides,
  });

  it("records calls and sums them by job, run and purpose", () => {
    const db = openDb(":memory:");
    const ledger = createLedger(db, createFixedClock(1_761_566_400_000));
    ledger.record(
      record({ jobId: "A", purpose: "transcribe", costUsd: 0.0045, latencyMs: 900, audioMs: 90_000 }),
    );
    ledger.record(record({ jobId: "A", purpose: "extract", costUsd: 0.02, latencyMs: 2_000, images: 1 }));
    ledger.record(
      record({
        jobId: "A",
        runId: "R1",
        purpose: "cu_first_run",
        costUsd: 0.5,
        latencyMs: 30_000,
        stepIdx: 3,
      }),
    );
    ledger.record(
      record({
        jobId: "B",
        purpose: "understand",
        costUsd: 0.01,
        latencyMs: 700,
        status: "error",
        errorCode: "MODEL_ERROR",
      }),
    );

    const a = ledger.totals({ jobId: "A" });
    expect(a.calls).toBe(3);
    expect(a.costUsd).toBeCloseTo(0.5245, 12);
    expect(a.latencyMs).toBe(32_900);

    expect(ledger.totals({ runId: "R1" })).toEqual({ calls: 1, costUsd: 0.5, latencyMs: 30_000 });

    const intake = ledger.totals({ jobId: "A", purposes: ["transcribe", "extract"] });
    expect(intake.calls).toBe(2);
    expect(intake.costUsd).toBeCloseTo(0.0245, 12);

    const all = ledger.totals({});
    expect(all.calls).toBe(4);
    expect(all.costUsd).toBeCloseTo(0.5345, 12);
    expect(ledger.totals({ purposes: [] })).toEqual({ calls: 0, costUsd: 0, latencyMs: 0 });
    expect(ledger.totals({ jobId: "nobody" })).toEqual({ calls: 0, costUsd: 0, latencyMs: 0 });

    const row = db.raw.prepare("SELECT * FROM model_calls WHERE job_id = 'B'").get();
    expect(row).toMatchObject({
      ts: 1_761_566_400_000,
      purpose: "understand",
      provider: "meta",
      run_id: null,
      step_idx: null,
      reasoning_tokens: null,
      audio_ms: null,
      status: "error",
      error_code: "MODEL_ERROR",
    });
    db.close();
  });
});

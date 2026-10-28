import {
  type ComputerUseModel,
  createFixedClock,
  createLedger,
  createLogger,
  createMemoryArtifactStore,
  DockhandError,
  openDb,
} from "@dockhand/core";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createFakeModelGateway } from "./fake.ts";
import { createModelGateway } from "./gateway.ts";
import {
  ctx,
  makeWorld,
  memoryLedger,
  messageItem,
  pngBytes,
  responseBody,
  type World,
} from "./test-support/world.ts";

const Fields = z.object({ company: z.string(), seats: z.number() });

describe("createFakeModelGateway", () => {
  it("returns the handler's answer validated by the schema and records a fake row at $0", async () => {
    const ledger = memoryLedger();
    const artifacts = createMemoryArtifactStore();
    const image = await artifacts.put(pngBytes(), "image/png", { kind: "inbound_media" });
    const gateway = createFakeModelGateway({
      ledger,
      clock: createFixedClock(0),
      structured: (req) =>
        req.schemaName === "Fields" ? { company: "Acme Group", seats: 25, extra: "stripped" } : null,
    });

    const out = await gateway.structured(
      {
        model: "muse-spark-1.3",
        instructions: "x",
        input: [{ type: "image", image }],
        schemaName: "Fields",
        schema: Fields,
      },
      ctx("extract", { runId: "r1" }),
    );

    expect(out).toEqual({ company: "Acme Group", seats: 25 });
    expect(ledger.rows).toEqual([
      {
        purpose: "extract",
        provider: "fake",
        model: "muse-spark-1.3",
        jobId: "job-1",
        runId: "r1",
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        images: 1,
        latencyMs: 0,
        costUsd: 0,
        status: "ok",
      },
    ]);
  });

  it("fails like the real gateway: invalid output, missing handler", async () => {
    const ledger = memoryLedger();
    const gateway = createFakeModelGateway({ ledger, structured: () => ({ company: 1 }) });
    const req = {
      model: "muse-spark-1.3",
      instructions: "x",
      input: [],
      schemaName: "Fields",
      schema: Fields,
    };

    await expect(gateway.structured(req, ctx())).rejects.toMatchObject({ code: "MODEL_INVALID_OUTPUT" });
    await expect(createFakeModelGateway({}).structured(req, ctx())).rejects.toMatchObject({
      code: "MODEL_ERROR",
    });
    await expect(
      createFakeModelGateway({}).transcribe({} as never, {}, ctx("transcribe")),
    ).rejects.toBeInstanceOf(DockhandError);
    expect(ledger.rows[0]).toMatchObject({
      provider: "fake",
      status: "error",
      errorCode: "MODEL_INVALID_OUTPUT",
    });
  });

  it("transcribes through the handler, passes the computer-use model through and reports openWeights", async () => {
    const ledger = memoryLedger();
    const scripted: ComputerUseModel = {
      provider: "scripted",
      model: "scripted-1",
      open: () => ({ send: async () => [], imagesInChain: () => 0 }),
    };
    const gateway = createFakeModelGateway({
      ledger,
      openWeights: true,
      computerUse: scripted,
      transcribe: () => ({ text: "Oi", turns: [{ startMs: 0, endMs: 800, text: "Oi" }], audioMs: 800 }),
    });

    const t = await gateway.transcribe({} as never, { languageBias: ["Portuguese"] }, ctx("transcribe"));

    expect(t.text).toBe("Oi");
    expect(ledger.rows[0]).toMatchObject({
      provider: "fake",
      model: "muse-voice-transcribe-1.0",
      audioMs: 800,
      costUsd: 0,
    });
    expect(gateway.computerUse({ model: "muse-spark-1.3" })).toBe(scripted);
    expect(gateway.hasOpenWeights()).toBe(true);
    await expect(
      createFakeModelGateway({})
        .computerUse({ model: "m" })
        .open({ instructions: "", functions: [] })
        .send({ kind: "start", task: "", screenshot: pngBytes() }, ctx("cu_first_run")),
    ).rejects.toMatchObject({ code: "MODEL_ERROR" });
  });
});

describe("createModelGateway", () => {
  let world: World | undefined;
  afterEach(async () => {
    await world?.close();
    world = undefined;
  });

  const base = () => ({
    ledger: memoryLedger(),
    artifacts: createMemoryArtifactStore(),
    clock: createFixedClock(0),
    log: createLogger({ level: "silent" }),
  });
  const config = (mode: "live" | "record" | "cassette" | "fake", apiKey?: string) => ({
    meta: { mode, baseUrl: "http://127.0.0.1:9/v1", ...(apiKey ? { apiKey } : {}) },
    openWeights: { model: "meta-models/muse-spark-open", baseUrl: "http://127.0.0.1:9/baseten/v1" },
  });

  it("fails at construction in live and record modes without MODEL_API_KEY", () => {
    expect(() => createModelGateway({ ...base(), config: config("live") })).toThrow(/MODEL_API_KEY/);
    expect(() => createModelGateway({ ...base(), config: config("record") })).toThrow(/MODEL_API_KEY/);
    expect(() => createModelGateway({ ...base(), config: config("cassette") })).not.toThrow();
  });

  it("fake mode needs no key and answers like createFakeModelGateway", async () => {
    const deps = base();
    const gateway = createModelGateway({ ...deps, config: config("fake") });
    expect(gateway.hasOpenWeights()).toBe(false);
    await expect(
      gateway.structured(
        { model: "muse-spark-1.3", instructions: "x", input: [], schemaName: "Fields", schema: Fields },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: "MODEL_ERROR" });
    expect(deps.ledger.rows[0]?.provider).toBe("fake");
  });

  it("writes rows that core's SQLite ledger accepts and totals", async () => {
    const db = openDb(":memory:");
    try {
      const ledger = createLedger(db);
      world = await makeWorld();
      const gateway = createModelGateway({
        config: world.config,
        ledger,
        artifacts: createMemoryArtifactStore(),
        clock: createFixedClock(0),
        log: createLogger({ level: "silent" }),
        retry: { sleep: async () => undefined },
      });
      world.server.on(
        "/v1/responses",
        { json: responseBody([messageItem("oops")]) },
        { json: responseBody([messageItem('{"company":"Acme Group","seats":25}')]) },
      );

      await gateway.structured(
        { model: "muse-spark-1.3", instructions: "x", input: [], schemaName: "Fields", schema: Fields },
        ctx("understand", { jobId: "job-db" }),
      );

      const totals = ledger.totals({ jobId: "job-db" });
      expect(totals.calls).toBe(2);
      expect(totals.costUsd).toBeCloseTo(2 * 0.002555, 12);
      const rows = db.raw
        .prepare("SELECT provider, status, error_code, reasoning_tokens FROM model_calls ORDER BY id")
        .all();
      expect(rows).toEqual([
        { provider: "meta", status: "error", error_code: "MODEL_INVALID_OUTPUT", reasoning_tokens: 100 },
        { provider: "meta", status: "ok", error_code: null, reasoning_tokens: 100 },
      ]);
    } finally {
      db.close();
    }
  });
});

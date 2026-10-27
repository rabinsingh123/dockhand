import { createFixedClock, type Db, openDb } from "@dockhand/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepos, idemKey, parseIdemKey, type Repos } from "./repo.ts";

const T0 = Date.UTC(2026, 9, 27, 15, 0, 0);
let db: Db;
let repos: Repos;
let clock: ReturnType<typeof createFixedClock>;

beforeEach(() => {
  db = openDb(":memory:");
  clock = createFixedClock(T0);
  repos = createRepos(db, clock);
});
afterEach(() => db.close());

describe("messages (T1)", () => {
  it("dedupes inbound messages by wamid", () => {
    const m = { waId: "wamid.A", from: "5511999990000", ts: T0, kind: "text" as const, text: "oi" };
    expect(repos.messages.insertInbound(m)).toBe(true);
    expect(repos.messages.insertInbound(m)).toBe(false);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 1 });
  });

  it("links messages to jobs and lists a job's inbound messages in order", () => {
    const job = repos.jobs.create("5511999990000");
    for (const id of ["wamid.1", "wamid.2"]) {
      repos.messages.insertInbound({ waId: id, from: "5511999990000", ts: T0, kind: "text", text: id });
      repos.messages.linkJob(id, job.id);
      clock.advance(10);
    }
    repos.messages.insertOutbound({ waId: "wamid.out", to: "5511999990000", jobId: job.id, kind: "text" });
    expect(repos.messages.inboundForJob(job.id).map((m) => m.waId)).toEqual(["wamid.1", "wamid.2"]);
    expect(repos.messages.get("wamid.out")?.jobId).toBe(job.id);
  });
});

describe("jobs (T3)", () => {
  it("applies allowed transitions with rev compare-and-set and logs events", () => {
    const job = repos.jobs.create("5511999990000");
    expect(job.status).toBe("received");
    const a = repos.jobs.apply(job.id, { type: "start" });
    expect(a.ok && a.job.status).toBe("understanding");
    expect(a.ok && a.job.rev).toBe(1);
    const b = repos.jobs.apply(job.id, { type: "understood", missing: [], writes: true });
    expect(b.ok && b.job.status).toBe("awaiting_approval");
    const events = repos.jobs.events(job.id);
    expect(events.map((e) => [e.from, e.to, e.accepted])).toEqual([
      ["received", "understanding", true],
      ["understanding", "awaiting_approval", true],
    ]);
  });

  it("logs a rejected transition with accepted = 0 and changes nothing", () => {
    const job = repos.jobs.create("5511999990000");
    const r = repos.jobs.apply(job.id, { type: "finished", ok: true });
    expect(r.ok).toBe(false);
    expect(repos.jobs.get(job.id)?.status).toBe("received");
    expect(repos.jobs.get(job.id)?.rev).toBe(0);
    const [event] = repos.jobs.events(job.id);
    expect(event).toMatchObject({ from: "received", to: null, accepted: false, event: { type: "finished" } });
  });

  it("records the error code of a failed finish", () => {
    const job = repos.jobs.create("5511999990000");
    repos.jobs.apply(job.id, { type: "start" });
    repos.jobs.apply(job.id, { type: "finished", ok: false, errorCode: "MODEL_TIMEOUT" });
    expect(repos.jobs.get(job.id)).toMatchObject({ status: "failed", errorCode: "MODEL_TIMEOUT" });
  });

  it("finds the job a plain text attaches to", () => {
    const rep = "5511999990000";
    const old = repos.jobs.create(rep);
    repos.jobs.apply(old.id, { type: "start" });
    repos.jobs.apply(old.id, { type: "understood", missing: ["seats"], writes: false });
    clock.advance(1000);
    const planned = repos.jobs.create(rep);
    repos.jobs.apply(planned.id, { type: "start" });
    repos.jobs.apply(planned.id, { type: "understood", missing: [], writes: true });
    // awaiting_approval without a pending plan/question gate does not attach
    expect(repos.jobs.attachableFor(rep)?.id).toBe(old.id);
    repos.gates.insert({ id: "G1", jobId: planned.id, kind: "plan", body: "ok?", expiresAt: T0 + 60_000 });
    expect(repos.jobs.attachableFor(rep)?.id).toBe(planned.id);
    expect(repos.jobs.attachableFor("5511000000000")).toBeUndefined();
  });
});

describe("gates (T2, T5)", () => {
  it("resolves only pending, unexpired gates", () => {
    const job = repos.jobs.create("5511999990000");
    repos.gates.insert({ id: "G1", jobId: job.id, kind: "commit", body: "Submit?", expiresAt: T0 + 1000 });
    expect(repos.gates.resolve("G1", "approved", "wamid.tap", T0)).toBe(true);
    expect(repos.gates.resolve("G1", "rejected", "wamid.tap2", T0)).toBe(false);
    expect(repos.gates.get("G1")).toMatchObject({ status: "approved", resolvedByWaId: "wamid.tap" });

    repos.gates.insert({ id: "G2", jobId: job.id, kind: "commit", body: "Submit?", expiresAt: T0 + 1000 });
    expect(repos.gates.resolve("G2", "approved", "wamid.late", T0 + 1000)).toBe(false);
    expect(repos.gates.due(T0 + 1000).map((g) => g.id)).toEqual(["G2"]);
    expect(repos.gates.expire("G2", T0 + 1000)).toBe(true);
    expect(repos.gates.expire("G2", T0 + 1000)).toBe(false);
  });
});

describe("tool_calls", () => {
  it("commits a started row before the call and refuses to start the same key twice", () => {
    const job = repos.jobs.create("5511999990000");
    const key = idemKey(job.id, 1);
    const first = repos.toolCalls.begin({
      jobId: job.id,
      idx: 1,
      kind: "crm.deal",
      idemKey: key,
      args: { a: 1 },
    });
    expect(first.fresh).toBe(true);
    expect(repos.toolCalls.byKey(key)?.status).toBe("started");
    const again = repos.toolCalls.begin({
      jobId: job.id,
      idx: 1,
      kind: "crm.deal",
      idemKey: key,
      args: { a: 1 },
    });
    expect(again.fresh).toBe(false);
    repos.toolCalls.succeed(first.row.id, { id: "42" });
    expect(repos.toolCalls.byKey(key)).toMatchObject({ status: "succeeded", result: { id: "42" } });
  });

  it("reopens a failed call and marks started calls unknown at boot", () => {
    const job = repos.jobs.create("5511999990000");
    const a = repos.toolCalls.begin({ jobId: job.id, idx: 0, kind: "k", idemKey: "x:0", args: null });
    repos.toolCalls.fail(a.row.id, "HTTP 400");
    expect(
      repos.toolCalls.begin({ jobId: job.id, idx: 0, kind: "k", idemKey: "x:0", args: null }).fresh,
    ).toBe(true);
    expect(repos.toolCalls.markStartedUnknown().map((r) => r.idemKey)).toEqual(["x:0"]);
    expect(repos.toolCalls.byKey("x:0")?.status).toBe("unknown");
  });

  it("parses idempotency keys", () => {
    expect(parseIdemKey("01JOB:3")).toEqual({ jobId: "01JOB", idx: 3 });
    expect(() => parseIdemKey("nope")).toThrow(/idempotency key/);
  });
});

describe("runs (T6)", () => {
  it("inserts at start, records steps, and finishes in one update", () => {
    repos.runs.start({
      id: "R1",
      jobId: null,
      mode: "replay",
      skillName: "s",
      skillVersion: 1,
      portalId: "partner",
    });
    repos.runs.step("R1", { idx: 0, stepId: "s0", op: "goto", status: "ok", ms: 12 });
    repos.runs.step("R1", {
      idx: 1,
      stepId: "s1",
      op: "click",
      status: "healed",
      rung: "fallback",
      candidateIdx: 1,
      ms: 30,
    });
    expect(repos.runs.get("R1")?.outcome).toBeNull();
    repos.runs.finish("R1", {
      outcome: "success",
      ms: 900,
      execCostUsd: 0,
      modelCalls: 0,
      extracted: { id: "NW" },
    });
    expect(repos.runs.get("R1")).toMatchObject({ outcome: "success", ms: 900, modelCalls: 0 });
    expect(repos.runs.steps("R1").map((s) => s.rung)).toEqual([null, "fallback"]);
  });

  it("marks unfinished runs unknown at boot", () => {
    repos.runs.start({ id: "R2", jobId: null, mode: "agentic" });
    expect(repos.runs.markUnfinished()).toBe(1);
    expect(repos.runs.get("R2")).toMatchObject({ outcome: "unknown", errorCode: "CRASH_RECOVERED" });
  });
});

describe("reps", () => {
  it("refuses politely at most once a day", () => {
    expect(repos.reps.markRefused("5511000000000")).toBe(true);
    expect(repos.reps.markRefused("5511000000000")).toBe(false);
    clock.advance(24 * 3_600_000);
    expect(repos.reps.markRefused("5511000000000")).toBe(true);
  });
});

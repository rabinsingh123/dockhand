import { createFixedClock, createLogger, createMemoryArtifactStore, type Db, openDb } from "@dockhand/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buttonId,
  createApprovalBroker,
  type DockhandApprovalBroker,
  gateTtlMs,
  parseButtonId,
  REPLIES,
} from "./approvals.ts";
import { createRepos, type Repos } from "./repo.ts";
import { createRecordingWhatsApp, type RecordingWhatsApp } from "./testing/fake-wa.ts";

const REP = "5511999990000";
const OTHER = "5511888880000";
const TTL = 20 * 60_000;

let db: Db;
let clock: ReturnType<typeof createFixedClock>;
let wa: RecordingWhatsApp;
let repos: Repos;
let broker: DockhandApprovalBroker;

beforeEach(() => {
  db = openDb(":memory:");
  clock = createFixedClock(Date.UTC(2026, 9, 27, 15, 0, 0));
  wa = createRecordingWhatsApp();
  repos = createRepos(db, clock);
  broker = createApprovalBroker({
    db,
    wa,
    clock,
    log: createLogger({ level: "silent" }),
    artifacts: createMemoryArtifactStore(clock),
  });
});
afterEach(() => db.close());

/** A job that is executing, so a commit gate can open on it. */
function executingJob(rep = REP): string {
  const job = repos.jobs.create(rep);
  repos.jobs.apply(job.id, { type: "start" });
  repos.jobs.apply(job.id, { type: "understood", missing: [], writes: false });
  return job.id;
}

function lastButtons() {
  const m = wa.sent.at(-1);
  if (m?.type !== "buttons") throw new Error("last message is not a button card");
  return m;
}

describe("button ids", () => {
  it("round-trips approve, reject, edit and options", () => {
    expect(buttonId("01ABC", "approve")).toBe("g:01ABC:a");
    expect(parseButtonId("g:01ABC:a")).toEqual({ gateId: "01ABC", decision: "approved" });
    expect(parseButtonId("g:01ABC:r")).toEqual({ gateId: "01ABC", decision: "rejected" });
    expect(parseButtonId("g:01ABC:e")).toEqual({ gateId: "01ABC", decision: "edit" });
    expect(parseButtonId(buttonId("01ABC", "opt2"))).toEqual({ gateId: "01ABC", decision: "opt2" });
    expect(parseButtonId("approve")).toBeNull();
    expect(parseButtonId("g:01ABC:x")).toBeNull();
  });

  it("uses 60 minute gates in demo mode", () => {
    expect(gateTtlMs(false)).toBe(TTL);
    expect(gateTtlMs(true)).toBe(60 * 60_000);
  });
});

describe("approval broker", () => {
  it("sends a button card, then a tap resolves the gate, the job and the promise", async () => {
    const jobId = executingJob();
    const { gateId, decision } = await broker.open({
      jobId,
      kind: "commit",
      to: REP,
      body: "Submit?",
      ttlMs: TTL,
    });
    const card = lastButtons();
    expect(card.buttons).toEqual([
      { id: `g:${gateId}:a`, title: "Approve" },
      { id: `g:${gateId}:r`, title: "Cancel" },
    ]);
    expect(repos.jobs.get(jobId)?.status).toBe("awaiting_approval");
    expect(repos.messages.get(card.waId)?.jobId).toBe(jobId); // replies to the card attach to the job

    expect(broker.resolveFromButton(`g:${gateId}:a`, REP, "wamid.tap1")).toBe("resolved");
    await expect(decision).resolves.toBe("approved");
    expect(repos.gates.get(gateId)).toMatchObject({ status: "approved", resolvedByWaId: "wamid.tap1" });
    expect(repos.jobs.get(jobId)?.status).toBe("executing");
  });

  it("answers a double tap with one line and changes nothing", async () => {
    const jobId = executingJob();
    const { gateId } = await broker.open({ jobId, kind: "commit", to: REP, body: "Submit?", ttlMs: TTL });
    expect(broker.resolveFromButton(`g:${gateId}:a`, REP, "wamid.tap1")).toBe("resolved");
    const rev = repos.jobs.get(jobId)?.rev;
    expect(broker.resolveFromButton(`g:${gateId}:r`, REP, "wamid.tap2")).toBe("already_resolved");
    await broker.flush();
    expect(wa.sent.at(-1)).toMatchObject({ type: "text", to: REP, body: REPLIES.alreadyResolved });
    expect(repos.gates.get(gateId)?.status).toBe("approved");
    expect(repos.jobs.get(jobId)?.rev).toBe(rev);
  });

  it("refuses a tap from another number", async () => {
    const jobId = executingJob();
    const { gateId } = await broker.open({ jobId, kind: "commit", to: REP, body: "Submit?", ttlMs: TTL });
    expect(broker.resolveFromButton(`g:${gateId}:a`, OTHER, "wamid.x")).toBe("wrong_sender");
    await broker.flush();
    expect(wa.sent.at(-1)).toMatchObject({ type: "text", to: OTHER, body: REPLIES.wrongSender });
    expect(repos.gates.get(gateId)?.status).toBe("pending");
  });

  it("expires due gates on the sweep: gate, job and the waiting flow", async () => {
    const jobId = executingJob();
    const { gateId, decision } = await broker.open({
      jobId,
      kind: "commit",
      to: REP,
      body: "Submit?",
      ttlMs: TTL,
    });
    clock.advance(TTL - 1);
    expect(broker.expireDue()).toBe(0);
    clock.advance(1);
    expect(broker.expireDue()).toBe(1);
    await expect(decision).resolves.toBe("expired");
    expect(repos.gates.get(gateId)?.status).toBe("expired");
    expect(repos.jobs.get(jobId)?.status).toBe("expired");
    expect(broker.expireDue()).toBe(0);
  });

  it("answers a late tap with the expiry line, even before the sweep ran", async () => {
    const jobId = executingJob();
    const { gateId, decision } = await broker.open({
      jobId,
      kind: "commit",
      to: REP,
      body: "Submit?",
      ttlMs: TTL,
    });
    clock.advance(TTL + 5_000);
    expect(broker.resolveFromButton(`g:${gateId}:a`, REP, "wamid.late")).toBe("expired");
    await expect(decision).resolves.toBe("expired");
    await broker.flush();
    expect(wa.sent.at(-1)).toMatchObject({ type: "text", body: REPLIES.expired });
    expect(repos.jobs.get(jobId)?.status).toBe("expired");
    // and again after the sweep
    expect(broker.resolveFromButton(`g:${gateId}:a`, REP, "wamid.later")).toBe("expired");
  });

  it("maps option taps to the job's approved transition and keeps the option on the gate", async () => {
    const jobId = executingJob();
    const { gateId, decision } = await broker.open({
      jobId,
      kind: "question",
      to: REP,
      body: "Partner tier?",
      ttlMs: TTL,
      buttons: [
        { id: "opt0", title: "Gold" },
        { id: "opt1", title: "Silver" },
        { id: "opt2", title: "Bronze" },
      ],
    });
    expect(broker.resolveFromButton(`g:${gateId}:o0`, REP, "wamid.tap")).toBe("resolved");
    await expect(decision).resolves.toBe("opt0");
    expect(repos.gates.get(gateId)?.status).toBe("opt0");
    expect(repos.jobs.get(jobId)?.status).toBe("executing");
  });

  it("lets a plan gate be edited by a text reply", async () => {
    const job = repos.jobs.create(REP);
    repos.jobs.apply(job.id, { type: "start" });
    repos.jobs.apply(job.id, { type: "understood", missing: [], writes: true });
    const { gateId, decision } = await broker.open({
      jobId: job.id,
      kind: "plan",
      to: REP,
      body: "Plan",
      ttlMs: TTL,
    });
    expect(repos.jobs.get(job.id)?.status).toBe("awaiting_approval");
    expect(broker.resolve(gateId, "edit", REP, "wamid.text")).toBe("resolved");
    await expect(decision).resolves.toBe("edit");
    expect(repos.jobs.get(job.id)?.status).toBe("awaiting_input");
  });

  it("returns unknown for ids it never issued", () => {
    expect(broker.resolveFromButton("g:01NOPE:a", REP, "wamid.x")).toBe("unknown");
    expect(broker.resolveFromButton("something else", REP, "wamid.y")).toBe("unknown");
  });

  it("clips long bodies and titles to WhatsApp's limits", async () => {
    const jobId = executingJob();
    await broker.open({
      jobId,
      kind: "question",
      to: REP,
      body: "x".repeat(2000),
      ttlMs: TTL,
      buttons: [
        { id: "opt0", title: "A very long option title indeed" },
        { id: "opt1", title: "A very long option title too" },
      ],
    });
    const card = lastButtons();
    expect([...card.body].length).toBe(1024);
    expect(card.buttons.map((b) => [...b.title].length <= 20)).toEqual([true, true]);
    expect(new Set(card.buttons.map((b) => b.title)).size).toBe(2);
  });

  it("expires the gate when the card cannot be sent", async () => {
    const jobId = executingJob();
    wa.failNextButtons();
    const { gateId, decision } = await broker.open({
      jobId,
      kind: "commit",
      to: REP,
      body: "Submit?",
      ttlMs: TTL,
    });
    await expect(decision).resolves.toBe("expired");
    expect(repos.gates.get(gateId)?.status).toBe("expired");
  });

  it("expires a job's gates without a job transition for the boot sweep", async () => {
    const jobId = executingJob();
    const { gateId } = await broker.open({ jobId, kind: "commit", to: REP, body: "Submit?", ttlMs: TTL });
    repos.jobs.apply(jobId, { type: "crash_recovered" });
    expect(broker.expireForJob(jobId)).toBe(1);
    expect(repos.gates.get(gateId)?.status).toBe("expired");
    expect(repos.jobs.get(jobId)?.status).toBe("failed");
  });
});

describe("eval auto-approve", () => {
  it("approves only gates about a configured localhost origin", async () => {
    const auto = createApprovalBroker({
      db,
      wa,
      clock,
      log: createLogger({ level: "silent" }),
      artifacts: createMemoryArtifactStore(clock),
      evalAutoApprove: { origins: ["http://127.0.0.1:5101"] },
    });
    const sentBefore = wa.sent.length;
    const a = await auto.open({
      jobId: executingJob(),
      kind: "commit",
      to: REP,
      body: "Submit?",
      ttlMs: TTL,
      origin: "http://127.0.0.1:5101/deals/new",
    });
    await expect(a.decision).resolves.toBe("approved");
    expect(wa.sent.length).toBe(sentBefore); // nothing sent

    // No origin, or another origin: a human decides.
    const b = await auto.open({
      jobId: executingJob(),
      kind: "commit",
      to: REP,
      body: "Submit?",
      ttlMs: TTL,
    });
    expect(repos.gates.get(b.gateId)?.status).toBe("pending");
    const c = await auto.open({
      jobId: executingJob(),
      kind: "commit",
      to: REP,
      body: "Submit?",
      ttlMs: TTL,
      origin: "http://127.0.0.1:5102",
    });
    expect(repos.gates.get(c.gateId)?.status).toBe("pending");
  });

  it("refuses to be configured with a non-local origin", () => {
    expect(() =>
      createApprovalBroker({
        db,
        wa,
        clock,
        log: createLogger({ level: "silent" }),
        artifacts: createMemoryArtifactStore(clock),
        evalAutoApprove: { origins: ["https://partners.example.com"] },
      }),
    ).toThrow(/localhost/);
  });
});

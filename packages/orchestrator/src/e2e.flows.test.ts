// Quote flow (API path), webhook retries, gate expiry, boot sweep and commands, through the emulator.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutboundRecord } from "@dockhand/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPLIES } from "./approvals.ts";
import { RESTART_MESSAGE } from "./orchestrator.ts";
import { createTestSystem, type TestSystem, voiceFixtures } from "./testing/harness.ts";
import { createFakeCrm } from "./tools/crm-fake.ts";

const dir = mkdtempSync(join(tmpdir(), "dockhand-flows-"));
const voiceNote = join(dir, "vn2.ogg");
const quoteScript = voiceFixtures().find((v) => v.id === "vn2-quote-cafe-aurora")?.script ?? "";
const crm = createFakeCrm();
let sys: TestSystem;

beforeAll(async () => {
  execFileSync(process.env.FFMPEG_PATH ?? "ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=330:duration=2",
    "-c:a",
    "libopus",
    voiceNote,
  ]);
  sys = await createTestSystem({
    crm,
    models: { transcribe: () => ({ text: quoteScript, turns: [], audioMs: 2000 }) },
  });
}, 120_000);

afterAll(async () => {
  await sys?.close();
  rmSync(dir, { recursive: true, force: true });
});

const outbox = () => sys.emulator.outbox(sys.rep);
const lastCard = (): OutboundRecord => {
  const card = outbox().findLast((r) => r.type === "interactive");
  if (!card) throw new Error("no card");
  return card;
};
async function send(msg: Parameters<TestSystem["emulator"]["send"]>[1]): Promise<string> {
  const waId = await sys.emulator.send(sys.rep, msg);
  await sys.orchestrator.drain();
  return waId;
}
async function tap(card: OutboundRecord, code: string, from = sys.rep): Promise<void> {
  const id = card.buttons?.find((b) => b.id.endsWith(`:${code}`))?.id ?? "";
  await sys.emulator.tap(from, card.waId, id);
  await sys.orchestrator.drain();
}
const jobCount = () => (sys.db.raw.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n;

describe("quote flow (voice note -> HubSpot fake -> PDF -> drafted reply)", () => {
  it("plans from the transcript, writes once on approval, and answers a double tap", async () => {
    await send({ file: { path: voiceNote, mime: "audio/ogg", voice: true } });
    const plan = lastCard();
    expect(plan.body).toContain(
      "Quote for Café Aurora: 25 seats of Tidewater Cloud Business, starting 1 Jan 2027.",
    );
    expect(plan.body).toContain("R$ 32.130,00");
    expect(crm.writes()).toBe(0);

    await tap(plan, "a");
    const state = crm.state();
    expect(state.companies.map((c) => c.name)).toEqual(["Café Aurora"]);
    expect(state.deals).toHaveLength(1);
    expect(state.deals[0]).toMatchObject({ amountMinor: 3_213_000, currency: "BRL" });
    expect(state.notes).toHaveLength(1);
    const pdf = outbox().find((r) => r.type === "document");
    expect(pdf?.media?.mime).toBe("application/pdf");
    const reply = outbox().find((r) => r.body?.startsWith("Draft reply for you to forward"));
    expect(reply?.body).toContain("Olá, Júlia! Segue a proposta da Tidewater Cloud para Café Aurora");
    const receipt = outbox().findLast((r) => r.type === "image");
    expect(receipt?.caption).toContain("API · ");
    expect(receipt?.caption).toContain("execution $0 + intake");

    await tap(plan, "a"); // double tap
    expect(outbox().at(-1)?.body).toBe(REPLIES.alreadyResolved);
    expect(crm.state().deals).toHaveLength(1);
  }, 120_000);
});

describe("webhook retries, expiry and the boot sweep", () => {
  it("dedupes a redelivered webhook by wamid", async () => {
    const before = jobCount();
    const waId = await send({ text: "/skills" });
    expect(await sys.emulator.redeliver(waId)).toBe(200);
    await sys.orchestrator.drain();
    expect(jobCount()).toBe(before);
    expect(outbox().filter((r) => r.body?.startsWith("No skills yet"))).toHaveLength(1);
  });

  it("expires a plan gate after its TTL and answers the late tap", async () => {
    await send({ file: { path: voiceNote, mime: "audio/ogg", voice: true } });
    const plan = lastCard();
    const gateId = plan.buttons?.[0]?.id.split(":")[1] ?? "";
    sys.clock.advance(sys.approvals.defaultTtlMs + 1);
    expect(sys.approvals.expireDue()).toBe(1);
    await sys.orchestrator.drain();
    expect(sys.repos.gates.get(gateId)?.status).toBe("expired");
    expect(sys.repos.jobs.get(sys.repos.gates.get(gateId)?.jobId ?? "")?.status).toBe("expired");
    expect(outbox().at(-1)?.body).toBe("This request expired. Send it again to retry.");
    await tap(plan, "a");
    expect(outbox().at(-1)?.body).toBe(REPLIES.expired);
  }, 60_000);

  it("fails in-flight jobs on recover() and old buttons answer expired", async () => {
    await send({ file: { path: voiceNote, mime: "audio/ogg", voice: true } });
    const plan = lastCard();
    const jobId = sys.repos.gates.get(plan.buttons?.[0]?.id.split(":")[1] ?? "")?.jobId ?? "";
    await sys.orchestrator.recover();
    await sys.orchestrator.drain();
    expect(sys.repos.jobs.get(jobId)).toMatchObject({ status: "failed", errorCode: "CRASH_RECOVERED" });
    expect(outbox().at(-1)?.body).toBe(RESTART_MESSAGE);
    await tap(plan, "a");
    expect(outbox().at(-1)?.body).toBe(REPLIES.expired);
  }, 60_000);

  it("refuses a tap from another rep's number without changing anything", async () => {
    await send({ file: { path: voiceNote, mime: "audio/ogg", voice: true } });
    const plan = lastCard();
    const gateId = plan.buttons?.[0]?.id.split(":")[1] ?? "";
    // The other number is not allow-listed in this system, so the webhook drops it before the broker.
    await sys.emulator.tap("5511888880000", plan.waId, plan.buttons?.[0]?.id ?? "");
    await sys.orchestrator.drain();
    expect(sys.repos.gates.get(gateId)?.status).toBe("pending");
    await tap(plan, "r");
    expect(sys.repos.gates.get(gateId)?.status).toBe("rejected");
    expect(outbox().at(-1)?.body).toBe("Cancelled. Nothing was written.");
  }, 60_000);
});

describe("commands", () => {
  it("answers /stats and /rollback usage without a model call", async () => {
    const calls = sys.ledger.totals({}).calls;
    await send({ text: "/stats" });
    expect(outbox().at(-1)?.body).toContain("Dockhand stats");
    await send({ text: "/rollback" });
    expect(outbox().at(-1)?.body).toContain("Usage: /rollback <skill> <version>");
    await send({ text: "/help" });
    expect(outbox().at(-1)?.body).toContain("I'm Dockhand.");
    expect(sys.ledger.totals({}).calls).toBe(calls);
  });

  it("gives question and unknown intents the fixed reply, never a chat answer", async () => {
    await send({ text: "what's the weather like?" });
    expect(outbox().at(-1)?.body).toContain("I'm Dockhand. Forward me the work");
  });
});

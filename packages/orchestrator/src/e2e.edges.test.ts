// The demo's edge cases through the WhatsApp emulator: double taps and stale buttons, Cancel at every gate,
// free text at a gate (an edit at the plan card, "cancel" and anything else at the submit card), a typed answer
// to a question, Skip, a restart mid-job, and Meta redelivering webhooks. Computer use follows the stand-ins.

import { join } from "node:path";
import type { OutboundRecord } from "@dockhand/core";
import { workspaceRoot } from "@dockhand/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPLIES } from "./approvals.ts";
import { RESTART_MESSAGE, WAITING_ON_CARD } from "./orchestrator.ts";
import { createTestSystem, type TestSystem, teachFixture } from "./testing/harness.ts";

const inbound = (f: string) => join(workspaceRoot(), "fixtures", "inbound", f);
const CAFE = inbound("referral-cafe-aurora.jpg");
const VILA = inbound("referral-vila-nova.jpg");

let sys: TestSystem;

beforeAll(async () => {
  sys = await createTestSystem({ models: { openWeights: true } });
}, 120_000);

afterAll(async () => {
  await sys?.close();
});

const outbox = () => sys.emulator.outbox(sys.rep);
const last = () => outbox().at(-1);
const dump = () =>
  outbox()
    .slice(-8)
    .map((r) => `[${r.type}] ${(r.body ?? r.caption ?? "").slice(0, 120)}`)
    .join(" || ");

function lastCard(): OutboundRecord {
  const card = outbox().findLast((r) => r.type === "interactive");
  if (!card) throw new Error(`no card; outbox: ${dump()}`);
  return card;
}

async function send(msg: Parameters<TestSystem["emulator"]["send"]>[1]): Promise<string> {
  const waId = await sys.emulator.send(sys.rep, msg);
  await sys.orchestrator.drain();
  return waId;
}

async function tap(card: OutboundRecord, code: string): Promise<string> {
  const button = card.buttons?.find((b) => b.id.endsWith(`:${code}`));
  if (!button) throw new Error(`card has no ${code} button: ${JSON.stringify(card.buttons)}`);
  const waId = await sys.emulator.tap(sys.rep, card.waId, button.id);
  await sys.orchestrator.drain();
  return waId;
}

const submissions = () => sys.portals.partner.submissions().length;
const jobs = () => (sys.db.raw.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n;

describe("edge cases through WhatsApp", () => {
  it("Cancel on the teach card discards the draft; a double tap changes nothing", async () => {
    await send({ file: { path: teachFixture().videoPath, mime: "video/mp4", asDocument: true } });
    await tap(lastCard(), "r");
    expect(last()?.body).toBe("Discarded. Send another recording whenever you like.");
    expect(sys.skills.draftForPortal("caravela")).toBeUndefined();

    await send({ file: { path: teachFixture().videoPath, mime: "video/mp4", asDocument: true } });
    const card = lastCard();
    await tap(card, "a");
    expect(sys.skills.draftForPortal("caravela")?.draft.name).toBe("register_partner_deal");
    await tap(card, "a");
    expect(last()?.body).toBe(REPLIES.alreadyResolved);
  }, 60_000);

  it("Cancel on the plan card writes nothing, and its stale Approve changes nothing", async () => {
    await send({ file: { path: CAFE, mime: "image/jpeg" } });
    const plan = lastCard();
    await tap(plan, "r");
    expect(last()?.body).toBe("Cancelled. Nothing was written.");
    await tap(plan, "a");
    expect(last()?.body).toBe(REPLIES.alreadyResolved);
    expect(submissions()).toBe(0);
  }, 60_000);

  it("Cancel on the submit card sends nothing; the next request runs and compiles v1", async () => {
    await send({ file: { path: CAFE, mime: "image/jpeg" } });
    await tap(lastCard(), "a");
    const commit = lastCard();
    expect(commit.body, dump()).toContain("Ready to submit on Caravela Partner Hub");
    await tap(commit, "r");
    expect(last()?.body).toBe("Cancelled before submitting. Nothing was sent.");
    await tap(commit, "a");
    expect(last()?.body).toBe(REPLIES.alreadyResolved);
    expect(submissions()).toBe(0);

    await send({ file: { path: CAFE, mime: "image/jpeg" } });
    await tap(lastCard(), "a");
    await tap(lastCard(), "a");
    expect(submissions(), dump()).toBe(1);
    expect(sys.skills.active("register_partner_deal")?.version).toBe(1);
  }, 180_000);

  it("a text at the plan card edits it; text at the submit card points at the card; 'cancel' stops it", async () => {
    await send({ file: { path: VILA, mime: "image/jpeg" } });
    const first = lastCard();
    expect(first.body).toContain("values from your message, listed on the card");
    expect(first.headerImagePath).toBeTruthy();
    await send({ text: "make it 30 seats" });
    const edited = lastCard();
    expect(edited.waId).not.toBe(first.waId);
    // The values live on the plan card; the edited plan the card was drawn from has the new seat count.
    const seats = sys.db.raw
      .prepare(
        "SELECT json_extract(plan_json, '$.actions[0].params.seats') AS n FROM jobs WHERE n IS NOT NULL ORDER BY updated_at DESC, rowid DESC LIMIT 1",
      )
      .get() as { n: number } | undefined;
    expect(seats?.n, dump()).toBe(30);
    expect(edited.headerImagePath).toBeTruthy();
    await tap(first, "a");
    expect(last()?.body).toBe(REPLIES.alreadyResolved);

    await tap(edited, "a");
    const commit = lastCard();
    expect(commit.body, dump()).toContain("Ready to submit on Caravela Partner Hub");
    expect(commit.headerImagePath).toBeTruthy(); // the submit card shows the 30 seats read back from the page
    const before = jobs();
    await send({ text: "hmm, is that right?" });
    expect(last()?.body).toBe(WAITING_ON_CARD);
    await send({ text: "cancel" });
    expect(last()?.body).toBe("Cancelled before submitting. Nothing was sent.");
    expect(jobs()).toBe(before + 1); // the question became a reply, never a second task
    expect(submissions()).toBe(1);
  }, 120_000);

  it("ignores Meta redelivering a photo and a tap", async () => {
    const photo = await send({ file: { path: VILA, mime: "image/jpeg" } });
    const plan = lastCard();
    const approve = await tap(plan, "a");
    const commit = lastCard();
    const count = { jobs: jobs(), out: outbox().length };
    expect(await sys.emulator.redeliver(photo)).toBe(200);
    expect(await sys.emulator.redeliver(approve)).toBe(200);
    await sys.orchestrator.drain();
    expect({ jobs: jobs(), out: outbox().length }).toEqual(count);
    await tap(commit, "a");
    expect(submissions(), dump()).toBe(2);
    expect(sys.portals.partner.submissions().at(-1)?.fields.seats).toBe(40);
  }, 120_000);

  it("takes a typed answer to a question, and Skip stops safely", async () => {
    sys.portals.partner.setMutation({ seed: 1, operators: ["insert_required_field"] });
    try {
      await send({ file: { path: CAFE, mime: "image/jpeg" } });
      await tap(lastCard(), "a");
      const question = lastCard();
      expect(question.body, dump()).toContain('"Partner tier"');
      await send({ text: "silver" });
      const commit = lastCard();
      expect(commit.body, dump()).toContain("Partner tier: Silver"); // the answer, read back from the page
      await tap(commit, "a");
      expect(sys.portals.partner.submissions().at(-1)?.fields.partnerTier, dump()).toBe("Silver");
      expect(sys.skills.active("register_partner_deal")?.params.some((p) => p.name === "partner_tier")).toBe(
        true,
      );

      await send({ text: "/rollback register_partner_deal 1" });
      await send({ file: { path: VILA, mime: "image/jpeg" } });
      await tap(lastCard(), "a");
      const again = lastCard();
      expect(again.body).toContain('"Partner tier"');
      const before = submissions();
      // Three options fill WhatsApp's three buttons, so there is no Skip button: typing "skip" stops it.
      expect(again.buttons?.map((b) => b.title)).toEqual(["Gold", "Silver", "Bronze"]);
      await send({ text: "skip" });
      expect(last()?.caption).toBe("Where it stopped");
      expect(outbox().findLast((r) => r.type === "text")?.body, dump()).toBe(
        'Stopped before submitting: Caravela Partner Hub now needs "Partner tier" and I have no answer for it. Nothing was submitted.',
      );
      expect(submissions()).toBe(before);
    } finally {
      sys.portals.partner.setMutation(null);
    }
  }, 180_000);

  it("a restart mid-job stops the job, tells the rep, and the old buttons answer expired", async () => {
    await send({ file: { path: VILA, mime: "image/jpeg" } });
    await tap(lastCard(), "a");
    const commit = lastCard();
    expect(commit.body).toContain("Ready to submit");
    const before = submissions();
    await sys.orchestrator.recover();
    await sys.orchestrator.drain();
    expect(outbox().some((r) => r.body === RESTART_MESSAGE)).toBe(true);
    await tap(commit, "a");
    expect(last()?.body).toBe(REPLIES.expired);
    expect(submissions()).toBe(before);
  }, 120_000);
});

// Drift watch through WhatsApp: verified skills stay quiet (on demand, one "still match" line); a changed portal
// is repaired, canaried and activated with one card (Roll back, Details) and the next real job replays with no
// heals; a new required field is asked once and becomes the param's default; what cannot be healed safely is
// said in one line. Computer use follows the stand-ins; nothing is ever submitted by a watch.

import { join } from "node:path";
import type { OutboundRecord } from "@dockhand/core";
import { workspaceRoot } from "@dockhand/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestSystem, type TestSystem, teachFixture } from "./testing/harness.ts";

const inbound = (f: string) => join(workspaceRoot(), "fixtures", "inbound", f);
const CAFE = inbound("referral-cafe-aurora.jpg");
const VILA = inbound("referral-vila-nova.jpg");

async function setUp(sys: TestSystem): Promise<void> {
  const send = async (m: Parameters<TestSystem["emulator"]["send"]>[1]) => {
    await sys.emulator.send(sys.rep, m);
    await sys.orchestrator.drain();
  };
  const tapLast = async () => {
    const card = sys.emulator.outbox(sys.rep).findLast((r) => r.type === "interactive");
    const a = card?.buttons?.find((b) => b.id.endsWith(":a"));
    if (!card || !a) throw new Error("no approve button");
    await sys.emulator.tap(sys.rep, card.waId, a.id);
    await sys.orchestrator.drain();
  };
  await send({ file: { path: teachFixture().videoPath, mime: "video/mp4", asDocument: true } });
  await tapLast();
  await send({ file: { path: CAFE, mime: "image/jpeg" } });
  await tapLast(); // plan
  await tapLast(); // submit
  if (sys.skills.active("register_partner_deal")?.version !== 1) throw new Error("v1 was not compiled");
}

describe("drift watch", () => {
  let sys: TestSystem;
  beforeAll(async () => {
    sys = await createTestSystem({ models: { openWeights: true } });
    await setUp(sys);
  }, 180_000);
  afterAll(async () => {
    await sys?.close();
  });

  const outbox = () => sys.emulator.outbox(sys.rep);
  const last = () => outbox().at(-1);
  const lastCard = (): OutboundRecord => {
    const card = outbox().findLast((r) => r.type === "interactive");
    if (!card) throw new Error("no card");
    return card;
  };
  const send = async (m: Parameters<TestSystem["emulator"]["send"]>[1]) => {
    await sys.emulator.send(sys.rep, m);
    await sys.orchestrator.drain();
  };
  const tap = async (card: OutboundRecord, title: string) => {
    const b = card.buttons?.find((x) => x.title === title);
    if (!b) throw new Error(`no ${title} button: ${JSON.stringify(card.buttons)}`);
    await sys.emulator.tap(sys.rep, card.waId, b.id);
    await sys.orchestrator.drain();
  };
  const submissions = () => sys.portals.partner.submissions().length;

  it("verifies an unchanged skill with a dry run and says only that, on demand", async () => {
    const before = submissions();
    await send({ text: "/watch" });
    expect(outbox().at(-2)?.body).toBe(
      "Checking register_partner_deal with a dry run on its portal. Nothing is submitted.",
    );
    expect(last()?.body).toMatch(
      /^register_partner_deal still matches its portal: every step resolved and read back/,
    );
    expect(submissions()).toBe(before);
    const run = sys.db.raw
      .prepare(
        "SELECT outcome, eval_suite FROM runs WHERE eval_suite = 'drift_watch' ORDER BY started_at DESC, rowid DESC LIMIT 1",
      )
      .get() as { outcome: string; eval_suite: string };
    expect(run).toEqual({ outcome: "verified", eval_suite: "drift_watch" });
  }, 120_000);

  it("repairs a changed portal overnight, canaries it, activates v2 and sends one card", async () => {
    sys.portals.partner.setVersion("v2");
    const before = submissions();
    const [outcome] = await sys.orchestrator.watch({ trigger: "schedule" });
    await sys.orchestrator.drain();
    expect(outcome).toMatchObject({ skill: "register_partner_deal", outcome: "repaired", activated: 2 });
    const card = lastCard();
    expect(card.body).toMatch(
      /^Caravela Partner Hub changed overnight\. I repaired \d+ steps \(\d+ free, \d+ with Muse Spark Open\) and checked it with 5 dry runs\. v2 is active, v1 is kept\. Nothing to do\.$/,
    );
    expect(card.buttons?.map((b) => b.title)).toEqual(["Roll back", "Details"]);
    expect(sys.skills.active("register_partner_deal")?.version).toBe(2);
    expect(submissions()).toBe(before); // a watch never submits

    await tap(card, "Details");
    expect(last()?.type).toBe("image");
    expect(last()?.caption).toMatch(/steps repaired: \d+ free from stored selectors/);
  }, 180_000);

  it("lets the next real job replay v2 with no heals and no model calls", async () => {
    await send({ file: { path: VILA, mime: "image/jpeg" } });
    const plan = lastCard();
    expect(plan.body).toContain("register_partner_deal v2");
    await tap(plan, "Approve");
    await tap(lastCard(), "Approve");
    const receipt = outbox().findLast((r) => r.type === "image");
    expect(receipt?.caption).toContain("Replay · compiled skill");
    const run = sys.db.raw
      .prepare(
        "SELECT mode, model_calls FROM runs WHERE eval_suite IS NULL AND id NOT LIKE '%-%' ORDER BY started_at DESC, rowid DESC LIMIT 1",
      )
      .get() as { mode: string; model_calls: number };
    expect(run).toEqual({ mode: "replay", model_calls: 0 });
  }, 120_000);

  it("asks once about a new required field; the answer becomes the default the next job uses", async () => {
    sys.portals.partner.setMutation({ seed: 1, operators: ["insert_required_field"] });
    try {
      const watching = sys.orchestrator.watch({ trigger: "schedule" });
      // The question is waiting on the rep: the watch is parked on it.
      for (let i = 0; i < 100 && !/now requires Partner tier/.test(lastCard().body ?? ""); i++)
        await new Promise((r) => setTimeout(r, 100));
      const question = lastCard();
      expect(question.body).toMatch(
        /^Caravela Partner Hub now requires Partner tier for every registration\. Which should I use\?/,
      );
      expect(question.buttons?.map((b) => b.title)).toEqual(["Gold", "Silver", "Bronze"]);
      await tap(question, "Gold");
      const [outcome] = await watching;
      await sys.orchestrator.drain();
      expect(outcome).toMatchObject({ outcome: "repaired", activated: 3 });
      expect(lastCard().body).toMatch(
        /I'll use Gold from now on\..* v3 is active, v2 is kept\. Nothing to do\.$/,
      );
      const tier = sys.skills.active("register_partner_deal")?.params.find((p) => p.name === "partner_tier");
      expect(tier?.default).toBe("Gold");

      await send({ file: { path: CAFE, mime: "image/jpeg" } });
      const plan = lastCard();
      expect(plan.body).toMatch(/with register_partner_deal v\d+\./);
      await tap(plan, "Approve");
      const commit = lastCard();
      expect(commit.body).toMatch(/^Ready to submit/); // no question this time
      await tap(commit, "Approve");
      expect(sys.portals.partner.submissions().at(-1)?.fields.partnerTier).toBe("Gold");
    } finally {
      sys.portals.partner.setMutation(null);
    }
  }, 180_000);

  it("rolls back from the card", async () => {
    const card = outbox().findLast((r) => r.type === "interactive" && /v3 is active/.test(r.body ?? ""));
    if (!card) throw new Error("no v3 card");
    await tap(card, "Roll back");
    expect(last()?.body).toBe(
      "Rolled back: register_partner_deal v2 is active (v3 kept: /rollback register_partner_deal 3).",
    );
    await tap(card, "Roll back");
    expect(last()?.body).toBe("Already rolled back: register_partner_deal v2 is active.");
  }, 60_000);
});

describe("drift watch without a model rung", () => {
  let sys: TestSystem;
  beforeAll(async () => {
    sys = await createTestSystem({ models: { openWeights: false } });
    await setUp(sys);
  }, 180_000);
  afterAll(async () => {
    await sys?.close();
  });

  it("repairs with computer use, still dry, and activates the next version", async () => {
    sys.portals.partner.setVersion("v2");
    const before = sys.portals.partner.submissions().length;
    const [outcome] = await sys.orchestrator.watch({ trigger: "schedule" });
    await sys.orchestrator.drain();
    expect(outcome).toMatchObject({ outcome: "repaired", activated: 2 });
    expect(sys.skills.active("register_partner_deal")?.version).toBe(2);
    expect(sys.portals.partner.submissions()).toHaveLength(before); // dry runs never submit
  }, 180_000);
});

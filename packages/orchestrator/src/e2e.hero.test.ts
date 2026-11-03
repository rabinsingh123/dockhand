// The hero loop through the WhatsApp emulator: teach -> first run (computer use, scripted) -> v1 -> replay with
// zero execution model calls -> portal v2 -> heal (fake open-weights pick) -> canary -> v2 -> a new required
// field -> question gate -> "Gold" -> v3 with partner_tier. Deterministic: drain() and the outbox, no sleeps.

import { join } from "node:path";
import type { CallCtx, OutboundRecord, StructuredRequest } from "@dockhand/core";
import { workspaceRoot } from "@dockhand/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  caravelaScript,
  createTestSystem,
  fixtureStructured,
  type TestSystem,
  teachFixture,
} from "./testing/harness.ts";

const inbound = (f: string) => join(workspaceRoot(), "fixtures", "inbound", f);

/** Open-weights stand-in: the element with the step's old name, or its known v2 name. */
function pickRenamed(req: StructuredRequest<unknown>): unknown {
  const renamed: Record<string, string> = {
    "Submit registration": "Register opportunity",
    Product: "Solution",
  };
  const lines = req.input
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("\n")
    .split("\n");
  const prefix = "Element the step used before the change: ";
  const old = JSON.parse(
    (lines.find((l) => l.startsWith(prefix)) ?? prefix).slice(prefix.length) || "{}",
  ) as {
    name?: string;
    label?: string;
  };
  const list = JSON.parse(lines[lines.indexOf("Elements of the same kind on the page now:") + 1] ?? "[]") as {
    index: number;
    name?: string;
    label?: string;
  }[];
  const oldName = old.label ?? old.name ?? "";
  const want = renamed[oldName] ?? oldName;
  const hit = list.find((e) => e.name === want || e.label === want);
  return hit
    ? { index: hit.index, confidence: 0.92, reason: `'${want}' does what '${oldName}' did` }
    : { index: null, confidence: 0, reason: "nothing like it" };
}

let sys: TestSystem;
const healCalls: string[] = [];

beforeAll(async () => {
  sys = await createTestSystem({
    models: {
      openWeights: true,
      structured: (req: StructuredRequest<unknown>, ctx: CallCtx) => {
        if (ctx.purpose === "heal_match") {
          healCalls.push(req.model);
          return pickRenamed(req);
        }
        return fixtureStructured(req, ctx);
      },
    },
    cuScript: caravelaScript({
      company: "Café Aurora Ltda.",
      website: "cafeaurora.example",
      country: "Brazil",
      city: "São Paulo",
      contactName: "Júlia Prado",
      contactEmail: "julia@cafeaurora.example",
      contactPhone: "+55 11 99999-0142",
      product: "Tidewater Cloud Business",
      seats: 25,
      closeDateDmy: "29/01/2027",
      referralPartner: "Rota Consultoria",
      notes: "6 lojas. Decisão dos sócios em janeiro.",
    }),
  });
}, 120_000);

afterAll(async () => {
  await sys?.close();
});

const outbox = () => sys.emulator.outbox(sys.rep);

async function send(msg: Parameters<TestSystem["emulator"]["send"]>[1]): Promise<void> {
  await sys.emulator.send(sys.rep, msg);
  await sys.orchestrator.drain();
}

function dump(): string {
  return outbox()
    .map((r) => `[${r.type}] ${(r.body ?? r.caption ?? "").slice(0, 160)}`)
    .join(" || ");
}

function lastCard(): OutboundRecord {
  const card = outbox().findLast((r) => r.type === "interactive");
  if (!card)
    throw new Error(
      `no button card yet; outbox: ${outbox()
        .map((r) => r.body ?? r.caption)
        .join(" | ")}`,
    );
  return card;
}

async function tap(card: OutboundRecord, code: string): Promise<void> {
  const button = card.buttons?.find((b) => b.id.endsWith(`:${code}`));
  if (!button) throw new Error(`card has no ${code} button: ${JSON.stringify(card.buttons)}`);
  await sys.emulator.tap(sys.rep, card.waId, button.id);
  await sys.orchestrator.drain();
}

function latestRunId(): string {
  return (
    sys.db.raw
      .prepare("SELECT id FROM runs WHERE id NOT LIKE '%-%' ORDER BY started_at DESC, rowid DESC LIMIT 1")
      .get() as { id: string }
  ).id;
}

describe("hero loop through WhatsApp", () => {
  it("(a) learns a draft from a screen recording sent as a document", async () => {
    await send({ file: { path: teachFixture().videoPath, mime: "video/mp4", asDocument: true } });
    const card = lastCard();
    expect(card.body).toContain("I learned *Register a partner deal on Caravela Partner Hub*: ");
    expect(card.headerImagePath).toBeTruthy();
    await tap(card, "a");
    expect(sys.skills.draftForPortal("caravela")?.draft.name).toBe("register_partner_deal");
    expect(outbox().at(-1)?.body).toContain('Saved the draft "register_partner_deal"');
  }, 60_000);

  it("(b) runs a referral photo once with computer use, then compiles v1", async () => {
    await send({ file: { path: inbound("referral-cafe-aurora.jpg"), mime: "image/jpeg" } });
    const plan = lastCard();
    expect(plan.body).toContain("First time, so I'll fill the form with computer use");
    expect(plan.body).toMatch(/: Café Aurora Ltda\.$/m); // the company stays in the text, labelled
    expect(plan.headerImagePath).toBeTruthy(); // the plan card lists every value
    await tap(plan, "a");

    const commit = lastCard();
    expect(commit.body, dump()).toContain("Ready to submit on Caravela Partner Hub");
    expect(commit.headerImagePath).toBeTruthy();
    expect(sys.portals.partner.submissions()).toHaveLength(0); // nothing written before the tap
    await tap(commit, "a");

    const [submission] = sys.portals.partner.submissions();
    expect(submission?.fields).toEqual({
      companyName: "Café Aurora Ltda.",
      companyWebsite: "cafeaurora.example",
      country: "Brazil",
      city: "São Paulo",
      contactName: "Júlia Prado",
      contactEmail: "julia@cafeaurora.example",
      contactPhone: "+55 11 99999-0142",
      product: "Tidewater Cloud Business",
      seats: 25,
      expectedCloseDate: "2027-01-29",
      referralPartner: "Rota Consultoria",
      notes: "6 lojas. Decisão dos sócios em janeiro.",
      consent: true,
    });
    const v1 = sys.skills.active("register_partner_deal");
    expect(v1?.version).toBe(1);
    const images = outbox().filter((r) => r.type === "image");
    expect(
      images.some((r) => r.caption?.includes(submission?.id ?? "NW-REG-") && r.caption.includes("First run")),
    ).toBe(true);
    expect(images.at(-1)?.caption).toContain("New skill: register_partner_deal v1");
  }, 180_000);

  it("(c) replays the second referral with zero execution model calls", async () => {
    await send({ file: { path: inbound("referral-vila-nova.jpg"), mime: "image/jpeg" } });
    const plan = lastCard();
    expect(plan.body).toContain("register_partner_deal v1");
    await tap(plan, "a");
    const commit = lastCard();
    expect(plan.body).toContain("Vila Nova Logística Ltda.");
    expect(commit.body).toContain("Ready to submit on Caravela Partner Hub");
    await tap(commit, "a");

    const runId = latestRunId();
    expect(sys.repos.runs.get(runId)).toMatchObject({ mode: "replay", outcome: "success", modelCalls: 0 });
    expect(sys.ledger.totals({ runId }).calls).toBe(0);
    const receipt = outbox().findLast((r) => r.type === "image");
    expect(receipt?.caption).toMatch(/^\*Deal registration for Vila Nova Logística Ltda\.\* `NW-REG-\d+`/);
    expect(receipt?.caption).toContain("Replay · compiled skill");
    expect(receipt?.caption).toContain("execution $0.00 +");
    expect(receipt?.caption).toMatch(/\d+\/\d+ fields verified/);
    expect(sys.portals.partner.submissions().at(-1)?.fields.companyName).toBe("Vila Nova Logística Ltda.");
  }, 120_000);

  it("(d) heals on the v2 portal, passes the canary and saves v2 with a diff", async () => {
    sys.portals.partner.setVersion("v2");
    await send({ file: { path: inbound("referral-cafe-aurora.jpg"), mime: "image/jpeg" } });
    await tap(lastCard(), "a");
    const commit = lastCard();
    expect(commit.body).toContain("Ready to submit");
    await tap(commit, "a");

    expect(healCalls.length).toBeGreaterThan(0);
    expect(sys.skills.active("register_partner_deal")?.version).toBe(2);
    const diff = outbox().findLast((r) => r.type === "image");
    expect(diff?.caption).toContain("Portal changed: Caravela Partner Hub.");
    expect(diff?.caption).toContain("/rollback register_partner_deal 1");
    const receipt = outbox()
      .filter((r) => r.type === "image")
      .at(-2);
    expect(receipt?.caption).toContain("Replay · repaired");
    // The heal here is a stand-in (provider "fake"), so no Muse Spark Open credit.
    expect(receipt?.caption).not.toContain("Built with Muse Spark Open");
    expect(sys.portals.partner.submissions().at(-1)?.version).toBe("v2");
  }, 180_000);

  it("(e) asks the rep for a new required field and saves the answer as a param", async () => {
    sys.portals.partner.setMutation({ seed: 1, operators: ["insert_required_field"] });
    await send({ file: { path: inbound("referral-vila-nova.jpg"), mime: "image/jpeg" } });
    await tap(lastCard(), "a"); // plan
    // The empty required field is caught before the submit card: one question, then one approval.
    const question = lastCard();
    expect(question.body).toContain('"Partner tier"');
    expect(question.buttons?.map((b) => b.title)).toEqual(["Gold", "Silver", "Bronze"]);
    await tap(question, "o0");
    await tap(lastCard(), "a"); // commit again, now with the tier

    const latest = sys.portals.partner.submissions().at(-1);
    expect(latest?.fields.partnerTier).toBe("Gold");
    const active = sys.skills.active("register_partner_deal");
    expect(active?.version).toBe(3);
    expect(active?.params.some((p) => p.name === "partner_tier")).toBe(true);
  }, 180_000);
});

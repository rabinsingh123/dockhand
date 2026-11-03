// Supplier onboarding: zero-shot computer use on the acme tenant from the invitation PDF and the company
// profile (both uploads, commit gate), compiled into supplier_onboarding v1, then replayed on globex.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type OutboundRecord, workspaceRoot } from "@dockhand/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestSystem, supplierScript, type TestSystem } from "./testing/harness.ts";

const root = workspaceRoot();
const profile = JSON.parse(
  readFileSync(join(root, "fixtures", "profile", "tidewater.json"), "utf8"),
) as Record<string, string>;
let sys: TestSystem;

beforeAll(async () => {
  sys = await createTestSystem({ cuScript: supplierScript(profile, "acme") });
}, 120_000);

afterAll(async () => {
  await sys?.close();
});

const outbox = () => sys.emulator.outbox(sys.rep);
const dump = () =>
  outbox()
    .map((r) => `[${r.type}] ${(r.body ?? r.caption ?? "").slice(0, 200)}`)
    .join(" || ");
const lastCard = (): OutboundRecord => {
  const card = outbox().findLast((r) => r.type === "interactive");
  if (!card) throw new Error(`no card: ${dump()}`);
  return card;
};
async function tap(card: OutboundRecord, code: string): Promise<void> {
  const id = card.buttons?.find((b) => b.id.endsWith(`:${code}`))?.id ?? "";
  await sys.emulator.tap(sys.rep, card.waId, id);
  await sys.orchestrator.drain();
}
async function sendPdf(name: string): Promise<void> {
  await sys.emulator.send(sys.rep, {
    file: { path: join(root, "fixtures", "inbound", name), mime: "application/pdf" },
  });
  await sys.orchestrator.drain();
}

const EXPECTED_SAMPLE = {
  legalName: "Tidewater Cloud Ltda.",
  taxId: "00-1234567",
  countryOfIncorporation: "Brazil",
  city: "São Paulo",
  primaryContactEmail: "ana.ribeiro@example.com",
  bankName: "Banco Exemplo S.A.",
  routingNumber: "999999999",
  currency: "BRL",
  signatoryName: "Renata Figueiredo",
};

describe("supplier onboarding", () => {
  it("(g1) registers on acme zero-shot, stops for approval, and compiles supplier_onboarding v1", async () => {
    await sendPdf("acme-supplier-invitation.pdf");
    const plan = lastCard();
    expect(plan.body, dump()).toContain(
      "Register Tidewater Cloud as a supplier for Acme Group (invite ACME-7731)",
    );
    await tap(plan, "a");
    const commit = lastCard();
    expect(commit.body, dump()).toContain("Ready to submit on Supplier Portal");
    expect(sys.portals.supplier.submissions()).toHaveLength(0);
    await tap(commit, "a");

    const [sub] = sys.portals.supplier.submissions();
    expect(sub?.tenant, dump()).toBe("acme");
    expect(sub?.inviteCode).toBe("ACME-7731");
    expect(sub?.fields).toMatchObject(EXPECTED_SAMPLE);
    expect(sub?.files?.map((f) => [f.field, f.filename]).sort()).toEqual([
      ["coiFile", "insurance-certificate-sample.pdf"],
      ["w9File", "w9-sample.pdf"],
    ]);
    const skill = sys.skills.active("supplier_onboarding");
    expect(skill?.version, dump()).toBe(1);
    expect(skill?.params.some((p) => p.type === "file")).toBe(true);
    // The receipt names this request's buyer, not the portal.
    const receipt = outbox().findLast((r) => r.type === "image" && /SG-ACME-/.test(r.caption ?? ""));
    expect(receipt?.caption, dump()).toMatch(/^\*Supplier registration for Acme Group\* `SG-ACME-\d+`/);
  }, 300_000);

  it("(g2) replays on globex with a different invite code and no execution model calls", async () => {
    // Live, the annotate model titled the skill after the first buyer (live-sim-4). A replay for another buyer
    // must not carry that title onto its receipt.
    sys.db.raw
      .prepare("UPDATE skills SET json = json_set(json, '$.title', ?) WHERE name = 'supplier_onboarding'")
      .run("Supplier Registration for Acme Group");
    await sendPdf("globex-supplier-invitation.pdf");
    const plan = lastCard();
    expect(plan.body, dump()).toContain("supplier_onboarding v1");
    expect(plan.body).toContain("GLOBEX-2048");
    await tap(plan, "a");
    const commit = lastCard();
    expect(commit.body, dump()).toContain("Ready to submit");
    await tap(commit, "a");

    const globex = sys.portals.supplier.submissions().find((s) => s.tenant === "globex");
    expect(globex?.inviteCode, dump()).toBe("GLOBEX-2048");
    expect(globex?.fields).toMatchObject(EXPECTED_SAMPLE);
    expect(globex?.files).toHaveLength(2);
    const run = sys.db.raw
      .prepare(
        "SELECT id, mode, model_calls FROM runs WHERE id NOT LIKE '%-%' ORDER BY started_at DESC, rowid DESC LIMIT 1",
      )
      .get() as { id: string; mode: string; model_calls: number };
    expect(run).toMatchObject({ mode: "replay", model_calls: 0 });
    const receipt = outbox().findLast((r) => r.type === "image" && /SG-GLOBEX-/.test(r.caption ?? ""));
    expect(receipt?.caption, dump()).toMatch(
      /^\*Supplier registration for Globex Industrial\* `SG-GLOBEX-\d+`/,
    );
    expect(receipt?.caption).not.toContain("Acme");
  }, 300_000);
});

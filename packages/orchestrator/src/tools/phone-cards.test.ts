// Phone cards: 2x renders, escaped data, the teach and diff templates say what matters.

import { createMemoryArtifactStore, type Skill, type SkillDraft, type Step } from "@dockhand/core";
import { describe, expect, it } from "vitest";
import {
  createPhoneCards,
  diffPhoneCardHtml,
  PHONE_CARD_WIDTH,
  phoneCardHtml,
  teachPhoneCardHtml,
  withParams,
} from "./phone-cards.ts";

const draft: SkillDraft = {
  name: "register_partner_deal",
  title: "Register <b>a</b> deal",
  portalId: "caravela",
  startUrl: "http://127.0.0.1:5101/deals/new",
  goal: "Register the referral",
  steps: ["Type {{company_name}} into End customer company", "Pick {{product}}", "Click Submit registration"],
  params: [
    { name: "company_name", type: "string", required: true, description: "Company" },
    { name: "product", type: "enum", required: true, description: "Product" },
    { name: "notes", type: "string", required: false, description: "Notes" },
  ],
  commitStep: "Submit registration",
  success: "A registration ID like NW-REG-12345",
};

const field = (id: string, label: string, testId: string): Step => ({
  id,
  op: "fill",
  intent: `Fill ${label}`,
  value: "{{x}}",
  target: {
    candidates: [{ by: "testid", value: testId }],
    fingerprint: { tag: "input", role: "textbox", label, name: label, bbox: { x: 0, y: 0, w: 10, h: 10 } },
  },
});

describe("phone cards", () => {
  it("renders 540 CSS px wide at 2x, full page, and stores the PNG", async () => {
    const calls: unknown[] = [];
    const cards = createPhoneCards({
      artifacts: createMemoryArtifactStore(),
      render: async (html, size, opts) => {
        calls.push({ size, opts, html: html.slice(0, 15) });
        return Uint8Array.from([137, 80, 78, 71]);
      },
    });
    const ref = await cards.render(
      "01JOB",
      phoneCardHtml({ eyebrow: "Drift watch", title: "Nothing to do", sections: [] }),
    );
    expect(ref.mime).toBe("image/png");
    expect(calls).toEqual([
      { size: { w: PHONE_CARD_WIDTH, h: 320 }, opts: { fullPage: true, scale: 2 }, html: "<!doctype html>" },
    ]);
  });

  it("teach card: escaped title, params as chips, required values first, the submit control", () => {
    const html = teachPhoneCardHtml(draft, { portalName: "Caravela Partner Hub", frames: [], durationS: 45 });
    expect(html).toContain("Register &#60;b&#62;a&#60;/b&#62; deal");
    expect(html).toContain('<span class="p">company_name</span>');
    expect(html).toContain("notes<i>string</i>"); // optional values follow the required ones
    expect(html).toContain("3 steps · 3 typed values");
    expect(html).toContain("Submit registration");
    expect(html).toContain("from your 45 s recording");
    expect(withParams("{{close_date|date:DD/MM/YYYY}} <x>")).toBe(
      '<span class="p">close_date</span> &#60;x&#62;',
    );
  });

  it("diff card: renamed controls with their rung, free heals counted, canary and rollback", () => {
    const parent = {
      name: "register_partner_deal",
      version: 1,
      params: draft.params,
      steps: [field("s1", "Product", "product"), field("s2", "City", "city"), field("s3", "Seats", "seats")],
    } satisfies Pick<Skill, "name" | "version" | "steps" | "params">;
    const saved = {
      ...parent,
      version: 2,
      title: "Register a deal",
      params: [
        ...draft.params,
        { name: "partner_tier", type: "enum" as const, required: true, description: "Tier" },
      ],
      steps: [
        field("s1", "Solution", "solution"),
        field("s2", "City", "city-2"),
        field("s3", "Seats", "seats-2"),
      ],
    };
    const html = diffPhoneCardHtml({
      portalName: "Caravela Partner Hub",
      parent,
      saved,
      steps: [
        { idx: 0, stepId: "s1", status: "repaired", rung: "open_weights", ms: 900 },
        { idx: 1, stepId: "s2", status: "healed", rung: "fallback", ms: 40 },
        { idx: 2, stepId: "s3", status: "healed", rung: "similarity", ms: 40 },
      ],
      canary: { passed: 3, total: 3 },
      costUsd: 0.0031,
      usedOpenWeights: true,
    });
    expect(html).toContain('<span class="old">Product</span>');
    expect(html).toContain('<span class="new">Solution</span>');
    expect(html).toContain("rung 2 · Muse Spark Open");
    expect(html).toContain("2 fields</span>: found by stored selectors");
    expect(html).toContain("3/3");
    expect(html).toContain("$0.003");
    expect(html).toContain("partner_tier");
    expect(html).toContain("/rollback register_partner_deal 1");
    expect(html).toContain("Built with Muse Spark Open");
  });
});

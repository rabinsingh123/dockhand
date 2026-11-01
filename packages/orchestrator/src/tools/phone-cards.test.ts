// Phone cards: 4:5 renders at 2x, escaped data, counts from one source, money at the ledger's precision.

import { createMemoryArtifactStore, type Skill, type SkillDraft, type Step } from "@dockhand/core";
import { describe, expect, it } from "vitest";
import {
  askPhoneCardHtml,
  createPhoneCards,
  diffPhoneCardHtml,
  draftCounts,
  money,
  PHONE_CARD_HEIGHT,
  PHONE_CARD_WIDTH,
  phoneCardHtml,
  planPhoneCardHtml,
  receiptPhoneCardHtml,
  repairCost,
  skillCounts,
  skillPhoneCardHtml,
  submitPhoneCardHtml,
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

const field = (id: string, label: string, testId: string, op: Step["op"] = "fill"): Step =>
  ({
    id,
    op,
    intent: `Fill ${label}`,
    value: "{{x}}",
    target: {
      candidates: [{ by: "testid", value: testId }],
      fingerprint: { tag: "input", role: "textbox", label, name: label, bbox: { x: 0, y: 0, w: 10, h: 10 } },
    },
  }) as Step;

describe("phone cards", () => {
  it("renders 540 x 675 CSS px at 2x (a 1080 x 1350 PNG) and stores it", async () => {
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
      phoneCardHtml({ context: "Drift watch", title: "Nothing to do" }),
    );
    expect(ref.mime).toBe("image/png");
    expect(calls).toEqual([
      {
        size: { w: PHONE_CARD_WIDTH, h: PHONE_CARD_HEIGHT },
        opts: { fullPage: false, scale: 2 },
        html: "<!doctype html>",
      },
    ]);
  });

  it("money keeps a paid call visible: $0.0029, $0.096, $0.30; only zero is $0", () => {
    expect([0, 0.00004, 0.0029, 0.0958, 0.3, 10.296].map(money)).toEqual([
      "$0",
      "<$0.0001",
      "$0.0029",
      "$0.096",
      "$0.30",
      "$10.30",
    ]);
  });

  it("teach card: escaped title, the draft's counts, required values first, the submit control", () => {
    const html = teachPhoneCardHtml(draft, { portalName: "Caravela Partner Hub", frames: [], durationS: 45 });
    const n = draftCounts(draft);
    expect(n).toEqual({ steps: 3, values: 3, required: 2 });
    expect(html).toContain("Register &#60;b&#62;a&#60;/b&#62; deal");
    expect(html).toContain(`>${n.values}</b>`);
    expect(html).toContain(`values seen in your 45 s video · ${n.required} required · ${n.steps} steps`);
    expect(html.indexOf("Company name")).toBeLessThan(html.indexOf("Notes <i>optional</i>"));
    expect(html).toContain("Submit registration");
    expect(withParams("{{close_date|date:DD/MM/YYYY}} <x>")).toBe("<b>Close date</b> &#60;x&#62;");
  });

  it("skill card: program counts from skillCounts, and how the video's counts became them", () => {
    const skill = {
      name: "register_partner_deal",
      version: 1,
      title: "Register a deal",
      params: draft.params.slice(0, 2),
      steps: [
        { id: "s1", op: "goto", intent: "Open", url: "http://x" } as Step,
        field("s2", "Company", "company"),
        field("s3", "Product", "product", "select"),
        { id: "s4", op: "click", intent: "Submit" } as Step,
      ],
    } satisfies Pick<Skill, "name" | "version" | "title" | "params" | "steps">;
    expect(skillCounts(skill)).toEqual({ steps: 4, values: 2, fields: 2 });
    const html = skillPhoneCardHtml({
      skill,
      portalName: "Caravela",
      verified: { passed: 2, total: 2 },
      draft,
    });
    expect(html).toContain("<b>3 steps</b> became <b>4 program steps</b>");
    expect(html).toContain("<b>3 values</b> became <b>2</b> (Notes not needed)");
    expect(html).toContain("2/2");
  });

  it("plan, submit, question and receipt cards say where, what and that nothing is sent before the tap", () => {
    const plan = planPhoneCardHtml({
      title: "Register Café Aurora",
      where: "Caravela Partner Hub",
      how: "register_partner_deal v1, no model calls",
      figure: { value: "12", label: "values to write" },
      rows: [["Seats", "25"]],
      foot: "Nothing is submitted until you approve the filled form",
    });
    expect(plan).toContain("Caravela Partner Hub · register_partner_deal v1, no model calls");
    expect(plan).toContain('<span class="k">Seats</span><span class="v">25</span>');
    const submit = submitPhoneCardHtml({
      portalName: "Caravela",
      readback: [{ label: "Seats", value: "25" }],
    });
    expect(submit).toContain("fields read back from the page");
    expect(submit).toContain("Nothing is sent until you tap Approve");
    const ask = askPhoneCardHtml({
      portalName: "Caravela",
      label: "Partner tier",
      options: ["Gold", "Silver"],
    });
    expect(ask).toContain(">Partner tier</b>");
    expect(ask).toContain("<span>Silver</span>");
    const receipt = receiptPhoneCardHtml({
      title: "Register a deal",
      tier: "repair",
      headline: "NW-REG-48221",
      seconds: 6.3,
      execCostUsd: 0.00473,
      intakeCostUsd: 0.0153,
      verified: { matched: 13, checked: 13 },
    });
    expect(receipt).toContain('<b class="m a">NW-REG-48221</b>');
    expect(receipt).toContain("$0.0047");
    expect(receipt).toContain("$0.015");
    expect(receipt).toContain("13/13");
  });

  it("diff card: renamed controls with their rung, free heals counted, canary, cost and rollback", () => {
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
    const steps = [
      { idx: 0, stepId: "s1", status: "repaired" as const, rung: "open_weights" as const, ms: 900 },
      { idx: 1, stepId: "s2", status: "healed" as const, rung: "fallback" as const, ms: 40 },
      { idx: 2, stepId: "s3", status: "healed" as const, rung: "similarity" as const, ms: 40 },
    ];
    const html = diffPhoneCardHtml({
      portalName: "Caravela Partner Hub",
      parent,
      saved,
      steps,
      canary: { passed: 3, total: 3 },
      costUsd: 0.0031,
      usedOpenWeights: true,
    });
    expect(html).toContain('<span class="old">Product</span>');
    expect(html).toContain('<span class="new">Solution</span>');
    expect(html).toContain('<div class="chg on">'); // the accent marks the model-repaired change
    expect(html).toContain("Muse Spark Open");
    expect(html).toContain("2 other steps found again");
    expect(html).toContain("3/3");
    expect(html).toContain("$0.0031");
    expect(html).toContain("new value: Partner tier");
    expect(html).toContain("/rollback register_partner_deal 1");
    expect(html).toContain("Built with Muse Spark Open");
    // A paid rung with no recorded cost (the fake stand-in) shows no figure, never "$0"; free rungs only is $0.
    expect(repairCost({ steps, costUsd: 0 })).toBeUndefined();
    expect(repairCost({ steps: steps.slice(1), costUsd: 0 })).toBe("$0");
    const watch = diffPhoneCardHtml({
      portalName: "Caravela Partner Hub",
      parent,
      saved,
      steps,
      canary: { passed: 5, total: 5 },
      costUsd: 0,
      watch: { when: "overnight" },
    });
    expect(watch).toContain("Caravela Partner Hub changed overnight");
    expect(watch).toContain(">Nothing to do</b>");
    expect(watch).not.toContain("to repair");
  });
});

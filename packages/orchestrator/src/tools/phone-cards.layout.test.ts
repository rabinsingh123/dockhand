// The 4:5 top (1080x1350) of a phone card stands on its own in the WhatsApp bubble: title, frames, step count
// and typed values above the fold on a teach card; a repair card fits entirely, however many changes.

import type { SkillDraft, Step } from "@dockhand/core";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { diffPhoneCardHtml, PHONE_CARD_WIDTH, teachPhoneCardHtml } from "./phone-cards.ts";

const TOP = 1350 / 2; // CSS px: the 4:5 top of a 1080 px wide card rendered at 2x

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
});

const field = (id: string, label: string): Step => ({
  id,
  op: "fill",
  intent: `Fill ${label}`,
  value: "{{x}}",
  target: {
    candidates: [{ by: "testid", value: label.toLowerCase().replace(/\W+/g, "-") }],
    fingerprint: { tag: "input", role: "textbox", label, name: label, bbox: { x: 0, y: 0, w: 10, h: 10 } },
  },
});

function card(costUsd: number, usedOpenWeights: boolean, changes = 1, newParams = 0): string {
  const before = Array.from({ length: changes }, (_, i) => field(`s${i + 1}`, `Old field ${i + 1}`));
  const after = Array.from({ length: changes }, (_, i) => field(`s${i + 1}`, `New field name ${i + 1}`));
  const params = [{ name: "company_name", type: "string" as const, required: true, description: "Company" }];
  return diffPhoneCardHtml({
    portalName: "Caravela Partner Hub",
    parent: { name: "register_partner_deal", version: 1, steps: before, params },
    saved: {
      name: "register_partner_deal",
      version: 2,
      title: "Register a deal",
      steps: after,
      params: [
        ...params,
        ...Array.from({ length: newParams }, (_, i) => ({
          name: `new_value_${i + 1}`,
          type: "enum" as const,
          required: true,
          description: `New ${i + 1}`,
        })),
      ],
    },
    steps: after.map((s, idx) => ({
      idx,
      stepId: s.id,
      status: "repaired" as const,
      rung: "open_weights" as const,
      ms: 900,
    })),
    canary: { passed: 3, total: 3 },
    costUsd,
    usedOpenWeights,
  });
}

async function measure(html: string): Promise<{ height: number; fold: number | null }> {
  const page = await browser.newPage({ viewport: { width: PHONE_CARD_WIDTH, height: 600 } });
  try {
    await page.setContent(html);
    return await page.evaluate(() => ({
      height: document.documentElement.scrollHeight,
      fold: (document.querySelector("[data-fold]") as HTMLElement | null)?.offsetTop ?? null,
    }));
  } finally {
    await page.close();
  }
}

describe("phone cards read in the bubble (4:5)", () => {
  const big: SkillDraft = {
    name: "register_partner_deal",
    title: "Register a partner deal on Caravela Partner Hub, with a title long enough to need a third line",
    portalId: "caravela",
    startUrl: "http://127.0.0.1:5101/deals/new",
    goal: "Register the referral",
    steps: Array.from(
      { length: 30 },
      (_, i) => `Type {{value_${i}}} into a field with a long label number ${i}`,
    ),
    params: Array.from({ length: 20 }, (_, i) => ({
      name: `a_long_parameter_name_${i}`,
      type: "string" as const,
      required: i % 2 === 0,
      description: `Value ${i}`,
    })),
    commitStep: "Submit registration",
    success: "A registration ID like NW-REG-12345",
  };
  const pixel = Uint8Array.from(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
      "base64",
    ),
  );

  it("teach: title, 3 frames, the step count and the typed values all sit above the fold", async () => {
    const html = teachPhoneCardHtml(big, {
      portalName: "Caravela",
      frames: [pixel, pixel, pixel],
      durationS: 45,
    });
    expect(html).toContain("30 steps · 20 typed values");
    expect(html.indexOf("data-fold")).toBeGreaterThan(html.indexOf("a_long_parameter_name_0"));
    const m = await measure(html);
    expect(m.fold).not.toBeNull();
    expect(m.fold).toBeLessThanOrEqual(TOP);
  });

  it("repair: the whole card fits in 4:5, however many changes", async () => {
    const m = await measure(card(0.0123, true, 12, 9));
    expect(m.height).toBeLessThanOrEqual(TOP);
  });
});

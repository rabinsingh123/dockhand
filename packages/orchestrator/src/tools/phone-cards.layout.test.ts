// Every phone card is exactly 4:5 (1080 x 1350 at 2x), what WhatsApp shows uncropped in the bubble: however long
// the data, nothing runs past the card's bottom line.

import type { SkillDraft, Step } from "@dockhand/core";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  askPhoneCardHtml,
  diffPhoneCardHtml,
  PHONE_CARD_HEIGHT,
  PHONE_CARD_WIDTH,
  planPhoneCardHtml,
  receiptPhoneCardHtml,
  submitPhoneCardHtml,
  teachPhoneCardHtml,
} from "./phone-cards.ts";

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

/** The bottom of the card's last element, and the document's own size. */
async function measure(html: string): Promise<{ w: number; h: number; bottom: number }> {
  const page = await browser.newPage({ viewport: { width: PHONE_CARD_WIDTH, height: PHONE_CARD_HEIGHT } });
  try {
    await page.setContent(html);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    return await page.evaluate(() => {
      const card = document.querySelector(".dh-card") as HTMLElement;
      const last = card.lastElementChild as HTMLElement;
      return {
        w: document.documentElement.scrollWidth,
        h: document.documentElement.scrollHeight,
        bottom: last.getBoundingClientRect().bottom,
      };
    });
  } finally {
    await page.close();
  }
}

const long = "a value long enough to need clipping on a phone card, and then some more words";
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

describe("phone cards fit 4:5", () => {
  const before = Array.from({ length: 12 }, (_, i) => field(`s${i + 1}`, `Old field ${i + 1}`));
  const after = Array.from({ length: 12 }, (_, i) => field(`s${i + 1}`, `New field name ${i + 1}`));
  const cards: Record<string, string> = {
    teach: teachPhoneCardHtml(big, { portalName: "Caravela", frames: [pixel, pixel, pixel], durationS: 45 }),
    plan: planPhoneCardHtml({
      title: "Register Vila Nova Logística Ltda. e Associados Comércio Internacional",
      where: "Caravela Partner Hub",
      how: "register_partner_deal v1, no model calls",
      figure: { value: "35 values", label: "and 2 documents from the company profile" },
      rows: Array.from({ length: 35 }, (_, i): [string, string] => [`${long} ${i}`, long]),
      foot: "Nothing is submitted until you approve the filled form",
    }),
    submit: submitPhoneCardHtml({
      portalName: "Caravela Partner Hub",
      screenshot: pixel,
      readback: Array.from({ length: 40 }, (_, i) => ({ label: `Field ${i}`, value: long })),
    }),
    ask: askPhoneCardHtml({
      portalName: "Caravela",
      label: "Partner tier",
      options: ["Gold", "Silver", "Bronze", "Platinum", "Diamond", "Copper", "Iron"],
      screenshot: pixel,
    }),
    receipt: receiptPhoneCardHtml({
      title: long,
      tier: "repair",
      headline: "NW-REG-48221",
      line: long,
      seconds: 125,
      execCostUsd: 0.0047,
      intakeCostUsd: 0.015,
      verified: { matched: 13, checked: 13 },
      skill: { name: "register_partner_deal", version: 12 },
      usedOpenWeights: true,
      screenshot: pixel,
    }),
    diff: diffPhoneCardHtml({
      portalName: "Caravela Partner Hub",
      parent: { name: "register_partner_deal", version: 1, steps: before, params: [] },
      saved: {
        name: "register_partner_deal",
        version: 2,
        title: "Register a deal",
        steps: after,
        params: Array.from({ length: 9 }, (_, i) => ({
          name: `new_value_${i}`,
          type: "enum" as const,
          required: true,
          description: "x",
        })),
      },
      steps: after.map((s, idx) => ({
        idx,
        stepId: s.id,
        status: "repaired" as const,
        rung: "open_weights" as const,
        ms: 900,
      })),
      canary: { passed: 3, total: 3 },
      costUsd: 0.0123,
      usedOpenWeights: true,
      watch: { when: "overnight" },
    }),
  };
  for (const [name, html] of Object.entries(cards)) {
    it(`${name}: nothing runs past the bottom line or the sides`, async () => {
      const m = await measure(html);
      expect(m.w).toBeLessThanOrEqual(PHONE_CARD_WIDTH);
      expect(m.h).toBeLessThanOrEqual(PHONE_CARD_HEIGHT);
      expect(m.bottom).toBeLessThanOrEqual(PHONE_CARD_HEIGHT);
    });
  }
});

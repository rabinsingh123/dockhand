// Real-app form habits seen on EspoCRM 10 (scripts/oss/espocrm.ts), on a small fixture page: labels never
// tied to their inputs, a number input that keeps only typed values, and validation shown as `.has-error` on
// the field's cell with no aria-invalid.

import { DH_SCRIPT, describeLocator } from "@dockhand/browser";
import { createMemoryArtifactStore, type Skill } from "@dockhand/core";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runSkill } from "./runner.ts";

const ORIGIN = "http://crm.test";
const PAGE = `<!doctype html><html><body>
<div class="record">
  <div class="cell" data-name="accountName"><label class="control-label">Account Name</label>
    <div class="field"><input type="text" class="form-control" data-name="accountName"></div></div>
  <div class="cell" data-name="amount"><label class="control-label">Opportunity Amount</label>
    <div class="field"><input type="text" class="form-control numeric" data-name="amount"></div></div>
  <div class="cell" data-name="taxId" id="taxCell" hidden><label class="control-label">Tax ID <span>*</span></label>
    <div class="field"><input type="text" class="form-control" data-name="taxId"></div></div>
  <button type="button" class="btn btn-primary" id="save">Save</button>
</div>
<script>
  const q = (n) => document.querySelector('input[data-name="' + n + '"]');
  if (location.search.includes("tax")) document.getElementById("taxCell").hidden = false;
  // Like EspoCRM's numeric field: the model only follows keystrokes, and blur redraws the input from the model.
  let amount = "";
  q("amount").addEventListener("keyup", (e) => { amount = e.target.value; });
  q("amount").addEventListener("blur", (e) => { e.target.value = amount; });
  document.getElementById("save").addEventListener("click", () => {
    const cell = document.getElementById("taxCell");
    if (!cell.hidden && q("taxId").value.trim() === "") { cell.classList.add("has-error"); return; }
    window.saved = { accountName: q("accountName").value, amount, taxId: q("taxId").value };
    location.hash = "#saved";
  });
</script></body></html>`;

let browser: Browser;
const artifacts = createMemoryArtifactStore();

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
});

async function open(path: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await context.addInitScript({ content: DH_SCRIPT });
  await context.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: PAGE }),
  );
  const page = await context.newPage();
  await page.goto(`${ORIGIN}${path}`);
  return { page, close: () => context.close() };
}

async function skillFor(page: Page): Promise<Skill> {
  const account = await describeLocator(page.locator('input[data-name="accountName"]'));
  const amount = await describeLocator(page.locator('input[data-name="amount"]'));
  const save = await describeLocator(page.getByRole("button", { name: "Save" }));
  return {
    name: "crm_lead",
    version: 1,
    parentVersion: null,
    title: "Create a lead",
    portalId: "crm",
    params: [
      { name: "account_name", type: "string", required: true, description: "Company" },
      { name: "amount", type: "number", required: true, description: "Amount" },
    ],
    steps: [
      {
        id: "s1",
        op: "goto",
        intent: "Open the form",
        url: `${ORIGIN}/lead${page.url().includes("tax") ? "?tax" : ""}`,
      },
      { id: "s2", op: "fill", intent: "Fill Account Name", target: account, value: "{{account_name}}" },
      { id: "s3", op: "fill", intent: "Fill Opportunity Amount", target: amount, value: "{{amount}}" },
      { id: "s4", op: "click", intent: "Save", target: save, commit: true },
    ],
    success: { urlIncludes: "#saved", extract: [] },
    createdFrom: { kind: "goal", traceRunId: "fixture" },
    changelog: "",
  };
}

const hooks = (asked: string[], answer: string | null) => ({
  approveCommit: async () => "approved" as const,
  approveSafety: async () => "rejected" as const,
  askRep: async (q: { label: string }) => {
    asked.push(q.label);
    return answer;
  },
});

describe("forms without ARIA wiring", () => {
  it("takes the visible label of an unlabelled input into its fingerprint", async () => {
    const { page, close } = await open("/lead");
    try {
      const t = await describeLocator(page.locator('input[data-name="accountName"]'));
      expect(t.fingerprint.label).toBe("Account Name");
      expect(t.candidates.some((c) => c.by === "label")).toBe(false);
    } finally {
      await close();
    }
  });

  it("types a value the page dropped after a fill", async () => {
    const { page, close } = await open("/lead");
    try {
      const r = await runSkill(
        page,
        await skillFor(page),
        { account_name: "Lumen Agro", amount: 22500 },
        hooks([], null),
        { runId: "unl-1", stepTimeoutMs: 2000, screenshots: "fail_only", allowFallbackHeal: true, artifacts },
      );
      expect(r.outcome).toBe("success");
      expect(await page.evaluate(() => (window as unknown as { saved: unknown }).saved)).toEqual({
        accountName: "Lumen Agro",
        amount: "22500",
        taxId: "",
      });
    } finally {
      await close();
    }
  });

  it("asks the rep for a new required field the page marks with .has-error", async () => {
    const { page, close } = await open("/lead?tax");
    try {
      const asked: string[] = [];
      const r = await runSkill(
        page,
        await skillFor(page),
        { account_name: "Lumen Agro", amount: 22500 },
        hooks(asked, "TX-48213"),
        { runId: "unl-2", stepTimeoutMs: 2000, screenshots: "fail_only", allowFallbackHeal: true, artifacts },
      );
      expect(asked).toEqual(["Tax ID"]);
      expect(r.outcome).toBe("success");
      expect(r.patched?.params.map((p) => p.name)).toContain("tax_id");
      expect(await page.evaluate(() => (window as unknown as { saved: { taxId: string } }).saved.taxId)).toBe(
        "TX-48213",
      );
    } finally {
      await close();
    }
  });
});

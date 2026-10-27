import type { Target } from "@dockhand/core";
import { startPartnerPortal } from "@dockhand/portals";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { centreOf, FIXTURE_ORIGIN, fixtureContext, launchTestBrowser } from "../test-support.ts";
import { describeAt, describeLocator } from "./describe.ts";
import { REGISTER_FORM } from "./fixtures.ts";
import { resolveTarget } from "./resolve.ts";

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await launchTestBrowser();
  ({ page } = await fixtureContext(browser, {
    "/form": REGISTER_FORM,
    "/upload": `<!doctype html><label for=hw9>Hidden W-9</label><input id=hw9 name=hw9 type=file style="display:none">
      <button onclick="hw9.click()">Upload W-9</button>`,
  }));
});
afterAll(async () => {
  await browser?.close();
});

async function companyTarget(): Promise<Target> {
  const { x, y } = await centreOf(page, "#\\:r1\\:");
  return describeAt(page, x, y);
}

const elementId = (r: Awaited<ReturnType<typeof resolveTarget>>) =>
  r.ok ? r.locator.evaluate((el) => el.id) : Promise.resolve(null);

describe("resolveTarget", () => {
  beforeEach(async () => {
    await page.goto(`${FIXTURE_ORIGIN}/form`);
  });

  it("resolves the union of agreeing candidates at once (fast path)", async () => {
    const target = await companyTarget();
    const t0 = Date.now();
    const r = await resolveTarget(page, target, { timeoutMs: 3000, allowSimilarity: false });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r).toMatchObject({ ok: true, via: "candidate", candidateIdx: 0 });
    expect(await elementId(r)).toBe(":r1:");
    if (r.ok) expect(r.descriptor.name).toBe("Company name");
  });

  it("falls back to the next candidate when the testid churned", async () => {
    const target = await companyTarget();
    await page.evaluate(() => document.getElementById(":r1:")?.setAttribute("data-testid", "company-v2"));
    const r = await resolveTarget(page, target, { timeoutMs: 3000, allowSimilarity: false });
    expect(r).toMatchObject({ ok: true, via: "candidate", candidateIdx: 1 });
    expect(await elementId(r)).toBe(":r1:");
  });

  it("escalates when candidates disagree, and settles it by similarity only when allowed", async () => {
    const target = await companyTarget();
    // A careless refactor swaps two testids: the testid now points at Website, every other candidate at Company.
    await page.evaluate(() => {
      document.getElementById(":r1:")?.setAttribute("data-testid", "website");
      document.getElementById(":r2:")?.setAttribute("data-testid", "company");
    });
    const strict = await resolveTarget(page, target, { timeoutMs: 3000, allowSimilarity: false });
    expect(strict).toMatchObject({ ok: false, code: "STEP_AMBIGUOUS" });
    const healed = await resolveTarget(page, target, { timeoutMs: 3000, allowSimilarity: true });
    expect(healed).toMatchObject({ ok: true, via: "similarity", candidateIdx: null });
    expect(await elementId(healed)).toBe(":r1:");
  });

  it("rejects a single-family match whose fingerprint disagrees (testid moved to another field)", async () => {
    const full = await companyTarget();
    const target: Target = { ...full, candidates: full.candidates.filter((c) => c.by === "testid") };
    await page.evaluate(() => {
      document.getElementById(":r1:")?.removeAttribute("data-testid");
      document.getElementById(":r2:")?.setAttribute("data-testid", "company");
    });
    const r = await resolveTarget(page, target, { timeoutMs: 3000, allowSimilarity: false });
    expect(r).toMatchObject({ ok: false, code: "STEP_NOT_FOUND" });
    if (!r.ok) expect(r.detail).toMatch(/rejected/);
    const healed = await resolveTarget(page, target, { timeoutMs: 3000, allowSimilarity: true });
    expect(healed).toMatchObject({ ok: true, via: "similarity" });
    expect(await elementId(healed)).toBe(":r1:");
  });

  it("rejects a role mismatch even when the testid matches", async () => {
    const full = await companyTarget();
    const target: Target = { ...full, candidates: [{ by: "testid", value: "company" }] };
    await page.evaluate(() => {
      document.getElementById(":r1:")?.removeAttribute("data-testid");
      document.querySelector("button[type=submit]")?.setAttribute("data-testid", "company");
    });
    const r = await resolveTarget(page, target, { timeoutMs: 1000, allowSimilarity: false });
    expect(r).toMatchObject({ ok: false, code: "STEP_NOT_FOUND" });
    if (!r.ok) expect(r.detail).toMatch(/role button/);
  });

  it("accepts a label shared by a combobox and its listbox when the unique candidates agree", async () => {
    const { x, y } = await centreOf(page, "#country-input");
    const captured = await describeAt(page, x, y);
    const target: Target = {
      ...captured,
      candidates: [
        { by: "role", role: "combobox", name: "Country", exact: true },
        { by: "label", value: "Country", exact: true },
        { by: "css", value: "#country-input" },
      ],
    };
    const r = await resolveTarget(page, target, { timeoutMs: 2000, allowSimilarity: false });
    expect(r).toMatchObject({ ok: true, via: "candidate", candidateIdx: 0 });
    expect(await elementId(r)).toBe("country-input");
  });

  it("pays the deadline once for a miss, not once per candidate", async () => {
    const target = await companyTarget();
    await page.evaluate(() => document.getElementById(":r1:")?.closest(".row")?.remove());
    const t0 = Date.now();
    const r = await resolveTarget(page, target, { timeoutMs: 400, allowSimilarity: false });
    const ms = Date.now() - t0;
    expect(r).toMatchObject({ ok: false, code: "STEP_NOT_FOUND" });
    expect(ms).toBeGreaterThanOrEqual(380);
    expect(ms).toBeLessThan(1500);
  });

  it("resolves a hidden file input for uploads", async () => {
    await page.goto(`${FIXTURE_ORIGIN}/upload`);
    const target = await describeLocator(page.getByLabel("Hidden W-9"));
    expect(target.candidates[0]).toEqual({ by: "label", value: "Hidden W-9", exact: true });
    const r = await resolveTarget(page, target, { timeoutMs: 2000, allowSimilarity: false });
    expect(r).toMatchObject({ ok: true, via: "candidate" });
    expect(await elementId(r)).toBe("hw9");
  });
});

describe("resolveTarget on Caravela Partner Hub", () => {
  it("heals testid churn by fingerprint similarity", async () => {
    const portal = await startPartnerPortal({ port: 0, latencyMs: [0, 0] });
    try {
      const open = async (mutation: { seed: number; operators: ["testid_churn"] } | null) => {
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        await context.addCookies(await portal.session({ runId: "resolve-heal", ui: "v1", mutation }));
        const p = await context.newPage();
        await p.goto(`${portal.url}/deals/new`);
        return p;
      };
      const v1 = await open(null);
      const company = await describeLocator(v1.getByRole("textbox", { name: "End customer company" }));
      const city = await describeLocator(v1.getByRole("textbox", { name: "City" }));
      await v1.context().close();
      // Only the testid survives in this stored step; a refactor renamed every testid.
      const onlyTestid = (t: Target): Target => ({
        ...t,
        candidates: t.candidates.filter((c) => c.by === "testid"),
      });

      const churned = await open({ seed: 7, operators: ["testid_churn"] });
      expect(await churned.getByTestId("nw-company-name").count()).toBe(0);
      const miss = await resolveTarget(churned, onlyTestid(company), {
        timeoutMs: 300,
        allowSimilarity: false,
      });
      expect(miss).toMatchObject({ ok: false, code: "STEP_NOT_FOUND" });
      for (const [stored, expected] of [
        [company, "End customer company"],
        [city, "City"],
      ] as const) {
        const r = await resolveTarget(churned, onlyTestid(stored), { timeoutMs: 300, allowSimilarity: true });
        expect(r).toMatchObject({ ok: true, via: "similarity", candidateIdx: null });
        if (r.ok) {
          expect(r.descriptor.label).toBe(expected);
          expect(await r.locator.count()).toBe(1);
          expect(await r.locator.evaluate((el) => (el as HTMLInputElement).labels?.[0]?.textContent)).toBe(
            expected,
          );
        }
      }
      await churned.context().close();
    } finally {
      await portal.close();
    }
  });
});

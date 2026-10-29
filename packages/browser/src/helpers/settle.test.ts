import type { Target } from "@dockhand/core";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_ORIGIN, fixtureContext, launchTestBrowser } from "../test-support.ts";
import { describeLocator } from "./describe.ts";
import { resolveTarget } from "./resolve.ts";
import { isSettled, trackNetwork } from "./settle.ts";

let browser: Browser;
beforeAll(async () => {
  browser = await launchTestBrowser();
});
afterAll(async () => {
  await browser?.close();
});

const FORM = `<!doctype html><html><body><form>
  <label for="a">Company</label><input id="a" name="company">
  <button type="button" id="save">Save</button></form>
  <script>
    if (location.search.includes("late")) {
      // A control that shows up 1.6 s after load while a request is in flight (an SPA fetching its form).
      document.getElementById("a").remove();
      fetch("/slow").then(() => {}, () => {});
      setTimeout(() => document.querySelector("form").insertAdjacentHTML("afterbegin",
        '<label for="b">Website</label><input id="b" name="website">'), 1600);
    }
  </script></body></html>`;

async function websiteTarget(): Promise<Target> {
  const { context, page } = await fixtureContext(browser, {
    "/form": FORM.replace('id="a" name="company"', 'id="b" name="website"').replace(">Company<", ">Website<"),
  });
  try {
    await page.goto(`${FIXTURE_ORIGIN}/form`);
    return await describeLocator(page.locator("#b"));
  } finally {
    await context.close();
  }
}

describe("settled pages", () => {
  it("gives up on a missing target in about a second once the page has settled", async () => {
    const target = await websiteTarget();
    const { context, page } = await fixtureContext(browser, { "/form": FORM });
    trackNetwork(page); // as the pool does for every leased page
    try {
      await page.goto(`${FIXTURE_ORIGIN}/form`);
      await page.waitForTimeout(600);
      expect(await isSettled(page)).toBe(true);
      const t0 = Date.now();
      const r = await resolveTarget(page, target, { timeoutMs: 8000, allowSimilarity: false });
      const ms = Date.now() - t0;
      expect(r.ok).toBe(false);
      expect(ms).toBeLessThan(2500);
      if (!r.ok) expect(r.detail).toMatch(/page had settled/);
    } finally {
      await context.close();
    }
  });

  it("keeps waiting while a request is in flight", async () => {
    const target = await websiteTarget();
    const { context, page } = await fixtureContext(browser, { "/form": FORM });
    trackNetwork(page);
    // The slow request answers after 2.5 s; the field appears at 1.6 s, before the 1 s settled window could pass.
    await context.route(`${FIXTURE_ORIGIN}/slow`, async (route) => {
      await new Promise((r) => setTimeout(r, 2500));
      await route.fulfill({ status: 200, body: "ok" }).catch(() => {});
    });
    try {
      await page.goto(`${FIXTURE_ORIGIN}/form?late`);
      const r = await resolveTarget(page, target, { timeoutMs: 8000, allowSimilarity: false });
      expect(r.ok).toBe(true);
    } finally {
      await context.close();
    }
  });
});

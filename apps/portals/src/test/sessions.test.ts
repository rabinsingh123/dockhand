// Per-browser-context state: pinned ui / mutation / runId, defaults, admin + test endpoints.

import type { Browser } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type PortalHandle, partnerAuthCookie, type Submission, startPartnerPortal } from "../index.ts";
import { fillPartnerForm, launchBrowser, newRunId, openContext, samplePartner, VIEWPORT } from "./helpers.ts";

let browser: Browser;
let portal: PortalHandle;

beforeAll(async () => {
  [browser, portal] = await Promise.all([
    launchBrowser(),
    startPartnerPortal({ port: 0, latencyMs: [50, 100] }),
  ]);
});

afterAll(async () => {
  await browser?.close();
  await portal?.close();
});

beforeEach(() => {
  portal.setVersion("v1");
  portal.setMutation(null);
});

describe("per-context sessions", () => {
  it("two contexts on one portal process see their own UI and their submissions are separated by runId", async () => {
    const runA = newRunId("ctx-a");
    const runB = newRunId("ctx-b");
    const a = await openContext(browser, portal, { ui: "v1", runId: runA });
    const b = await openContext(browser, portal, { ui: "v2", runId: runB });
    try {
      await Promise.all([a.page.goto(`${portal.url}/deals/new`), b.page.goto(`${portal.url}/deals/new`)]);
      expect(await a.page.getByRole("button", { name: "Submit registration", exact: true }).count()).toBe(1);
      expect(await a.page.getByRole("button", { name: "Register opportunity" }).count()).toBe(0);
      expect(await b.page.getByRole("button", { name: "Register opportunity", exact: true }).count()).toBe(1);
      expect(await b.page.getByRole("button", { name: "Submit registration" }).count()).toBe(0);

      // GET /api/__config is the effective config of the requesting context.
      const configOf = (page: typeof a.page) =>
        page.evaluate(() => fetch("/api/__config").then((r) => r.json() as Promise<Record<string, unknown>>));
      expect(await configOf(a.page)).toMatchObject({ version: "v1", runId: runA, mutation: null });
      expect(await configOf(b.page)).toMatchObject({ version: "v2", runId: runB, mutation: null });
      expect((await configOf(a.page)).serverDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      // Fill and submit both at the same time.
      await Promise.all([
        (async () => {
          await fillPartnerForm(a.page, samplePartner(portal, { companyName: "Pinheiro Têxtil Ltda." }));
          await a.page.getByRole("button", { name: "Submit registration", exact: true }).click();
          await a.page.waitForURL(/\/deals\/NW-REG-\d{5}$/);
        })(),
        (async () => {
          await fillPartnerForm(
            b.page,
            samplePartner(portal, { companyName: "Ceiba Retail S.A.S." }),
            "Solution",
          );
          await b.page.getByRole("button", { name: "Register opportunity", exact: true }).click();
          await b.page.waitForURL(/\/deals\/NW-REG-\d{5}$/);
        })(),
      ]);

      const subsA = portal.submissions({ runId: runA });
      const subsB = portal.submissions({ runId: runB });
      expect(subsA.map((s) => [s.version, s.fields.companyName])).toEqual([["v1", "Pinheiro Têxtil Ltda."]]);
      expect(subsB.map((s) => [s.version, s.fields.companyName])).toEqual([["v2", "Ceiba Retail S.A.S."]]);

      const viaHttp = (await (
        await fetch(`${portal.url}/api/__test/submissions?runId=${encodeURIComponent(runB)}`)
      ).json()) as Submission[];
      expect(viaHttp.map((s) => s.id)).toEqual(subsB.map((s) => s.id));
      const all = (await (await fetch(`${portal.url}/api/__test/submissions`)).json()) as Submission[];
      expect(all.length).toBeGreaterThanOrEqual(2);

      // Reset one run only.
      portal.reset({ runId: runA });
      expect(portal.submissions({ runId: runA })).toHaveLength(0);
      expect(portal.submissions({ runId: runB })).toHaveLength(1);
      await fetch(`${portal.url}/api/__test/reset?runId=${encodeURIComponent(runB)}`, { method: "POST" });
      expect(portal.submissions({ runId: runB })).toHaveLength(0);
    } finally {
      await a.context.close();
      await b.context.close();
    }
  });

  it("the admin flip changes only contexts that did not pin a version", async () => {
    const pinned = await openContext(browser, portal, { ui: "v1", runId: newRunId("pinned") });
    const live = await browser.newContext({ viewport: VIEWPORT });
    try {
      await live.addCookies([await partnerAuthCookie(portal)]);
      const livePage = await live.newPage();

      await livePage.goto(`${portal.url}/deals/new`);
      expect(await livePage.getByRole("button", { name: "Submit registration", exact: true }).count()).toBe(
        1,
      );

      // The on-camera flip: default -> v2 via the admin endpoint.
      const flip = await fetch(`${portal.url}/api/__admin/version`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: "v2" }),
      });
      expect(await flip.json()).toEqual({ version: "v2" });

      await livePage.reload();
      expect(await livePage.getByRole("button", { name: "Register opportunity", exact: true }).count()).toBe(
        1,
      );
      await pinned.page.goto(`${portal.url}/deals/new`);
      expect(
        await pinned.page.getByRole("button", { name: "Submit registration", exact: true }).count(),
      ).toBe(1);

      // Same for the default mutation.
      const mut = await fetch(`${portal.url}/api/__admin/mutation`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seed: 5, operators: ["testid_churn"] }),
      });
      expect(await mut.json()).toEqual({
        mutation: { seed: 5, operators: ["testid_churn"] },
        operators: ["testid_churn"],
      });
      await livePage.reload();
      expect(await livePage.locator('[data-testid^="reg-"]').count()).toBe(0);
      await pinned.page.reload();
      expect(await pinned.page.locator('[data-testid^="nw-"]').count()).toBeGreaterThan(10);

      const bad = await fetch(`${portal.url}/api/__admin/mutation`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seed: 1, operators: ["not_an_operator"] }),
      });
      expect(bad.status).toBe(400);
      expect((await fetch(`${portal.url}/api/__admin/version`, { method: "POST", body: "{}" })).status).toBe(
        400,
      );
      expect(await (await fetch(`${portal.url}/api/__admin/version`)).json()).toEqual({ version: "v2" });
    } finally {
      await pinned.context.close();
      await live.close();
    }
  });

  it("POST /api/__test/session returns Playwright cookies that pin ui, mutation and runId", async () => {
    const runId = newRunId("http");
    const res = await fetch(`${portal.url}/api/__test/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ui: "v2", runId, mutation: { seed: 9, operators: ["label_synonym"] } }),
    });
    const { cookies } = (await res.json()) as {
      cookies: Array<{ name: string; value: string; domain: string; path: string }>;
    };
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatchObject({ name: `nw_session_${portal.port}`, domain: "127.0.0.1", path: "/" });

    const context = await browser.newContext({ viewport: VIEWPORT });
    try {
      await context.addCookies(cookies);
      const page = await context.newPage();
      await page.goto(`${portal.url}/deals/new`);
      expect(await page.getByRole("button", { name: "Register opportunity", exact: true }).count()).toBe(1);
      expect(await page.getByLabel("End customer company", { exact: true }).count()).toBe(0);
      const config = await page.evaluate(() => fetch("/api/__config").then((r) => r.json()));
      expect(config).toMatchObject({ version: "v2", runId, operators: ["label_synonym"] });
    } finally {
      await context.close();
    }

    const invalid = await fetch(`${portal.url}/api/__test/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ui: "v3", runId }),
    });
    expect(invalid.status).toBe(400);
  });
});

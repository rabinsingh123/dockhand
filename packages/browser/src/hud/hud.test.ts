// The demo HUD draws for the camera only: automation must see exactly the same page with it on, and no
// screenshot may contain it. Two pools on the partner portal: one with the HUD, one without.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Lease, Skill } from "@dockhand/core";
import { type PortalHandle, startPartnerPortal } from "@dockhand/portals";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeAt } from "../helpers/describe.ts";
import { formSnapshot, listInteractive } from "../helpers/forms.ts";
import { createBrowserPool, type DockhandBrowserPool } from "../pool.ts";
import { HUD_TAG, Hud, hudOf, hudOptionsFromEnv, modelLabel } from "./hud.ts";

let portal: PortalHandle;
let withHud: DockhandBrowserPool;
let plain: DockhandBrowserPool;
let stateDir: string;

beforeAll(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "dockhand-hud-"));
  portal = await startPartnerPortal({ port: 0, latencyMs: [0, 0] });
  withHud = createBrowserPool({ headless: true, maxContexts: 1, storageStateDir: stateDir, hud: {} });
  plain = createBrowserPool({ headless: true, maxContexts: 1, storageStateDir: stateDir });
});

afterAll(async () => {
  await withHud?.closeAll();
  await plain?.closeAll();
  await portal?.close();
  rmSync(stateDir, { recursive: true, force: true });
});

async function open(pool: DockhandBrowserPool, runId: string): Promise<Lease> {
  const lease = await pool.lease({
    portalId: "caravela",
    runId,
    cookies: await portal.session({ runId, ui: "v1", mutation: null }),
    ttlMs: 60_000,
  });
  await lease.page.goto(`${portal.url}/deals/new`);
  await lease.page.getByRole("heading", { name: "Register a deal" }).waitFor();
  return lease;
}

describe("demo HUD", () => {
  it("is on only when asked for: env needs DEMO_MODE, the default pool is headless and has none", async () => {
    expect(hudOptionsFromEnv({})).toBeNull();
    expect(hudOptionsFromEnv({ DEMO_MODE: "0", DEMO_PACING_MS: "500" })).toBeNull();
    expect(hudOptionsFromEnv({ DEMO_MODE: "1", DEMO_PACING_MS: "500", META_MODE: "live" })).toEqual({
      pacingMs: 500,
      metaMode: "live",
    });
    const lease = await open(plain, "hud-off");
    try {
      expect(hudOf(lease.page)).toBeUndefined();
      expect(await lease.page.evaluate(() => "__dockhandHud" in window)).toBe(false);
      expect(await lease.page.locator(HUD_TAG).count()).toBe(0);
    } finally {
      await lease.release();
    }
  });

  it("changes nothing automation reads, and never appears in a screenshot", async () => {
    const a = await open(withHud, "hud-on");
    const b = await open(plain, "hud-ref");
    try {
      const hud = hudOf(a.page);
      expect(hud).toBeDefined();
      // Put everything on screen: the status panel (over the header), the cursor and a labelled box.
      hud?.cuStart({ model: "muse-spark-1.3", provider: "meta", purpose: "cu_first_run" });
      hud?.cuAction({ type: "click", x: 480, y: 309 }, { x: 480, y: 309 });
      hud?.cuBlocked({ name: "Submit registration", box: { x: 163, y: 290, w: 634, h: 38 } });
      await a.page.waitForFunction((tag) => {
        const host = document.querySelector(tag);
        return !!host && host.parentElement === document.documentElement;
      }, HUD_TAG);
      await new Promise((r) => setTimeout(r, 400)); // let the panel fade in and the cursor arrive

      // Hit-testing goes through it (pointer-events: none): the panel sits over "Sign out", the box over a field.
      for (const [x, y] of [
        [1110, 29],
        [480, 309],
      ] as const) {
        const onHud = await describeAt(a.page, x, y);
        const ref = await describeAt(b.page, x, y);
        expect(onHud.fingerprint.name).toBe(ref.fingerprint.name);
        expect(onHud.candidates).toEqual(ref.candidates);
      }
      expect(await formSnapshot(a.page)).toEqual(await formSnapshot(b.page));
      const names = async (l: Lease) => (await listInteractive(l.page)).map((e) => e.descriptor.name);
      expect(await names(a)).toEqual(await names(b));
      // Not in the page text, not reachable by Playwright selectors (closed shadow root outside <body>).
      // biome-ignore lint/performance/useDomNodeTextContent: rendered text on purpose (what pageText() reads).
      expect(await a.page.evaluate(() => document.body.innerText)).not.toContain("Dockhand");
      expect(await a.page.getByText("Dockhand").count()).toBe(0);
      expect(await a.page.getByText("Computer use").count()).toBe(0);
      expect(await a.page.evaluate(() => Object.keys(window).includes("__dockhandHud"))).toBe(false);

      // Screenshots leave it out: same pixels as the page without a HUD.
      await a.page.mouse.move(0, 0);
      await b.page.mouse.move(0, 0);
      const shotA = await a.page.screenshot({
        type: "png",
        scale: "css",
        animations: "disabled",
        caret: "hide",
      });
      const shotB = await b.page.screenshot({
        type: "png",
        scale: "css",
        animations: "disabled",
        caret: "hide",
      });
      expect(Buffer.compare(shotA, shotB)).toBe(0);
      // ...while the camera (a raw capture) does see it.
      const cdp = await a.page.context().newCDPSession(a.page);
      const raw = Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64");
      expect(Buffer.compare(raw, shotA)).not.toBe(0);
      await cdp.detach();
    } finally {
      await a.release();
      await b.release();
    }
  });

  it("ends a replay with its own time and spend, next to computer use's measured mean where there is one", async () => {
    const lease = await open(withHud, "hud-end");
    try {
      const hud = hudOf(lease.page) as Hud;
      const view = () => (hud as unknown as { compose(): { ticker: string } }).compose();
      const skill = (portalId: string) =>
        ({ title: "Register a deal", version: 1, portalId, steps: [] }) as unknown as Skill;
      hud.runStart({ skill: skill("caravela") });
      await hud.end({ outcome: "success" });
      expect(view().ticker).toMatch(
        /^This run: \d+\.\d s, \$0 in model calls · computer use, measured mean: 145 s, \$0\.11$/,
      );
      hud.runStart({ skill: skill("supplier") });
      await hud.end({ outcome: "success" });
      expect(view().ticker).toMatch(/^This run: \d+\.\d s, \$0 in model calls$/);
      // Filmed: the result stays on screen before the page closes, and that wait is not part of the run's time.
      const filmed = new Hud(lease.page, { endHoldMs: 300 });
      filmed.runStart({ skill: skill("caravela") });
      const t0 = performance.now();
      await filmed.end({ outcome: "success" });
      expect(performance.now() - t0).toBeGreaterThanOrEqual(290);
      expect(filmed.pausedSince(t0)).toBeGreaterThanOrEqual(290);
    } finally {
      await lease.release();
    }
  });

  it("names models honestly", () => {
    expect(modelLabel("muse-spark-1.3", "meta")).toBe("Muse Spark 1.3");
    expect(modelLabel("muse-spark-1.3-contributor", "meta")).toBe("Muse Spark 1.3");
    expect(modelLabel("meta-models/muse-spark-open-1026", "baseten")).toBe("Muse Spark Open");
    expect(modelLabel("muse-wonder-1.0", "cassette")).toBe("Muse Wonder 1.0 (cassette)");
    expect(modelLabel("scripted-cu_first_run", "scripted")).toBe("scripted model");
  });
});

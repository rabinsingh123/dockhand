import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CuTurn } from "@dockhand/core";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CTX, cannedModel, cuInput, recordingHooks } from "./cu/cu-test-kit.ts";
import { runComputerUse } from "./cu/loop.ts";
import { pngSize } from "./png.ts";
import { createBrowserPool, type DockhandBrowserPool, launchArgs } from "./pool.ts";
import { renderHtml } from "./render.ts";
import { FIXTURE_ORIGIN, fixtureContext, launchTestBrowser } from "./test-support.ts";

const TARGETS = `<!doctype html><body style="margin:0">
  <button id=a style="position:absolute;left:100px;top:100px;width:40px;height:30px">A</button>
  <button id=b style="position:absolute;left:1200px;top:740px;width:60px;height:40px">B</button>
  <output id=log></output>
  <script>document.addEventListener('click', e => { log.textContent += e.target.id + '@' + e.clientX + ',' + e.clientY + ';'; });</script>
</body>`;

let pool: DockhandBrowserPool;
let stateDir: string;

beforeAll(() => {
  stateDir = mkdtempSync(join(tmpdir(), "dockhand-pool-"));
  pool = createBrowserPool({ headless: true, maxContexts: 2, storageStateDir: stateDir });
});
afterAll(async () => {
  await pool?.closeAll();
});

async function serve(page: Page, html: string) {
  await page
    .context()
    .route(`${FIXTURE_ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(`${FIXTURE_ORIGIN}/`);
}

describe("createBrowserPool", () => {
  it("leases a fresh context with the fixed geometry, time zone, reduced motion and capture script", async () => {
    const lease = await pool.lease({ portalId: "fixture", runId: "r1", ttlMs: 60_000 });
    try {
      await serve(lease.page, "<!doctype html><p>hello</p>");
      const env = await lease.page.evaluate(() => ({
        w: innerWidth,
        h: innerHeight,
        dpr: devicePixelRatio,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
        dh: typeof window.__dh?.describeAt,
      }));
      expect(env).toEqual({
        w: 1280,
        h: 800,
        dpr: 1,
        tz: "America/Sao_Paulo",
        reduced: true,
        dh: "function",
      });
      expect(lease.expiresAt).toBeGreaterThan(Date.now());
    } finally {
      await lease.release();
    }
    expect(pool.openContexts()).toBe(0);
  });

  it("applies cookies and reloads saved storage state for the portal", async () => {
    const cookie = { name: "nw_session_1", value: "abc", domain: "127.0.0.1", path: "/" };
    const lease = await pool.lease({ portalId: "caravela", runId: "r2", cookies: [cookie], ttlMs: 60_000 });
    expect((await lease.page.context().cookies()).map((c) => c.name)).toEqual(["nw_session_1"]);
    await pool.saveStorageState("caravela", lease.page);
    await lease.release();
    const again = await pool.lease({ portalId: "caravela", runId: "r3", ttlMs: 60_000 });
    expect((await again.page.context().cookies()).map((c) => c.value)).toEqual(["abc"]);
    await again.release();
  });

  it("closes the context of an expired lease and frees its slot; extend() pushes expiry out", async () => {
    const kept = await pool.lease({ portalId: "fixture", runId: "kept", ttlMs: 100 });
    kept.extend(60_000);
    const short = await pool.lease({ portalId: "fixture", runId: "short", ttlMs: 100 });
    await short.page.waitForEvent("close", { timeout: 5000 });
    await expect.poll(() => pool.openContexts()).toBe(1);
    expect(kept.page.isClosed()).toBe(false);
    await short.release(); // releasing an expired lease is a no-op
    await kept.release();
    expect(pool.openContexts()).toBe(0);
  });

  it("queues leases beyond maxContexts until one is released", async () => {
    const small = createBrowserPool({ headless: true, maxContexts: 1, storageStateDir: stateDir });
    try {
      const first = await small.lease({ portalId: "fixture", runId: "q1", ttlMs: 60_000 });
      let secondReady = false;
      const second = small.lease({ portalId: "fixture", runId: "q2", ttlMs: 60_000 }).then((l) => {
        secondReady = true;
        return l;
      });
      await expect.poll(() => small.waiting()).toBe(1);
      expect(secondReady).toBe(false);
      await first.release();
      const lease2 = await second;
      expect(small.openContexts()).toBe(1);
      const third = small.lease({ portalId: "fixture", runId: "q3", ttlMs: 60_000 });
      await expect.poll(() => small.waiting()).toBe(1);
      const rejected = expect(third).rejects.toThrow(/closed/);
      await small.closeAll();
      await rejected;
      expect(lease2.page.isClosed()).toBe(true);
    } finally {
      await small.closeAll();
    }
  });

  it("renders HTML to a PNG of the requested width in the shared browser", async () => {
    const html = `<!doctype html><body style="margin:0;font-family:system-ui"><h1>Receipt NW-REG-48213</h1>
      <div style="height:1500px;background:linear-gradient(#fff,#eef)"></div></body>`;
    const png = await pool.renderHtml(html, { w: 1280, h: 720 });
    expect(pngSize(png)).toEqual({ width: 1280, height: 720 });
    const full = await renderHtml(html, { w: 1280, h: 720 }, { fullPage: true });
    expect(pngSize(full).width).toBe(1280);
    expect(pngSize(full).height).toBeGreaterThan(1500);
    expect(pngSize(await renderHtml(html, { w: 1280, h: 720 }, { pool }))).toEqual({
      width: 1280,
      height: 720,
    });
  });
});

describe("coordinates", () => {
  const clickTurns = (pts: { x: number; y: number }[]): CuTurn[][] =>
    pts.map((p, i) => [
      { kind: "computer_call", callId: `c${i}`, safetyChecks: [], actions: [{ type: "click", ...p }] },
    ]);

  it("sends 1280x800 screenshots and lands clicks on CSS pixels in a pooled context", async () => {
    const lease = await pool.lease({ portalId: "fixture", runId: "coords", ttlMs: 60_000 });
    try {
      await serve(lease.page, TARGETS);
      const model = cannedModel(
        clickTurns([
          { x: 120, y: 115 },
          { x: 1230, y: 760 },
        ]),
      );
      const r = await runComputerUse(model, cuInput(lease.page), recordingHooks(), CTX);
      const start = model.replies[0];
      expect(start?.kind === "start" && pngSize(start.screenshot)).toEqual({ width: 1280, height: 800 });
      expect(await lease.page.locator("#log").textContent()).toBe("a@120,115;b@1230,760;");
      expect(r.trace.steps.map((s) => s.target?.fingerprint.name)).toEqual(["A", "B"]);
    } finally {
      await lease.release();
    }
  });

  it("keeps screenshots at 1280x800 CSS pixels even at device scale factor 1.5", async () => {
    const browser = await launchTestBrowser();
    try {
      const { page } = await fixtureContext(browser, { "/": TARGETS }, { deviceScaleFactor: 1.5 });
      await page.goto(`${FIXTURE_ORIGIN}/`);
      expect(pngSize(new Uint8Array(await page.screenshot()))).toEqual({ width: 1920, height: 1200 }); // the trap
      const model = cannedModel(clickTurns([{ x: 120, y: 115 }]));
      await runComputerUse(model, cuInput(page), recordingHooks(), CTX);
      for (const reply of model.replies) {
        if (reply.kind === "start" || reply.kind === "computer_output") {
          expect(pngSize(reply.screenshot)).toEqual({ width: 1280, height: 800 });
        }
      }
      expect(await page.locator("#log").textContent()).toBe("a@120,115;");
    } finally {
      await browser.close();
    }
  });

  it("fails fast on a page whose viewport is not 1280x800", async () => {
    const lease = await pool.lease({ portalId: "fixture", runId: "vp", ttlMs: 60_000 });
    try {
      await lease.page.setViewportSize({ width: 1024, height: 768 });
      const r = await runComputerUse(cannedModel([]), cuInput(lease.page), recordingHooks(), CTX);
      expect(r.outcome).toBe("failed");
      expect(r.message).toMatch(/viewport is 1024x768/);
    } finally {
      await lease.release();
    }
  });
});

describe("launch and shutdown", () => {
  it("hides scrollbars and pins pointer media features when headed", () => {
    expect(launchArgs(true)).toEqual([]);
    expect(launchArgs(false)).toContain("--hide-scrollbars");
    expect(launchArgs(false).some((a) => a.startsWith("--blink-settings=primaryHoverType=2"))).toBe(true);
  });
});

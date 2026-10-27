// Shared test fixtures for this package's vitest files (not exported from index.ts).

import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { DH_SCRIPT } from "./dom/script.ts";

export const FIXTURE_ORIGIN = "http://portal.test";

export function launchTestBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true });
}

export interface FixtureServer {
  /** Requests that reached the fake server (after any route guards). */
  hits: { method: string; url: string; body: string | null }[];
}

/**
 * A context like the pool's (1280x800, DSF 1, capture script) serving `pages` at http://portal.test/<path>.
 * POSTs to /api/* get `{ ok: true }` and are logged in `server.hits`.
 */
export async function fixtureContext(
  browser: Browser,
  pages: Record<string, string>,
  opts: { deviceScaleFactor?: number } = {},
): Promise<{ context: BrowserContext; page: Page; server: FixtureServer }> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: opts.deviceScaleFactor ?? 1,
    reducedMotion: "reduce",
  });
  await context.addInitScript({ content: DH_SCRIPT });
  const server: FixtureServer = { hits: [] };
  await context.route(`${FIXTURE_ORIGIN}/**`, async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path.startsWith("/api/")) {
      server.hits.push({ method: req.method(), url: req.url(), body: req.postData() });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, path }),
      });
    }
    const html = pages[path];
    if (html === undefined)
      return route.fulfill({ status: 404, contentType: "text/html", body: "<h1>Not found</h1>" });
    return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html });
  });
  const page = await context.newPage();
  return { context, page, server };
}

/** Centre of a locator's box, rounded like a model's coordinates. */
export async function centreOf(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

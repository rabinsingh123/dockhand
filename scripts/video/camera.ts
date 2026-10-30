// The camera: a separate headless browser that films the recorder's close-up views (the compiled program typing
// itself in, the open-weights pick) at device scale factor 2, so text stays sharp at 1080p. Computer use never
// touches these pages; their own animations play, and the camera scrolls like a person would (eased, held).

import { type Browser, chromium, type Page } from "playwright";
import { startScreencast } from "../../packages/browser/src/index.ts";

export interface Filmed {
  label: string;
  url: string;
  folder: string;
  startedAt: number | null;
  endedAt: number | null;
}

export interface Camera {
  film(o: { url: string; view: "code" | "pick"; label: string; dir: string }): Promise<Filmed>;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls `read` until it stops changing for `stableMs` (or `maxMs` passes). */
async function settle(page: Page, read: () => unknown, stableMs: number, maxMs: number): Promise<void> {
  const end = Date.now() + maxMs;
  let last = "";
  let since = Date.now();
  while (Date.now() < end) {
    const now = JSON.stringify(await page.evaluate(read).catch(() => null));
    if (now !== last) {
      last = now;
      since = Date.now();
    } else if (Date.now() - since >= stableMs) return;
    await sleep(250);
  }
}

/** Eased scroll of `selector` (or the page) to `to` px ("end": the bottom) over `ms`. */
async function glide(page: Page, selector: string | null, to: number | "end", ms: number): Promise<void> {
  await page
    .evaluate(
      ([sel, target, dur]) =>
        new Promise<void>((resolve) => {
          const el = (sel ? document.querySelector(sel) : document.scrollingElement) as HTMLElement | null;
          if (!el) return resolve();
          const from = el.scrollTop;
          const goal = target === "end" ? el.scrollHeight - el.clientHeight : (target as number);
          const t0 = performance.now();
          const ease = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);
          const step = (t: number) => {
            const k = Math.min(1, (t - t0) / (dur as number));
            el.scrollTop = from + (goal - from) * ease(k);
            if (k < 1) requestAnimationFrame(step);
            else resolve();
          };
          requestAnimationFrame(step);
        }),
      [selector, to, ms] as const,
    )
    .catch(() => {});
}

/** Scroll position that centers `selector`'s first match in the window. */
async function centerOf(page: Page, selector: string): Promise<number | null> {
  return page
    .evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return Math.max(0, window.scrollY + r.top - (window.innerHeight - r.height) / 2);
    }, selector)
    .catch(() => null);
}

async function codeShot(page: Page): Promise<void> {
  // Restart the typing so the clip has it from the first line (the page began typing on load).
  await page
    .locator("#again")
    .click({ timeout: 3000 })
    .catch(() => {});
  await settle(
    page,
    () =>
      `${document.querySelectorAll("#ed .ln").length}:${document.querySelector("#ed .ln.typing") ? 1 : 0}`,
    1500,
    120_000,
  );
  await sleep(1200);
  const height = await page.evaluate(() => document.getElementById("ed")?.scrollHeight ?? 0).catch(() => 0);
  await glide(page, "#ed", 0, 1600);
  await sleep(2200);
  await glide(page, "#ed", "end", Math.min(9000, Math.max(2500, height * 2.2)));
  await sleep(2500);
}

async function pickShot(page: Page): Promise<void> {
  await sleep(1800);
  const picked = await centerOf(page, ".plist li.picked");
  if (picked !== null) {
    await glide(page, null, picked, 1500);
    await sleep(3200);
  }
  const verdict = await centerOf(page, ".verdict");
  if (verdict !== null) {
    await glide(page, null, verdict, 1500);
    await sleep(2800);
  }
}

export async function openCamera(): Promise<Camera> {
  let browser: Browser | null = null;
  return {
    async film(o) {
      browser ??= await chromium.launch({ headless: true });
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 2,
      });
      const page = await context.newPage();
      try {
        await page.goto(o.url, { waitUntil: "load" });
        const cap = await startScreencast(page, {
          dir: o.dir,
          label: o.label,
          maxWidth: 2560,
          maxHeight: 1440,
          meta: { url: o.url, view: o.view },
        });
        if (o.view === "code") await codeShot(page);
        else await pickShot(page);
        const info = await cap.stop();
        return {
          label: o.label,
          url: o.url,
          folder: cap.folder,
          startedAt: info.startedAt,
          endedAt: info.endedAt,
        };
      } finally {
        await context.close().catch(() => {});
      }
    },
    async close() {
      await browser?.close().catch(() => {});
    },
  };
}

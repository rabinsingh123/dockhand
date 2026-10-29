// HTML -> PNG (receipts, skill cards, charts).

import { type Browser, chromium } from "playwright";

export interface RenderOptions {
  /** Capture the full document height instead of exactly `size.h`. */
  fullPage?: boolean;
  /** Device pixels per CSS pixel (default 1). Phone cards use 2 for a crisp 1080 px wide image. */
  scale?: number;
  /** Render in this browser (the pool's shared one); otherwise a headless browser is launched for the call. */
  pool?: {
    renderHtml(
      html: string,
      size: { w: number; h: number },
      opts?: { fullPage?: boolean; scale?: number },
    ): Promise<Uint8Array>;
  };
}

/** Renders in an existing browser: fresh context, CSS-pixel PNG of exactly w x h (or the full page height). */
export async function renderHtmlWith(
  browser: Browser,
  html: string,
  size: { w: number; h: number },
  opts: { fullPage?: boolean; scale?: number } = {},
): Promise<Uint8Array> {
  const context = await browser.newContext({
    viewport: { width: size.w, height: size.h },
    deviceScaleFactor: opts.scale ?? 1,
    reducedMotion: "reduce",
    colorScheme: "light",
    javaScriptEnabled: true,
  });
  try {
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "load", timeout: 15_000 });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const png = await page.screenshot({
      type: "png",
      scale: opts.scale && opts.scale !== 1 ? "device" : "css",
      fullPage: opts.fullPage ?? false,
      animations: "disabled",
    });
    return new Uint8Array(png);
  } finally {
    await context.close();
  }
}

/** Renders HTML to PNG bytes, in the pool's shared browser when one is given. */
export async function renderHtml(
  html: string,
  size: { w: number; h: number },
  opts: RenderOptions = {},
): Promise<Uint8Array> {
  if (opts.pool) {
    return opts.pool.renderHtml(html, size, {
      ...(opts.fullPage !== undefined ? { fullPage: opts.fullPage } : {}),
      ...(opts.scale !== undefined ? { scale: opts.scale } : {}),
    });
  }
  const browser = await chromium.launch({ headless: true });
  try {
    return await renderHtmlWith(browser, html, size, opts);
  } finally {
    await browser.close();
  }
}

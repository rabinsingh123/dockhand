// Playwright rendering for fixtures: HTML -> PNG / JPEG / PDF, with the PDF timestamps pinned so the
// same input always produces the same bytes.

import type { Browser, Page } from "playwright";

async function openHtml(
  browser: Browser,
  html: string,
  viewport: { width: number; height: number },
  deviceScaleFactor = 1,
): Promise<Page> {
  const page = await browser.newPage({
    viewport,
    deviceScaleFactor,
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      Array.from(document.images).map((img) =>
        img.complete ? Promise.resolve() : img.decode().catch(() => {}),
      ),
    );
  });
  return page;
}

/**
 * Fixed-size pages (`.paper`, `.page`) clip their content; a layout change that pushes content past
 * the bottom would silently cut it off, so treat any overflow as an error.
 */
async function assertFits(page: Page, selector: string): Promise<void> {
  const overflow = await page.evaluate((sel) => {
    return Array.from(document.querySelectorAll<HTMLElement>(sel)).map(
      (el) => el.scrollHeight - el.clientHeight,
    );
  }, selector);
  const worst = Math.max(0, ...overflow);
  if (worst > 1) throw new Error(`${selector} overflows by ${worst}px; tighten the layout`);
}

export async function htmlToPng(
  browser: Browser,
  html: string,
  viewport: { width: number; height: number },
  opts: { deviceScaleFactor?: number; fit?: string } = {},
): Promise<Buffer> {
  const page = await openHtml(browser, html, viewport, opts.deviceScaleFactor);
  try {
    if (opts.fit) await assertFits(page, opts.fit);
    return await page.screenshot({ type: "png", animations: "disabled" });
  } finally {
    await page.close();
  }
}

export async function htmlToJpeg(
  browser: Browser,
  html: string,
  viewport: { width: number; height: number },
  quality: number,
): Promise<Buffer> {
  const page = await openHtml(browser, html, viewport);
  try {
    return await page.screenshot({ type: "jpeg", quality, animations: "disabled" });
  } finally {
    await page.close();
  }
}

/** The page sets its own size with `@page`; margins live in the HTML. `.page` must not overflow. */
export async function htmlToPdf(browser: Browser, html: string): Promise<Buffer> {
  const page = await openHtml(browser, html, { width: 1000, height: 1300 });
  try {
    await assertFits(page, ".page");
    const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true });
    return pinPdfDates(pdf);
  } finally {
    await page.close();
  }
}

const PINNED_DIGITS = "20261020120000000000";

/**
 * Chromium stamps /CreationDate and /ModDate with the wall clock. Rewriting only the digits keeps every
 * byte offset (the xref table stays valid) and makes repeated runs byte-identical.
 */
export function pinPdfDates(pdf: Buffer): Buffer {
  const text = pdf.toString("latin1");
  const pinned = text.replace(
    /\/(CreationDate|ModDate)\s*\((D:[^)]*)\)/g,
    (match, _key: string, date: string) => {
      let i = 0;
      const fixed = date.replace(/\d/g, () => PINNED_DIGITS[i++] ?? "0");
      return match.replace(date, fixed);
    },
  );
  if (pinned.length !== text.length) throw new Error("PDF date pinning changed the file length");
  return Buffer.from(pinned, "latin1");
}

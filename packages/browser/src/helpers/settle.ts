// Has the page settled? No tracked request in flight or just finished, no DOM change, no busy indicator.
// Replay uses it to stop waiting for a target that is not coming (a renamed or moved control): once the page
// is settled, about a second is enough to know, instead of the whole step timeout.

import type { Page, Request } from "playwright";
import { ensureDh } from "../dom/script.ts";

const TRACKED = new Set(["document", "fetch", "xhr", "script"]);
const KEY = Symbol.for("dockhand.settle");

/** A page settled this long counts as settled (network and DOM both quiet). */
export const SETTLE_QUIET_MS = 500;
/** A target that is missing on a settled page is given up after this long. */
export const SETTLED_MISS_MS = 1000;

interface NetworkTracker {
  inflight: Set<Request>;
  lastActivity: number;
}

/**
 * Starts counting the page's in-flight requests (document, fetch, xhr, script). The pool calls it on every
 * leased page; resolveTarget calls it lazily for pages from elsewhere. Idempotent.
 */
export function trackNetwork(page: Page): void {
  const holder = page as unknown as Record<symbol, NetworkTracker | undefined>;
  if (holder[KEY]) return;
  const t: NetworkTracker = { inflight: new Set(), lastActivity: 0 };
  holder[KEY] = t;
  page.on("request", (r) => {
    if (!TRACKED.has(r.resourceType())) return;
    t.inflight.add(r);
    t.lastActivity = Date.now();
  });
  const done = (r: Request) => {
    if (t.inflight.delete(r)) t.lastActivity = Date.now();
  };
  page.on("requestfinished", done);
  page.on("requestfailed", done);
}

/** True when nothing is loading and nothing changed for SETTLE_QUIET_MS. */
export async function isSettled(page: Page): Promise<boolean> {
  trackNetwork(page);
  const t = (page as unknown as Record<symbol, NetworkTracker | undefined>)[KEY] as NetworkTracker;
  if (t.inflight.size > 0 || Date.now() - t.lastActivity < SETTLE_QUIET_MS) return false;
  await ensureDh(page).catch(() => undefined);
  const s = await page
    .evaluate(() => (window.__dh as unknown as { settle?: () => SettleState }).settle?.() ?? null)
    .catch(() => null);
  return !!s && s.ready && !s.busy && s.domQuietMs >= SETTLE_QUIET_MS;
}

interface SettleState {
  domQuietMs: number;
  busy: boolean;
  ready: boolean;
}

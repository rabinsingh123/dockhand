// Network backstop for the commit gate: mutating requests to the portal origins are held until a token exists,
// and writes or main-frame navigations to any other origin are aborted outright.

import type { ForeignRequest, WriteGuardConfig } from "@dockhand/core";
import type { Page, Request, Route } from "playwright";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface WriteGuard {
  /** Adds approval tokens; each releases one held (or future) write. */
  grant(n?: number): void;
  /** Writes currently held. */
  pending(): number;
  /** Removes the route; held writes are aborted. */
  dispose(): Promise<void>;
  /** Unused tokens. */
  tokens(): number;
  /** Drops every unused token (an approval is for one page and one submit); returns how many. */
  revoke(): number;
  /** Writes let through by a token so far. */
  released(): number;
  /** Writes and main-frame navigations to other origins aborted so far (never held, never released). */
  foreign(): ForeignRequest[];
}

interface Held {
  route: Route;
  done: boolean;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * `pattern` names exactly the URL's path: same segments, where `*` stands for one segment
 * (the supplier start path is the tenant and invite code segments as stars). The query string is ignored; a
 * substring or prefix never matches.
 */
export function pathMatches(pattern: string, url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  const want = pattern.split("/");
  const got = path.split("/");
  return want.length === got.length && want.every((seg, i) => (seg === "*" ? got[i] !== "" : seg === got[i]));
}

function isMainFrameNavigation(req: Request, page: Page): boolean {
  try {
    return req.isNavigationRequest() && req.frame() === page.mainFrame();
  } catch {
    return false; // service-worker requests have no frame
  }
}

/**
 * Holds POST/PUT/PATCH/DELETE to `cfg.origins` (paths matching a `cfg.allow` pattern exactly pass) until a token is
 * granted. A held write is also reported to `onWrite`: "allow" lets it through without a token, "block" aborts
 * it; whichever of grant / onWrite comes first decides.
 *
 * A write or main-frame navigation to any other http(s) origin (unless it is in `cfg.allowOrigins`) is aborted
 * at once and reported to `onForeign`: no token or `onWrite` answer can release it, so an approval never
 * covers data leaving the portal. Reads (images, scripts, fonts) from other origins pass. A server-side
 * redirect from the portal is not routed by Playwright; writes from the page it lands on are still aborted.
 */
export async function installWriteGuard(
  page: Page,
  cfg: WriteGuardConfig,
  onWrite: (req: { method: string; url: string }) => Promise<"allow" | "block">,
  onForeign?: (req: ForeignRequest) => void,
): Promise<WriteGuard> {
  const origins = new Set(cfg.origins.map(originOf).filter((o): o is string => o !== null));
  const trusted = new Set([
    ...origins,
    ...(cfg.allowOrigins ?? []).map(originOf).filter((o): o is string => o !== null),
  ]);
  const held: Held[] = [];
  const foreign: ForeignRequest[] = [];
  let tokens = 0;
  let released = 0;

  const settle = (h: Held, how: "continue" | "abort") => {
    if (h.done) return;
    h.done = true;
    const i = held.indexOf(h);
    if (i >= 0) held.splice(i, 1);
    // Fallback (not continue) so later-registered handlers, such as an idempotency-key injector, still run.
    const p = how === "continue" ? h.route.fallback() : h.route.abort("blockedbyclient");
    p.catch(() => {});
  };

  const matches = (url: URL) => origins.has(url.origin);
  const handler = async (route: Route) => {
    const req = route.request();
    const method = req.method().toUpperCase();
    const url = req.url();
    if (!WRITE_METHODS.has(method) || cfg.allow.some((p) => pathMatches(p, url))) return route.fallback();
    if (tokens > 0) {
      tokens--;
      released++;
      return route.fallback();
    }
    const h: Held = { route, done: false };
    held.push(h);
    // Not awaited: Playwright waits for the handler to return as well as for fallback()/abort(), so a handler
    // parked on the decision would keep a later grant() from releasing the request.
    onWrite({ method, url }).then(
      (decision) => settle(h, decision === "allow" ? "continue" : "abort"),
      () => settle(h, "abort"),
    );
  };

  const isForeign = (url: URL) =>
    (url.protocol === "http:" || url.protocol === "https:") && !trusted.has(url.origin);
  const foreignHandler = async (route: Route) => {
    const req = route.request();
    const method = req.method().toUpperCase();
    const navigation = isMainFrameNavigation(req, page);
    if (!WRITE_METHODS.has(method) && !navigation) return route.fallback();
    const r: ForeignRequest = { method, url: req.url(), navigation };
    foreign.push(r);
    try {
      onForeign?.(r);
    } finally {
      // "aborted" cancels a navigation without an error page: the page and its filled form stay as they were
      // (any other code, and a 204, leave Chromium on chrome-error:// or Playwright waiting for the navigation).
      await route.abort(navigation ? "aborted" : "blockedbyclient").catch(() => {});
    }
  };

  await page.route(matches, handler);
  await page.route(isForeign, foreignHandler);
  return {
    grant(n = 1) {
      tokens += n;
      while (tokens > 0 && held.length > 0) {
        tokens--;
        released++;
        settle(held[0] as Held, "continue");
      }
    },
    pending: () => held.length,
    tokens: () => tokens,
    revoke() {
      const n = tokens;
      tokens = 0;
      return n;
    },
    released: () => released,
    foreign: () => [...foreign],
    async dispose() {
      await page.unroute(matches, handler).catch(() => {});
      await page.unroute(isForeign, foreignHandler).catch(() => {});
      for (const h of [...held]) settle(h, "abort");
    },
  };
}

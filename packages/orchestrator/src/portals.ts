// The portals Dockhand works on. The orchestrator never imports @dockhand/portals: the wiring point
// passes each portal's origin and a function that mints session cookies for one browser context.

import type { CookieSpec, WriteGuardConfig } from "@dockhand/core";

export const CARAVELA = "caravela";
export const SUPPLIER = "supplier";

/** Plain data about a portal (what buildPlan needs). */
export interface PortalInfo {
  id: string;
  name: string;
  /** Origin, e.g. http://127.0.0.1:5101 (no trailing slash). */
  url: string;
  /** Where a first run starts when the teach draft gives no usable URL. May hold {{tenant}}-style params. */
  startPath: string;
}

export interface PortalTarget extends PortalInfo {
  /** Cookies for a fresh browser context: signed in, following the portal defaults, tagged with runId. */
  session(o: { runId: string }): Promise<CookieSpec[]>;
  /** URL substrings the write guard always lets through (sign-in, starting an invite). */
  writeGuardAllow: string[];
}

export type PortalDirectory = Record<string, PortalTarget>;

export const PORTAL_DEFAULTS: Record<string, Omit<PortalInfo, "url">> = {
  [CARAVELA]: { id: CARAVELA, name: "Caravela Partner Hub", startPath: "/deals/new" },
  [SUPPLIER]: { id: SUPPLIER, name: "Supplier Portal", startPath: "/t/{{tenant}}/invite/{{invite_code}}" },
};

export const WRITE_GUARD_ALLOW: Record<string, string[]> = {
  [CARAVELA]: ["/api/login", "/api/logout", "/api/__config"],
  // Starting an invite is navigation, not a submission.
  [SUPPLIER]: ["/api/login", "/api/logout", "/api/__config", "/start"],
};

export function writeGuardFor(portal: Pick<PortalTarget, "url" | "writeGuardAllow">): WriteGuardConfig {
  return { origins: [new URL(portal.url).origin], allow: portal.writeGuardAllow };
}

/** The portal's origin plus the path (and query) of `url`; the default start path when `url` is unusable. */
export function startUrlFor(
  portal: PortalInfo,
  url: string | undefined,
  params: Record<string, unknown> = {},
): string {
  let path = portal.startPath;
  if (url) {
    try {
      const parsed = new URL(url, portal.url);
      if (parsed.pathname && parsed.pathname !== "/") path = `${parsed.pathname}${parsed.search}`;
    } catch {
      // keep the default
    }
  }
  const filled = path.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g, (whole, name: string) => {
    const v = params[name];
    return typeof v === "string" || typeof v === "number" ? encodeURIComponent(String(v)) : whole;
  });
  return `${portal.url.replace(/\/+$/, "")}${filled}`;
}

/** Tenant and invite code from an invite URL like http://host/t/acme/invite/ACME-7731. */
export function parseInviteUrl(
  url: string | null | undefined,
): { tenant: string; inviteCode: string } | null {
  if (!url) return null;
  const m = /\/t\/([a-z0-9-]+)\/invite\/([A-Za-z0-9-]+)/i.exec(url);
  return m?.[1] && m[2] ? { tenant: m[1].toLowerCase(), inviteCode: m[2].toUpperCase() } : null;
}

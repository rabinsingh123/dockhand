// The portals Dockhand works on. The orchestrator never imports @dockhand/portals: the wiring point
// passes each portal's origin and a function that mints session cookies for one browser context.

import type { CookieSpec, Lease, WriteGuardConfig } from "@dockhand/core";
import { pngPixel, type ShotCrop } from "./tools/phone-cards.ts";

export const CARAVELA = "caravela";
export const SUPPLIER = "supplier";
/** EspoCRM, the real third-party app (apps/oss/espocrm). Configured only when ESPOCRM_URL is set. */
export const ESPOCRM = "espocrm";

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
  /** Paths the write guard always lets through, matched exactly (`*` = one segment): sign-in, starting an invite. */
  writeGuardAllow: string[];
  /**
   * Other origins a run may navigate to and write to, such as a same-site sign-in origin. Empty by default:
   * every other origin is aborted by the write guard.
   */
  writeGuardAllowOrigins?: string[];
  /** Names of the control that submits, for a first run no teach draft names it for (EspoCRM: "Save"). */
  commitHints?: string[];
  /** Runs on every leased page before its first navigation (EspoCRM keeps its sign-in in localStorage). */
  prepare?(page: Lease["page"]): Promise<void>;
}

export type PortalDirectory = Record<string, PortalTarget>;

export const PORTAL_DEFAULTS: Record<string, Omit<PortalInfo, "url">> = {
  [CARAVELA]: { id: CARAVELA, name: "Caravela Partner Hub", startPath: "/deals/new" },
  [SUPPLIER]: { id: SUPPLIER, name: "Supplier Portal", startPath: "/t/{{tenant}}/invite/{{invite_code}}" },
};

/** What a finished run did on each portal, as the receipt card's status line over the record ID. */
export const RECEIPT_DONE: Record<string, string> = {
  [CARAVELA]: "Deal registered",
  [SUPPLIER]: "Registration submitted",
  [ESPOCRM]: "Lead created",
};

/**
 * The portal's own confirmation panel, as the receipt card crops it from the final screenshot (CSS px of the
 * 1280 x 800 page, drawn at 0.7): Caravela's "Registration received" panel, the supplier portal's "Registration
 * submitted" and its ID box, and the head of EspoCRM's lead record. Caravela's first UI has a dark top bar and the
 * panel at x 132; its later UIs (the self-heal and drift demos) have a sidebar and the panel at x 260.
 */
export const RECEIPT_CROP: Record<string, (shot: Uint8Array) => ShotCrop | undefined> = {
  [CARAVELA]: (shot) => {
    const bar = pngPixel(shot, 640, 20);
    if (!bar) return undefined;
    return bar[0] + bar[1] + bar[2] < 240
      ? { x: 116, y: 100, scale: 0.7, height: 148 }
      : { x: 252, y: 104, scale: 0.7, height: 148 };
  },
  [SUPPLIER]: () => ({ x: 265, y: 212, scale: 0.7, height: 176 }),
  [ESPOCRM]: () => ({ x: 56, y: 40, scale: 0.7, height: 152 }),
};

export const WRITE_GUARD_ALLOW: Record<string, string[]> = {
  [CARAVELA]: ["/api/login", "/api/logout", "/api/__config"],
  // Starting an invite is navigation, not a submission.
  [SUPPLIER]: ["/api/login", "/api/logout", "/api/__config", "/api/t/*/invite/*/start"],
};

export function writeGuardFor(
  portal: Pick<PortalTarget, "url" | "writeGuardAllow" | "writeGuardAllowOrigins">,
): WriteGuardConfig {
  return {
    origins: [new URL(portal.url).origin],
    allow: portal.writeGuardAllow,
    allowOrigins: portal.writeGuardAllowOrigins ?? [],
  };
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

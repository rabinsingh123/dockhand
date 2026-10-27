// Public API of @dockhand/portals: two mock portals used as the computer-use / replay test bed.

import type { PortalHandle } from "./server/core.ts";
import type { SessionCookie, SessionOptions } from "./shared/types.ts";

export type { PortalHandle, StartOptions } from "./server/core.ts";
export { DUPLICATE_WINDOW_MS, startPartnerPortal } from "./server/partner.ts";
export { startSupplierPortal } from "./server/supplier.ts";
export {
  type CanonicalField,
  PARTNER_FIELDS,
  PARTNER_INSERTABLE_FIELDS,
  SUPPLIER_FIELDS,
  SUPPLIER_INSERTABLE_FIELDS,
} from "./shared/catalog.ts";
export {
  createMutator,
  isMutationOperator,
  MUTATION_OPERATORS,
  type MutationOperatorInfo,
  operatorInfo,
  operatorsFor,
  resolveOperators,
} from "./shared/mutations.ts";
export {
  PARTNER_COUNTRIES,
  PARTNER_FIELD_LABELS,
  PARTNER_PORTAL_NAME,
  PARTNER_PRODUCTS,
  PARTNER_REG_ID_PREFIX,
  PARTNER_REG_ID_RE,
  PARTNER_TIERS,
} from "./shared/partnerSchema.ts";
export {
  CURRENCIES,
  DIVERSITY_OPTIONS,
  EMPLOYEE_RANGES,
  ENTITY_TYPES,
  isValidInviteCode,
  REVENUE_RANGES,
  SUPPLIER_CATEGORIES,
  SUPPLIER_COUNTRIES,
  SUPPLIER_ID_RE,
  SUPPLIER_STEPS,
  TENANTS,
  type TenantInfo,
  type TenantSlug,
} from "./shared/supplierSchema.ts";
export type {
  DealRecord,
  FieldValue,
  HealCategory,
  MutationConfig,
  MutationOperator,
  PortalConfig,
  PortalKind,
  PortalVersion,
  ResolvedMutation,
  SessionCookie,
  SessionOptions,
  Submission,
  SubmittedFile,
  SupplierRecord,
} from "./shared/types.ts";
export { MUTATION_OPERATOR_IDS } from "./shared/types.ts";
export { addDaysIso, isoToDmy, parseDate } from "./shared/validate.ts";

/**
 * Cookies for one browser context: authenticated, with ui / mutation / runId pinned.
 * Accepts a PortalHandle (direct, no HTTP) or a base URL (portal started by the CLI in another
 * process; uses POST /api/__test/session). Usage: `await context.addCookies(await portalSession(...))`.
 */
export async function portalSession(
  target: PortalHandle | string,
  opts: SessionOptions,
): Promise<SessionCookie[]> {
  if (typeof target !== "string") return target.session(opts);
  const base = target.replace(/\/+$/, "");
  const res = await fetch(`${base}/api/__test/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(opts),
  });
  if (!res.ok) throw new Error(`POST ${base}/api/__test/session returned ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { cookies: SessionCookie[] };
  return body.cookies;
}

/**
 * Authentication only: a session cookie that follows the portal defaults (version / mutation set by
 * setVersion / setMutation or the admin endpoints). Use for the live demo context.
 * Credentials never reach the agent.
 */
export async function portalAuthCookie(
  target: PortalHandle | string,
  opts: { username?: string } = {},
): Promise<SessionCookie> {
  const base = typeof target === "string" ? target.replace(/\/+$/, "") : target.url;
  const res = await fetch(`${base}/api/__test/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: opts.username ?? "ana.souza" }),
  });
  if (!res.ok) throw new Error(`POST ${base}/api/__test/session returned ${res.status}`);
  const body = (await res.json()) as { cookies: SessionCookie[] };
  const cookie = body.cookies[0];
  if (!cookie) throw new Error("session endpoint returned no cookie");
  return cookie;
}

export const partnerAuthCookie = portalAuthCookie;
export const supplierAuthCookie = portalAuthCookie;

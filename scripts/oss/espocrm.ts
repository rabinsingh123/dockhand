// Adapter for EspoCRM (AGPLv3, unmodified 10.0.11, run natively by apps/oss/espocrm/start.ps1) as a Dockhand
// target: where a run starts, how a browser context gets signed in, what counts as navigation for the write
// guard, the "create a Lead" workflow's fields, and ground truth read back through EspoCRM's own REST API.
// It plays the part apps/portals plays for the mock portals; nothing in packages/ knows about EspoCRM.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import type { ParamSpec, ParamValue, WriteGuardConfig } from "../../packages/core/src/index.ts";

export const ESPO_PORTAL_ID = "espocrm";
export const ESPO_URL = (process.env.ESPO_URL ?? "http://127.0.0.1:8090").replace(/\/+$/, "");
// Local-only instance with fictional data; same defaults as apps/oss/espocrm/env.ps1.
const ADMIN_USER = process.env.ESPO_ADMIN_USER ?? "admin";
const ADMIN_PASSWORD = process.env.ESPO_ADMIN_PASSWORD ?? "espo-local-admin";

/** The workflow: create a Lead from what a buyer sent, ending at Save (the commit control). */
export const LEAD_START_URL = `${ESPO_URL}/#Lead/create`;
export const LEAD_COMMIT = "Save";
export const LEAD_SKILL = "espocrm_create_lead";

/** Mutating requests that are not the submission (none seen: login and page loads are GETs). */
export const ESPO_WRITE_ALLOW: string[] = [];
export const espoWriteGuard: WriteGuardConfig = {
  origins: [new URL(ESPO_URL).origin],
  allow: ESPO_WRITE_ALLOW,
};

export const LEAD_STATUS = ["New", "Assigned", "In Process", "Converted", "Recycled", "Dead"] as const;
export const LEAD_SOURCE = [
  "Call",
  "Email",
  "Existing Customer",
  "Partner",
  "Public Relations",
  "Web Site",
  "Campaign",
  "Other",
] as const;

/**
 * Param name, the EspoCRM attribute it lands in, and its spec. Status and Source are Selectize dropdowns (no
 * ARIA roles, a hidden native <select> that keeps only the chosen option).
 */
export const LEAD_FIELDS: { param: string; attr: string; spec: ParamSpec }[] = [
  {
    param: "first_name",
    attr: "firstName",
    spec: { name: "first_name", type: "string", required: true, description: "Lead's first name" },
  },
  {
    param: "last_name",
    attr: "lastName",
    spec: { name: "last_name", type: "string", required: true, description: "Lead's last name" },
  },
  {
    param: "account_name",
    attr: "accountName",
    spec: { name: "account_name", type: "string", required: true, description: "Lead's company" },
  },
  {
    param: "email",
    attr: "emailAddress",
    spec: { name: "email", type: "email", required: true, description: "Lead's email" },
  },
  {
    param: "title",
    attr: "title",
    spec: { name: "title", type: "string", required: true, description: "Lead's job title" },
  },
  {
    param: "website",
    attr: "website",
    spec: { name: "website", type: "string", required: true, description: "Company website" },
  },
  {
    param: "city",
    attr: "addressCity",
    spec: { name: "city", type: "string", required: true, description: "City" },
  },
  {
    param: "country",
    attr: "addressCountry",
    spec: { name: "country", type: "string", required: true, description: "Country" },
  },
  {
    param: "opportunity_amount",
    attr: "opportunityAmount",
    spec: {
      name: "opportunity_amount",
      type: "number",
      required: true,
      description: "Opportunity amount (USD)",
    },
  },
  {
    param: "status",
    attr: "status",
    spec: {
      name: "status",
      type: "enum",
      required: true,
      description: "Lead status",
      enumValues: [...LEAD_STATUS],
    },
  },
  {
    param: "source",
    attr: "source",
    spec: {
      name: "source",
      type: "enum",
      required: true,
      description: "Lead source",
      enumValues: [...LEAD_SOURCE],
    },
  },
];

const FIRST = ["Marisol", "Tiago", "Priya", "Daniel", "Lucía", "Kenji", "Amara", "Rafael", "Ines", "Arjun"];
const LAST = [
  "Duarte",
  "Okafor",
  "Raman",
  "Vieira",
  "Halvorsen",
  "Moreau",
  "Castillo",
  "Nakamura",
  "Brandt",
  "Sethi",
];
const COMPANIES = [
  ["Lumen Agro", "lumenagro.example", "Curitiba", "Brazil"],
  ["Northwind Freight", "northwind-freight.example", "Monterrey", "Mexico"],
  ["Kestrel Foods", "kestrelfoods.example", "Pune", "India"],
  ["Bluewater Logistics", "bluewater-logistics.example", "Cebu", "Philippines"],
  ["Altiplano Energia", "altiplano-energia.example", "Medellín", "Colombia"],
] as const;
const TITLES = ["Head of Operations", "Procurement Manager", "CFO", "IT Director", "Sales Director"];

/** Deterministic fictional lead #i (the run id keeps names unique across runs). */
export function syntheticLead(i: number, tag: string): Record<string, ParamValue> {
  const pick = <T>(xs: readonly T[], k: number) => xs[(i * k + 3) % xs.length] as T;
  const [company, site, city, country] = pick(COMPANIES, 1);
  const first = pick(FIRST, 3);
  const last = `${pick(LAST, 7)}-${tag}`;
  return {
    first_name: first,
    last_name: last,
    account_name: company,
    email: `${first.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()}.${last.toLowerCase()}@${site}`,
    title: pick(TITLES, 5),
    website: site,
    city,
    country,
    opportunity_amount: 12000 + ((i * 7919) % 90) * 500,
    // Never the form's defaults (New, empty): a value equal to the default needs no step and compiles nothing.
    status: pick(["In Process", "Assigned", "Recycled"], 1),
    source: pick(["Partner", "Call", "Web Site", "Existing Customer"], 1),
  };
}

// ---------- REST API ----------

function basic(): string {
  return `Basic ${Buffer.from(`${ADMIN_USER}:${ADMIN_PASSWORD}`).toString("base64")}`;
}

/** EspoCRM REST call as the admin (the same endpoints its own admin UI calls). */
export async function espoApi<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${ESPO_URL}/api/v1/${path.replace(/^\/+/, "")}`, {
    method,
    headers: {
      Authorization: basic(),
      "Espo-Authorization": Buffer.from(`${ADMIN_USER}:${ADMIN_PASSWORD}`).toString("base64"),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`EspoCRM ${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

export async function espoUp(): Promise<boolean> {
  try {
    await espoApi("GET", "App/user");
    return true;
  } catch {
    return false;
  }
}

export interface LeadRow {
  id: string;
  createdAt: string;
  [attr: string]: unknown;
}

/** Leads created at or after `sinceMs` (EspoCRM stores UTC "YYYY-MM-DD HH:mm:ss"), oldest first. */
export async function leadsSince(sinceMs: number, extraAttrs: string[] = []): Promise<LeadRow[]> {
  const select = ["id", "createdAt", ...LEAD_FIELDS.map((f) => f.attr), ...extraAttrs].join(",");
  const q = `Lead?maxSize=50&orderBy=createdAt&order=desc&select=${encodeURIComponent(select)}`;
  const { list } = await espoApi<{ list: LeadRow[] }>("GET", q);
  const since = Math.floor(sinceMs / 1000) * 1000;
  return list.filter((l) => Date.parse(`${l.createdAt.replace(" ", "T")}Z`) >= since).reverse();
}

const norm = (v: unknown) =>
  String(v ?? "")
    .normalize("NFC")
    .trim()
    .toLowerCase();

/** Field-by-field grade of a stored Lead against the values the run was asked to write. */
export function gradeLead(
  lead: LeadRow | undefined,
  want: Record<string, ParamValue>,
  extra: Record<string, string> = {},
): { correct: number; total: number; mismatches: string[] } {
  const mismatches: string[] = [];
  const checks = [
    ...LEAD_FIELDS.map((f) => [f.attr, want[f.param]] as const),
    ...Object.entries(extra).map(([k, v]) => [k, v] as const),
  ];
  for (const [attr, w] of checks) {
    const got = lead?.[attr];
    const ok = typeof w === "number" ? Number(got) === w : norm(got) === norm(w);
    if (!ok) mismatches.push(`${attr}: got ${JSON.stringify(got)}, want ${JSON.stringify(w)}`);
  }
  return { correct: checks.length - mismatches.length, total: checks.length, mismatches };
}

// ---------- sign-in ----------

/**
 * Signs in through EspoCRM's own login page at 1280x800 and saves the storage state where the browser pool
 * looks for it (`<storageStateDir>/espocrm.json`), so every leased context starts signed in. Returns ms taken.
 */
export async function ensureEspoLogin(storageStateDir: string, o: { fresh?: boolean } = {}): Promise<number> {
  const file = join(storageStateDir, `${ESPO_PORTAL_ID}.json`);
  if (existsSync(file) && !o.fresh) return 0;
  mkdirSync(storageStateDir, { recursive: true });
  const t0 = Date.now();
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(`${ESPO_URL}/`, { waitUntil: "load" });
    await page.locator("#field-userName").fill(ADMIN_USER, { timeout: 60_000 });
    await page.locator("#field-password").fill(ADMIN_PASSWORD);
    await page.locator("#btn-login").click();
    await page.waitForFunction(
      () => !document.querySelector("#login") && !!document.querySelector("#navbar a"),
      null,
      {
        timeout: 60_000,
      },
    );
    await ctx.storageState({ path: file });
  } finally {
    await browser.close();
  }
  return Date.now() - t0;
}

/** The create form is ready: EspoCRM renders it client-side after the route loads. */
export async function waitForLeadForm(page: import("playwright").Page): Promise<void> {
  await page.locator('.record .cell[data-name="name"] input').first().waitFor({ timeout: 60_000 });
  await page.waitForLoadState("networkidle").catch(() => undefined);
}

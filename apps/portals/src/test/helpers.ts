// Shared Playwright helpers for the portal tests.

import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import type { PortalHandle, SessionOptions } from "../index.ts";
import { addDaysIso, isoToDmy } from "../shared/validate.ts";

export const VIEWPORT = { width: 1280, height: 800 };

export function launchBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true });
}

export async function openContext(
  browser: Browser,
  handle: PortalHandle,
  session?: SessionOptions,
): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await browser.newContext({ viewport: VIEWPORT, reducedMotion: "reduce" });
  if (session) await context.addCookies(await handle.session(session));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  return { context, page, errors };
}

let counter = 0;
export function newRunId(prefix: string): string {
  counter += 1;
  return `${prefix}-${process.pid}-${counter}`;
}

/** A DD/MM/YYYY date `days` after the server date. */
export function futureDmy(handle: PortalHandle, days: number): string {
  return isoToDmy(addDaysIso(handle.config().serverDate, days));
}

export function futureIso(handle: PortalHandle, days: number): string {
  return addDaysIso(handle.config().serverDate, days);
}

export async function pickOption(page: Page, combobox: string, option: string): Promise<void> {
  await page.getByRole("combobox", { name: combobox, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

export interface PartnerInput {
  companyName: string;
  companyWebsite?: string;
  country: string;
  city: string;
  contactName: string;
  contactEmail: string;
  contactPhone?: string;
  product: string;
  seats: string;
  estimatedValue?: string;
  expectedCloseDate: string;
  referralPartner?: string;
  notes?: string;
}

/** Fills the partner form by label / role only (works for v1 and v2; v2 calls Product "Solution"). */
export async function fillPartnerForm(
  page: Page,
  input: PartnerInput,
  productLabel = "Product",
): Promise<void> {
  const text = (label: string, value: string | undefined) =>
    value === undefined ? Promise.resolve() : page.getByLabel(label, { exact: true }).fill(value);
  await text("End customer company", input.companyName);
  await text("Company website", input.companyWebsite);
  await pickOption(page, "Country", input.country);
  await text("City", input.city);
  await text("Contact full name", input.contactName);
  await text("Contact email", input.contactEmail);
  await text("Contact phone", input.contactPhone);
  await pickOption(page, productLabel, input.product);
  await text("Seats", input.seats);
  await text("Estimated value (USD)", input.estimatedValue);
  await text("Expected close date", input.expectedCloseDate);
  await text("Referral partner", input.referralPartner);
  await text("Notes", input.notes);
  await page.getByLabel("The end customer agreed to be contacted by Caravela", { exact: true }).check();
}

export function samplePartner(handle: PortalHandle, overrides: Partial<PartnerInput> = {}): PartnerInput {
  return {
    companyName: "Sabiá Foods Ltda.",
    companyWebsite: "sabiafoods.com.br",
    country: "Brazil",
    city: "São Paulo",
    contactName: "Mariana Costa",
    contactEmail: "mariana.costa@sabiafoods.example",
    contactPhone: "+55 11 91234 5678",
    product: "Tidewater Cloud Business",
    seats: "25",
    estimatedValue: "18,000",
    expectedCloseDate: futureDmy(handle, 60),
    referralPartner: "Rota Digital",
    notes: "Wants a January start.",
    ...overrides,
  };
}

/** A tiny but valid single-page PDF. Different titles give different hashes. */
export function makePdf(
  dir: string,
  name: string,
  title: string,
): { path: string; sha256: string; size: number } {
  const body = [
    "%PDF-1.4",
    `% ${title}`,
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj",
    "trailer << /Root 1 0 R >>",
    "%%EOF",
    "",
  ].join("\n");
  const path = join(dir, name);
  const bytes = Buffer.from(body, "utf8");
  writeFileSync(path, bytes);
  return { path, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
}

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

/** Interactive elements without a data-testid. The v1 contract is that there are none. */
export function missingTestids(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [
      ...document.querySelectorAll(
        'a[href], button, input, textarea, select, [role="option"], [role="combobox"]',
      ),
    ]
      .filter((el) => !el.hasAttribute("data-testid"))
      .map((el) => el.outerHTML.slice(0, 160)),
  );
}

export async function rootHtml(page: Page): Promise<string> {
  return page.locator("#root").evaluate((el) => el.innerHTML);
}

// Label/role-based supplier wizard steps, shared by tests and the screenshot script. Nothing here
// depends on testids or positions, so the same steps run on every tenant layout.

import type { Page } from "playwright";
import { pickOption } from "./helpers.ts";

export interface SupplierPdfs {
  w9: string;
  coi: string;
}

const fill = (page: Page, label: string, value: string) =>
  page.getByLabel(label, { exact: true }).fill(value);

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export async function next(page: Page, tenant: string, expectedStep: string): Promise<void> {
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.waitForURL(new RegExp(`/t/${tenant}/register/${expectedStep}$`));
}

export async function startRegistration(
  page: Page,
  baseUrl: string,
  tenant: string,
  code: string,
): Promise<void> {
  await page.goto(`${baseUrl}/t/${tenant}/invite/${code}`);
  await page.getByRole("button", { name: "Start registration", exact: true }).click();
  await page.waitForURL(new RegExp(`/t/${tenant}/register/company$`));
}

export async function fillCompany(page: Page): Promise<void> {
  await fill(page, "Legal company name", "Tidewater Cloud Inc.");
  await fill(page, "Trade name (DBA)", "Tidewater Cloud");
  await fill(page, "Tax ID (EIN)", "12-3456789");
  await pickOption(page, "Country of incorporation", "United States");
  await fill(page, "State / province of incorporation", "Delaware");
  await fill(page, "Year founded", "2016");
  await fill(page, "Company website", "https://tidewater.example");
  await pickOption(page, "Number of employees", "51-200");
  await pickOption(page, "Annual revenue (USD)", "$10M-$50M");
  await page.getByRole("radio", { name: "LLC", exact: true }).check();
}

export async function fillAddress(page: Page): Promise<void> {
  await fill(page, "Street address", "500 Harbor Way");
  await fill(page, "Address line 2", "Suite 400");
  await fill(page, "City", "Wilmington");
  await fill(page, "State / province", "DE");
  await fill(page, "Postal code", "19801");
  await pickOption(page, "Country", "United States");
}

export async function fillContacts(page: Page): Promise<void> {
  await fill(page, "Primary contact name", "Ana Souza");
  await fill(page, "Primary contact title", "Head of Partnerships");
  await fill(page, "Primary contact email", "ana.souza@tidewater.example");
  await fill(page, "Primary contact phone", "+1 302 555 0142");
  await fill(page, "Accounts receivable name", "Leo Park");
  await fill(page, "Accounts receivable email", "ar@tidewater.example");
}

export async function fillBanking(page: Page): Promise<void> {
  await fill(page, "Bank name", "First Harbor Bank");
  await fill(page, "Account holder name", "Tidewater Cloud Inc.");
  await fill(page, "Account number", "000123456789");
  await fill(page, "Routing number (ABA)", "021000021");
  await pickOption(page, "Currency", "USD");
  await page.getByLabel("I confirm these banking details", { exact: true }).check();
}

export async function fillCompliance(page: Page, pdfs: SupplierPdfs): Promise<void> {
  // One upload through the visible button (filechooser event), one through the labeled input.
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByRole("button", { name: "Choose file for W-9 form", exact: true }).click(),
  ]);
  await chooser.setFiles(pdfs.w9);
  await page.getByText(baseName(pdfs.w9), { exact: true }).waitFor();
  await page.getByLabel("Certificate of insurance", { exact: true }).setInputFiles(pdfs.coi);
  await page.getByText(baseName(pdfs.coi), { exact: true }).waitFor();
  await page.getByLabel("Small business", { exact: true }).check();
  await page.getByRole("radio", { name: "No", exact: true }).check();
  await page.getByLabel("I accept the Supplier Code of Conduct", { exact: true }).check();
  await fill(page, "Signatory name", "Ana Souza");
  await fill(page, "Signatory title", "Head of Partnerships");
}

/** Fills every step and stops on the Review page. */
export async function fillToReview(
  page: Page,
  baseUrl: string,
  tenant: string,
  code: string,
  pdfs: SupplierPdfs,
): Promise<void> {
  await startRegistration(page, baseUrl, tenant, code);
  await fillCompany(page);
  await next(page, tenant, "address");
  await fillAddress(page);
  await next(page, tenant, "contacts");
  await fillContacts(page);
  await next(page, tenant, "banking");
  await fillBanking(page);
  await next(page, tenant, "compliance");
  await fillCompliance(page, pdfs);
  await next(page, tenant, "review");
}

/** Full run including the final submit. Returns the supplier id shown on the success page. */
export async function completeWizard(
  page: Page,
  baseUrl: string,
  tenant: string,
  code: string,
  pdfs: SupplierPdfs,
): Promise<string> {
  await fillToReview(page, baseUrl, tenant, code, pdfs);
  await page.getByRole("button", { name: "Submit for approval", exact: true }).click();
  await page.waitForURL(new RegExp(`/t/${tenant}/register/complete/SG-${tenant.toUpperCase()}-\\d{6}$`));
  return (await page.getByTestId("sg-supplier-id").textContent())?.trim() ?? "";
}

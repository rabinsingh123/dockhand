import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type PortalHandle, startSupplierPortal } from "../index.ts";
import { launchBrowser, makePdf, missingTestids, newRunId, openContext, tempDir } from "./helpers.ts";
import * as flow from "./supplierFlow.ts";

let browser: Browser;
let portal: PortalHandle;
let w9: ReturnType<typeof makePdf>;
let coi: ReturnType<typeof makePdf>;

beforeAll(async () => {
  [browser, portal] = await Promise.all([
    launchBrowser(),
    startSupplierPortal({ port: 0, latencyMs: [100, 200] }),
  ]);
  const dir = tempDir("portal-pdfs");
  w9 = makePdf(dir, "w9-tidewater.pdf", "W-9 Tidewater Cloud Inc.");
  coi = makePdf(dir, "coi-tidewater.pdf", "Certificate of insurance Tidewater Cloud Inc.");
});

afterAll(async () => {
  await browser?.close();
  await portal?.close();
});

const fill = (page: Page, label: string, value: string) =>
  page.getByLabel(label, { exact: true }).fill(value);
const pdfs = () => ({ w9: w9.path, coi: coi.path });
const startRegistration = (page: Page, tenant: string, code: string) =>
  flow.startRegistration(page, portal.url, tenant, code);
const fillCompliance = (page: Page) => flow.fillCompliance(page, pdfs());
const completeWizard = (page: Page, tenant: string, code: string) =>
  flow.completeWizard(page, portal.url, tenant, code, pdfs());
const { next, fillCompany, fillAddress, fillContacts, fillBanking } = flow;

describe("supplier portal", () => {
  it("completes the acme wizard with two PDF uploads and records files with sha256", async () => {
    const runId = newRunId("acme");
    const { context, page, errors } = await openContext(browser, portal, { runId });
    try {
      await page.goto(`${portal.url}/t/acme/invite/ACME-7731`);
      await page.getByText("You've been invited to register as a supplier for Acme Group").waitFor();
      expect(await page.getByText("Acme Group · Supplier Portal", { exact: true }).count()).toBe(1);
      expect(await missingTestids(page)).toEqual([]);

      await startRegistration(page, "acme", "ACME-7731");
      await fillCompany(page);
      expect(await missingTestids(page)).toEqual([]);
      await next(page, "acme", "address");
      await fillAddress(page);
      await page.getByLabel("Remit-to address is the same", { exact: true }).uncheck();
      expect(await missingTestids(page)).toEqual([]);
      await page.getByLabel("Remit-to address is the same", { exact: true }).check();
      await next(page, "acme", "contacts");
      await fillContacts(page);
      await next(page, "acme", "banking");
      await fillBanking(page);
      await next(page, "acme", "compliance");
      await fillCompliance(page);
      expect(await missingTestids(page)).toEqual([]);
      await next(page, "acme", "review");
      expect(await missingTestids(page)).toEqual([]);

      // Review page read-back: <dd data-field> per field.
      const readback = (key: string) => page.locator(`dd[data-field="${key}"]`).textContent();
      expect(await readback("legalName")).toBe("Tidewater Cloud Inc.");
      expect(await readback("employees")).toBe("51-200");
      expect(await readback("remitSameAsAddress")).toBe("Yes");
      expect(await readback("w9File")).toBe("w9-tidewater.pdf");
      expect(await readback("diversity")).toBe("Small business");
      expect(await readback("salesContactName")).toBe("");
      expect(await page.locator('dd[data-field="yearFounded"]').getAttribute("data-value")).toBe("2016");

      await page.getByRole("button", { name: "Submit for approval", exact: true }).click();
      await page.waitForURL(/\/t\/acme\/register\/complete\/SG-ACME-\d{6}$/);
      const id = (await page.getByTestId("sg-supplier-id").textContent())?.trim();
      expect(id).toMatch(/^SG-ACME-\d{6}$/);
      expect(await page.getByTestId("sg-supplier-status").textContent()).toBe("Pending buyer approval");
      await page.getByRole("heading", { name: "Registration submitted" }).waitFor();
      expect(await missingTestids(page)).toEqual([]);

      const subs = portal.submissions({ runId });
      expect(subs).toHaveLength(1);
      const sub = subs[0];
      expect(sub).toMatchObject({ id, portal: "supplier", tenant: "acme", inviteCode: "ACME-7731", runId });
      expect(sub?.fields).toMatchObject({
        legalName: "Tidewater Cloud Inc.",
        tradeName: "Tidewater Cloud",
        taxId: "12-3456789",
        countryOfIncorporation: "United States",
        stateOfIncorporation: "Delaware",
        yearFounded: 2016,
        employees: "51-200",
        annualRevenue: "$10M-$50M",
        entityType: "LLC",
        street1: "500 Harbor Way",
        country: "United States",
        remitSameAsAddress: true,
        primaryContactEmail: "ana.souza@tidewater.example",
        arContactEmail: "ar@tidewater.example",
        routingNumber: "021000021",
        currency: "USD",
        bankConfirm: true,
        diversity: ["Small business"],
        conflictOfInterest: "No",
        codeOfConduct: true,
        signatoryName: "Ana Souza",
      });
      expect(sub?.fields).not.toHaveProperty("remitStreet1");
      expect(sub?.fields).not.toHaveProperty("salesContactName");
      expect(sub?.files).toEqual([
        { field: "w9File", filename: "w9-tidewater.pdf", size: w9.size, sha256: w9.sha256 },
        { field: "coiFile", filename: "coi-tidewater.pdf", size: coi.size, sha256: coi.sha256 },
      ]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("reveals the remit-to section when unchecked, validates it, and keeps values on Back", async () => {
    const { context, page } = await openContext(browser, portal, { runId: newRunId("remit") });
    try {
      await startRegistration(page, "acme", "ACME-7731");
      await fillCompany(page);
      await next(page, "acme", "address");
      await fillAddress(page);

      const remitStreet = page.getByLabel("Remit-to street address", { exact: true });
      expect(await remitStreet.count()).toBe(0);
      await page.getByLabel("Remit-to address is the same", { exact: true }).uncheck();
      for (const label of [
        "Remit-to street address",
        "Remit-to address line 2",
        "Remit-to city",
        "Remit-to state / province",
        "Remit-to postal code",
      ]) {
        expect(await page.getByLabel(label, { exact: true }).isVisible(), label).toBe(true);
      }

      await page.getByRole("button", { name: "Next", exact: true }).click();
      await page.getByTestId("sg-error-summary").waitFor();
      expect(await page.getByTestId("sg-error-summary").textContent()).toContain("Fix 4 fields to continue");
      expect(await remitStreet.getAttribute("aria-invalid")).toBe("true");
      expect(new URL(page.url()).pathname).toBe("/t/acme/register/address");

      await remitStreet.fill("PO Box 7731");
      await fill(page, "Remit-to city", "Dover");
      await fill(page, "Remit-to state / province", "DE");
      await fill(page, "Remit-to postal code", "19903");
      await next(page, "acme", "contacts");

      await page.getByRole("button", { name: "Back", exact: true }).click();
      await page.waitForURL(/\/register\/address$/);
      expect(await page.getByLabel("Street address", { exact: true }).inputValue()).toBe("500 Harbor Way");
      expect(await page.getByRole("combobox", { name: "Country", exact: true }).inputValue()).toBe(
        "United States",
      );
      expect(await page.getByLabel("Remit-to address is the same", { exact: true }).isChecked()).toBe(false);
      expect(await remitStreet.inputValue()).toBe("PO Box 7731");

      await page.getByRole("button", { name: "Back", exact: true }).click();
      await page.waitForURL(/\/register\/company$/);
      expect(await page.getByLabel("Legal company name", { exact: true }).inputValue()).toBe(
        "Tidewater Cloud Inc.",
      );
      expect(await page.getByRole("radio", { name: "LLC", exact: true }).isChecked()).toBe(true);

      // Stepper: completed steps are reachable directly.
      await page.getByTestId("sg-step-contacts").click();
      await page.waitForURL(/\/register\/contacts$/);
    } finally {
      await context.close();
    }
  });

  it("redirects a direct load of a later step to the first incomplete step", async () => {
    const { context, page } = await openContext(browser, portal, { runId: newRunId("gate") });
    try {
      await page.goto(`${portal.url}/t/acme/register/banking`);
      await page.waitForURL(/\/t\/acme\/register\/company$/);
      await page.getByRole("heading", { name: "Company information" }).waitFor();
    } finally {
      await context.close();
    }
  });

  it("globex: own brand, invite codes and layout; an acme-style label-based run completes unchanged", async () => {
    const runId = newRunId("globex");
    const { context, page, errors } = await openContext(browser, portal, { runId });
    try {
      await page.goto(`${portal.url}/t/globex/invite/ACME-7731`);
      await page.getByRole("heading", { name: "This invitation link isn't valid" }).waitFor();
      expect(await page.getByRole("button", { name: "Start registration" }).count()).toBe(0);

      await page.goto(`${portal.url}/t/globex/invite/GLOBEX-2048`);
      await page.getByText("You've been invited to register as a supplier for Globex Industrial").waitFor();
      await startRegistration(page, "globex", "GLOBEX-2048");
      expect(await page.getByLabel("D-U-N-S number", { exact: true }).count()).toBe(1);
      const labels = await page.locator("form label, form legend").allTextContents();
      expect(labels.indexOf("Tax ID (EIN)")).toBeLessThan(labels.indexOf("Trade name (DBA)"));

      await page.goto(`${portal.url}/t/globex/invite/GLOBEX-2048`);
      const id = await completeWizard(page, "globex", "GLOBEX-2048");
      expect(id).toMatch(/^SG-GLOBEX-\d{6}$/);
      const [sub] = portal.submissions({ runId });
      expect(sub).toMatchObject({ tenant: "globex", inviteCode: "GLOBEX-2048" });
      expect(sub?.fields.legalName).toBe("Tidewater Cloud Inc.");
      expect(sub?.files?.map((f) => f.sha256)).toEqual([w9.sha256, coi.sha256]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }

    const unknown = await fetch(`${portal.url}/t/initech/invite/INITECH-1234`);
    expect(unknown.status).toBe(404);
  });

  it("rejects a final submit without the required files", async () => {
    const [cookie] = await portal.session({ runId: newRunId("api") });
    if (!cookie) throw new Error("no cookie");
    const form = new FormData();
    form.set("payload", JSON.stringify({ legalName: "No Files Inc." }));
    const res = await fetch(`${portal.url}/api/t/acme/suppliers`, {
      method: "POST",
      headers: { cookie: `${cookie.name}=${cookie.value}` },
      body: form,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { fieldErrors: Record<string, string> };
    expect(body.fieldErrors.w9File).toBe("W-9 form is required.");
    expect(body.fieldErrors.coiFile).toBe("Certificate of insurance is required.");
    expect(body.fieldErrors.taxId).toBe("Tax ID (EIN) is required.");
    expect(body.fieldErrors.legalName).toBeUndefined();
    expect((await fetch(`${portal.url}/api/t/acme/suppliers`, { method: "POST", body: form })).status).toBe(
      401,
    );
  });
});

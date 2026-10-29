// Screenshots of the portals at 1280x800 for design review.
// Usage: tsx apps/portals/src/dev/screenshots.ts [outDir] [--all] [--partner-only]
// Default outDir: apps/portals/screenshots (partner-v1-form.png, supplier-step1.png).
// --all also captures v2, mutations, validation, review and success pages.

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import { type PortalHandle, type SessionOptions, startPartnerPortal, startSupplierPortal } from "../index.ts";
import { makePdf, tempDir } from "../test/helpers.ts";
import * as flow from "../test/supplierFlow.ts";

const args = process.argv.slice(2);
const all = args.includes("--all");
const partnerOnly = args.includes("--partner-only");
const outDir = resolve(
  args.find((a) => !a.startsWith("--")) ?? fileURLToPath(new URL("../../screenshots", import.meta.url)),
);
mkdirSync(outDir, { recursive: true });

async function shoot(
  browser: Browser,
  handle: PortalHandle,
  session: SessionOptions,
  path: string,
  file: string,
  prepare?: (page: Page) => Promise<void>,
  fullPage = false,
): Promise<void> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
  });
  await context.addCookies(await handle.session(session));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(handle.url + path);
  if (prepare) await prepare(page);
  await page.mouse.move(0, 0); // no hover state in the capture
  await page.screenshot({ path: join(outDir, file), fullPage });
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  console.log(
    `${file}: scrollWidth=${width} scrollHeight=${height}${errors.length ? ` ERRORS=${errors.join(" | ")}` : ""}`,
  );
  await context.close();
}

function futureDmy(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

async function main() {
  const browser = await chromium.launch();
  const partner = await startPartnerPortal({ port: 0, latencyMs: [0, 0] });
  const supplier = partnerOnly ? null : await startSupplierPortal({ port: 0, latencyMs: [0, 0] });
  try {
    await shoot(browser, partner, { runId: "shots", ui: "v1" }, "/deals/new", "partner-v1-form.png");
    if (supplier) {
      await shoot(
        browser,
        supplier,
        { runId: "shots" },
        "/t/acme/invite/ACME-7731",
        "supplier-step1.png",
        async (page) => {
          await page.getByRole("button", { name: "Start registration" }).click();
          await page.waitForURL(/\/register\/company$/);
        },
      );
    }
    if (!all) return;

    await shoot(browser, partner, { runId: "s", ui: "v1" }, "/deals", "partner-v1-list.png");
    await shoot(browser, partner, { runId: "s", ui: "v2" }, "/deals", "partner-v2-list.png");
    await shoot(browser, partner, { runId: "s", ui: "v2" }, "/deals/new", "partner-v2-form.png");
    await shoot(
      browser,
      partner,
      { runId: "s", ui: "v2" },
      "/deals/new",
      "partner-v2-form-full.png",
      undefined,
      true,
    );
    await shoot(
      browser,
      partner,
      { runId: "s", ui: "v1" },
      "/deals/new",
      "partner-v1-form-full.png",
      undefined,
      true,
    );
    await shoot(
      browser,
      partner,
      { runId: "s", ui: "v1" },
      "/deals/new",
      "partner-v1-errors.png",
      async (page) => {
        await page.getByRole("button", { name: "Submit registration" }).click();
      },
    );
    await shoot(
      browser,
      partner,
      { runId: "s", ui: "v1" },
      "/deals/new",
      "partner-v1-combobox.png",
      async (page) => {
        await page.getByRole("combobox", { name: "Country" }).click();
      },
    );
    await shoot(
      browser,
      partner,
      { runId: "s", ui: "v1" },
      "/deals/new",
      "partner-v1-confirmation.png",
      async (page) => {
        await page.getByLabel("End customer company", { exact: true }).fill("Sabiá Foods Ltda.");
        await page.getByLabel("Company website", { exact: true }).fill("sabiafoods.example");
        await page.getByRole("combobox", { name: "Country" }).fill("Brazil");
        await page.keyboard.press("Enter");
        await page.getByLabel("City", { exact: true }).fill("São Paulo");
        await page.getByLabel("Contact full name", { exact: true }).fill("Mariana Costa");
        await page.getByLabel("Contact email", { exact: true }).fill("mariana.costa@sabiafoods.example");
        await page.getByRole("combobox", { name: "Product" }).click();
        await page.getByRole("option", { name: "Tidewater Cloud Business" }).click();
        await page.getByLabel("Seats", { exact: true }).fill("25");
        await page.getByLabel("Estimated value (USD)", { exact: true }).fill("18000");
        await page.getByLabel("Expected close date", { exact: true }).fill(futureDmy(60));
        await page.getByLabel("The end customer agreed to be contacted by Caravela").check();
        await page.getByRole("button", { name: "Submit registration" }).click();
        await page.waitForURL(/\/deals\/NW-REG-\d{5}$/);
      },
      true,
    );
    for (const [name, ops] of [
      ["class-churn", ["class_churn", "wrapper_divs", "id_churn", "testid_churn"]],
      ["labels", ["label_synonym", "placeholder_change", "reorder_fields"]],
      ["insert", ["insert_required_field", "insert_optional_field", "combobox_to_radio", "button_rename"]],
    ] as const) {
      await shoot(
        browser,
        partner,
        { runId: "s", ui: "v1", mutation: { seed: 7, operators: [...ops] } },
        "/deals/new",
        `partner-mut-${name}.png`,
        undefined,
        true,
      );
    }
    if (supplier) {
      await shoot(
        browser,
        supplier,
        { runId: "s" },
        "/t/globex/invite/GLOBEX-2048",
        "supplier-globex-landing.png",
      );
      await shoot(browser, supplier, { runId: "s" }, "/t/acme/invite/ACME-7731", "supplier-acme-landing.png");
      await shoot(
        browser,
        supplier,
        { runId: "s" },
        "/t/globex/invite/GLOBEX-2048",
        "supplier-globex-step1.png",
        async (page) => {
          await page.getByRole("button", { name: "Start registration" }).click();
          await page.waitForURL(/\/register\/company$/);
        },
      );
      await shoot(
        browser,
        supplier,
        { runId: "s" },
        "/t/acme/invite/ACME-7731",
        "supplier-step1-errors.png",
        async (page) => {
          await page.getByRole("button", { name: "Start registration" }).click();
          await page.waitForURL(/\/register\/company$/);
          await page.getByRole("button", { name: "Next" }).click();
        },
      );
      const dir = tempDir("portal-shots");
      const pdfs = {
        w9: makePdf(dir, "w9-tidewater.pdf", "W-9").path,
        coi: makePdf(dir, "coi-tidewater.pdf", "COI").path,
      };
      await shoot(browser, supplier, { runId: "s" }, "/", "supplier-home.png");
      await shoot(
        browser,
        supplier,
        { runId: "s" },
        "/t/acme/invite/ACME-7731",
        "supplier-address-remit.png",
        async (page) => {
          await flow.startRegistration(page, supplier.url, "acme", "ACME-7731");
          await flow.fillCompany(page);
          await flow.next(page, "acme", "address");
          await page.getByLabel("Remit-to address is the same", { exact: true }).uncheck();
        },
        true,
      );
      await shoot(
        browser,
        supplier,
        { runId: "s" },
        "/t/acme/invite/ACME-7731",
        "supplier-compliance.png",
        async (page) => {
          await flow.startRegistration(page, supplier.url, "acme", "ACME-7731");
          await flow.fillCompany(page);
          await flow.next(page, "acme", "address");
          await flow.fillAddress(page);
          await flow.next(page, "acme", "contacts");
          await flow.fillContacts(page);
          await flow.next(page, "acme", "banking");
          await flow.fillBanking(page);
          await flow.next(page, "acme", "compliance");
          await flow.fillCompliance(page, pdfs);
        },
        true,
      );
      await shoot(
        browser,
        supplier,
        { runId: "s" },
        "/t/globex/invite/GLOBEX-2048",
        "supplier-review.png",
        (page) => flow.fillToReview(page, supplier.url, "globex", "GLOBEX-2048", pdfs),
        true,
      );
      await shoot(
        browser,
        supplier,
        { runId: "s" },
        "/t/acme/invite/ACME-7731",
        "supplier-success.png",
        async (page) => {
          await flow.completeWizard(page, supplier.url, "acme", "ACME-7731", pdfs);
        },
      );
    }
  } finally {
    await browser.close();
    await partner.close();
    await supplier?.close();
  }
}

await main();

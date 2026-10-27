import type { Browser } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type PortalHandle, partnerAuthCookie, startPartnerPortal } from "../index.ts";
import {
  fillPartnerForm,
  futureDmy,
  futureIso,
  launchBrowser,
  missingTestids,
  newRunId,
  openContext,
  samplePartner,
  VIEWPORT,
} from "./helpers.ts";

let browser: Browser;
let portal: PortalHandle;

beforeAll(async () => {
  [browser, portal] = await Promise.all([launchBrowser(), startPartnerPortal({ port: 0 })]);
});

afterAll(async () => {
  await browser?.close();
  await portal?.close();
});

beforeEach(() => {
  portal.setVersion("v1");
  portal.setMutation(null);
});

async function postDeal(body: unknown, cookie?: { name: string; value: string }) {
  const res = await fetch(`${portal.url}/api/deals`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie: `${cookie.name}=${cookie.value}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("partner portal v1", () => {
  it("registers a deal end to end and records canonical fields", async () => {
    const runId = newRunId("p-v1");
    const { context, page, errors } = await openContext(browser, portal, { ui: "v1", runId });
    try {
      await page.goto(`${portal.url}/deals`);
      expect(await missingTestids(page)).toEqual([]);
      await page.getByRole("button", { name: "Register a deal", exact: true }).click();
      await page.waitForURL(/\/deals\/new$/);
      await page.getByRole("combobox", { name: "Country", exact: true }).click();
      expect(await missingTestids(page)).toEqual([]);
      await page.keyboard.press("Escape");

      const input = samplePartner(portal);
      await fillPartnerForm(page, input);
      await page.getByRole("button", { name: "Submit registration", exact: true }).click();
      // Simulated latency: the button shows a spinner state before navigating.
      await page.getByRole("button", { name: "Submitting…" }).waitFor({ timeout: 2000 });
      await page.waitForURL(/\/deals\/NW-REG-\d{5}$/);

      const id = (await page.getByTestId("nw-registration-id").textContent())?.trim() ?? "";
      expect(id).toMatch(/^NW-REG-\d{5}$/);
      expect(await page.getByRole("heading", { name: "Registration received" }).isVisible()).toBe(true);
      expect(await page.getByTestId("nw-registration-status").textContent()).toBe("Pending review");
      expect(await missingTestids(page)).toEqual([]);

      // Read-back: every field as <dd data-field>, in the format the form accepts.
      const readback = (key: string) => page.locator(`dd[data-field="${key}"]`).textContent();
      expect(await readback("companyName")).toBe("Sabiá Foods Ltda.");
      expect(await readback("country")).toBe("Brazil");
      expect(await readback("seats")).toBe("25");
      expect(await readback("expectedCloseDate")).toBe(input.expectedCloseDate);
      expect(await readback("consent")).toBe("Yes");
      expect(await page.locator("dd[data-field]").count()).toBe(14);
      expect(await page.locator('dd[data-field="expectedCloseDate"]').getAttribute("data-value")).toBe(
        futureIso(portal, 60),
      );

      const subs = portal.submissions({ runId });
      expect(subs).toHaveLength(1);
      expect(subs[0]).toMatchObject({ id, portal: "partner", version: "v1", runId });
      expect(subs[0]?.fields).toEqual({
        companyName: "Sabiá Foods Ltda.",
        companyWebsite: "sabiafoods.com.br",
        country: "Brazil",
        city: "São Paulo",
        contactName: "Mariana Costa",
        contactEmail: "mariana.costa@sabiafoods.example",
        contactPhone: "+55 11 91234 5678",
        product: "Tidewater Cloud Business",
        seats: 25,
        estimatedValue: 18000,
        expectedCloseDate: futureIso(portal, 60),
        referralPartner: "Rota Digital",
        notes: "Wants a January start.",
        consent: true,
      });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("shows inline errors with role=alert and aria-invalid; the server rejects bad payloads", async () => {
    const runId = newRunId("p-val");
    const { context, page } = await openContext(browser, portal, { ui: "v1", runId });
    try {
      await page.goto(`${portal.url}/deals/new`);
      await page.getByRole("button", { name: "Submit registration", exact: true }).click();
      await page.getByTestId("nw-error-summary").waitFor();
      expect(await page.getByTestId("nw-error-summary").getAttribute("role")).toBe("alert");
      expect(await page.getByTestId("nw-error-summary").textContent()).toContain("There are 9 problems");
      // Summary + one alert per missing required field.
      expect(await page.getByRole("alert").count()).toBe(10);

      const company = page.getByLabel("End customer company", { exact: true });
      expect(await company.getAttribute("aria-invalid")).toBe("true");
      expect(await company.getAttribute("aria-required")).toBe("true");
      expect(
        await page.getByRole("combobox", { name: "Country", exact: true }).getAttribute("aria-invalid"),
      ).toBe("true");
      expect(
        await page.getByLabel("Company website", { exact: true }).getAttribute("aria-invalid"),
      ).toBeNull();
      const describedBy = (await company.getAttribute("aria-describedby")) ?? "";
      expect(await page.locator(`[id="${describedBy}"]`).textContent()).toContain(
        "End customer company is required.",
      );

      // Errors update as fields are fixed; a past date is rejected.
      await company.fill("Acme Ltda.");
      expect(await company.getAttribute("aria-invalid")).toBeNull();
      await page.getByLabel("Expected close date", { exact: true }).fill("01/01/2020");
      await page.getByText("Expected close date must be in the future.").first().waitFor();
      await page.getByLabel("Expected close date", { exact: true }).fill("31/02/2030");
      await page.getByText("Expected close date must be a real date.").first().waitFor();
      await page.getByLabel("Seats", { exact: true }).fill("2.5");
      await page.getByText("Seats must be a whole number.").first().waitFor();
      expect(portal.submissions({ runId })).toHaveLength(0);
    } finally {
      await context.close();
    }

    // Server-side validation mirrors the client.
    const [cookie] = await portal.session({ runId: `${runId}-api` });
    if (!cookie) throw new Error("no cookie");
    const bad = await postDeal(
      {
        companyName: " ",
        country: "Atlantis",
        seats: "0",
        contactEmail: "nope",
        expectedCloseDate: "01/01/2020",
      },
      cookie,
    );
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("validation_failed");
    expect(Object.keys(bad.body.fieldErrors as object).sort()).toEqual(
      [
        "city",
        "companyName",
        "consent",
        "contactEmail",
        "contactName",
        "country",
        "expectedCloseDate",
        "product",
        "seats",
      ].sort(),
    );
    expect((await postDeal("not an object", cookie)).status).toBe(400);
    expect((await postDeal({ companyName: "X" })).status).toBe(401);

    // A valid API payload works; the same company + product again within 60 s is idempotent.
    const good = {
      companyName: "Andes Analytics SpA",
      country: "chile",
      city: "Santiago",
      contactName: "Tomás Rojas",
      contactEmail: "tomas@andes.example",
      product: "Tidewater Cloud Starter",
      seats: 12,
      expectedCloseDate: futureDmy(portal, 30),
      consent: true,
    };
    const first = await postDeal(good, cookie);
    expect(first.status).toBe(201);
    expect(first.body.id).toMatch(/^NW-REG-\d{5}$/);
    expect((first.body.fields as Record<string, unknown>).country).toBe("Chile");
    const again = await postDeal({ ...good, companyName: "andes analytics spa" }, cookie);
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    expect(again.body.id).toBe(first.body.id);
    expect(portal.submissions({ runId: `${runId}-api` })).toHaveLength(1);
  });
});

describe("partner portal v2 (self-heal demo)", () => {
  it("drops the v1 submit testid and text; 'Register opportunity' works with the redesigned layout", async () => {
    const runId = newRunId("p-v2");
    const { context, page, errors } = await openContext(browser, portal, { ui: "v2", runId });
    try {
      await page.goto(`${portal.url}/deals/new`);
      await page.getByRole("heading", { name: "Register an opportunity" }).waitFor();

      expect(await page.getByTestId("nw-submit").count()).toBe(0);
      expect(await page.getByRole("button", { name: "Submit registration" }).count()).toBe(0);
      expect(await page.locator('[data-testid^="nw-"]').count()).toBe(0);
      const submit = page.getByRole("button", { name: "Register opportunity", exact: true });
      expect(await submit.count()).toBe(1);
      expect(await submit.getAttribute("data-testid")).toBeNull();
      expect(await page.getByLabel("Product", { exact: true }).count()).toBe(0);
      expect(await page.getByRole("combobox", { name: "Solution", exact: true }).count()).toBe(1);
      expect(await page.getByRole("group", { name: "Customer contact" }).count()).toBe(1);

      const labels = await page.locator("label").allTextContents();
      expect(labels.indexOf("City")).toBeLessThan(labels.indexOf("Country"));
      expect(labels.indexOf("Contact full name")).toBeLessThan(labels.indexOf("End customer company"));

      await fillPartnerForm(
        page,
        samplePartner(portal, { companyName: "Jaguar Logística S.A." }),
        "Solution",
      );
      await submit.click();
      await page.waitForURL(/\/deals\/NW-REG-\d{5}$/);
      expect(await page.getByTestId("reg-registration-id").textContent()).toMatch(/^NW-REG-\d{5}$/);
      expect(await page.getByRole("heading", { name: "Registration received" }).isVisible()).toBe(true);

      const [sub] = portal.submissions({ runId });
      expect(sub?.version).toBe("v2");
      expect(sub?.fields.product).toBe("Tidewater Cloud Business");
      expect(sub?.fields.companyName).toBe("Jaguar Logística S.A.");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

describe("partner auth", () => {
  it("redirects protected routes to /login without a cookie; login and the helper cookie grant access", async () => {
    const res = await fetch(`${portal.url}/deals/new`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?next=%2Fdeals%2Fnew");
    expect((await fetch(`${portal.url}/api/deals`)).status).toBe(401);

    const context = await browser.newContext({ viewport: VIEWPORT });
    try {
      const page = await context.newPage();
      await page.goto(`${portal.url}/deals/new`);
      await page.waitForURL(/\/login\?next=%2Fdeals%2Fnew$/);
      await page.getByRole("button", { name: "Sign in" }).click();
      expect(await page.getByLabel("Username", { exact: true }).getAttribute("aria-invalid")).toBe("true");
      await page.getByLabel("Username", { exact: true }).fill("ana.souza");
      await page.getByLabel("Password", { exact: true }).fill("any-password");
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL(/\/deals\/new$/);
      await page.getByRole("button", { name: "Submit registration", exact: true }).waitFor();
    } finally {
      await context.close();
    }

    const authed = await browser.newContext({ viewport: VIEWPORT });
    try {
      await authed.addCookies([await partnerAuthCookie(portal)]);
      const page = await authed.newPage();
      await page.goto(`${portal.url}/deals/new`);
      expect(new URL(page.url()).pathname).toBe("/deals/new");
      await page.getByRole("heading", { name: "Register a deal" }).waitFor();
    } finally {
      await authed.close();
    }
  });
});

import type { ElementDescriptor } from "@dockhand/core";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_ORIGIN, fixtureContext, launchTestBrowser } from "../test-support.ts";
import { REGISTER_FORM } from "./fixtures.ts";
import { formSnapshot, listInteractive, readFieldValue } from "./forms.ts";
import { toLocator } from "./locators.ts";
import { similarity } from "./similarity.ts";

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await launchTestBrowser();
  ({ page } = await fixtureContext(browser, {
    "/form": REGISTER_FORM,
    "/select": `<!doctype html><label for=s>Currency</label><select id=s><option value="usd">US dollar</option>
      <option value="brl" selected>Brazilian real</option></select>
      <div role=checkbox aria-checked=true tabindex=0 aria-label="Remember me">x</div>`,
  }));
  await page.goto(`${FIXTURE_ORIGIN}/form`);
});
afterAll(async () => {
  await browser?.close();
});

describe("formSnapshot and readFieldValue", () => {
  it("reads end states keyed by label, with groups and duplicate labels resolved", async () => {
    await page.getByTestId("company").fill("Sabiá Foods Ltda");
    await page.locator("#country-input").fill("Brazil");
    await page.locator("#\\:r4\\:").fill("mariana@sabia.example");
    await page.locator("#\\:r6\\:").fill("billing@sabia.example");
    await page.getByRole("checkbox", { name: "I confirm the customer consented" }).check();
    await page.getByRole("radio", { name: "Silver" }).check();
    await page
      .locator("#w9")
      .setInputFiles({ name: "w9-sabia.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4") });

    const snap = await formSnapshot(page);
    expect(snap).toMatchObject({
      "Company name": "Sabiá Foods Ltda",
      Website: "",
      Country: "Brazil",
      Email: "mariana@sabia.example",
      "Email (Billing contact)": "billing@sabia.example",
      "I confirm the customer consented": "true",
      "Partner tier": "Silver",
      "W-9 form": "w9-sabia.pdf",
    });

    expect(await readFieldValue(page.getByTestId("company"))).toBe("Sabiá Foods Ltda");
    expect(await readFieldValue(page.getByRole("combobox", { name: "Country" }))).toBe("Brazil");
    expect(
      await readFieldValue(page.getByRole("checkbox", { name: "I confirm the customer consented" })),
    ).toBe("true");
    expect(await readFieldValue(page.getByRole("radio", { name: "Gold" }))).toBe("false");
    expect(await readFieldValue(page.locator("#w9"))).toBe("w9-sabia.pdf");
  });

  it("reads a native select's shown option text and an ARIA checkbox", async () => {
    const { page: p } = await fixtureContext(browser, {
      "/select": `<!doctype html><label for=s>Currency</label><select id=s><option value="usd">US dollar</option>
        <option value="brl" selected>Brazilian real</option></select>
        <div role=checkbox aria-checked=true tabindex=0 aria-label="Remember me">x</div>`,
    });
    await p.goto(`${FIXTURE_ORIGIN}/select`);
    expect(await readFieldValue(p.getByLabel("Currency"))).toBe("Brazilian real");
    expect(await readFieldValue(p.getByRole("checkbox", { name: "Remember me" }))).toBe("true");
    expect(await formSnapshot(p)).toEqual({ Currency: "Brazilian real", "Remember me": "true" });
    await p.context().close();
  });
});

describe("listInteractive", () => {
  it("describes every visible control with candidates that resolve to it", async () => {
    const items = await listInteractive(page);
    const names = items.map((i) => i.descriptor.name);
    expect(names).toEqual(
      expect.arrayContaining(["Company name", "Website", "Country", "Submit registration", "Brazil"]),
    );
    expect(items.some((i) => i.descriptor.testId === "submit-reg" && i.descriptor.tag === "button")).toBe(
      true,
    );
    for (const item of items) {
      const first = item.candidates[0];
      if (!first) continue;
      const loc = toLocator(page, first, { allowHidden: item.descriptor.inputType === "file" });
      expect(await loc.count(), JSON.stringify(first)).toBe(1);
    }
  });
});

describe("similarity", () => {
  const base: ElementDescriptor = {
    tag: "input",
    inputType: "text",
    role: "textbox",
    name: "End customer company",
    label: "End customer company",
    placeholder: "e.g. Sabiá Foods Ltda.",
    testId: "nw-company-name",
    domId: "company-name",
    section: "End customer",
    bbox: { x: 163, y: 290, w: 634, h: 38 },
  };
  it("is 1 for an identical element and ignores attributes the stored side lacks", () => {
    expect(similarity(base, base)).toBe(1);
    expect(similarity({ tag: "input", bbox: base.bbox }, { ...base, testId: "other" })).toBe(1);
  });
  it("scores a churned testid high and a neighbouring field low", () => {
    const churned = similarity(base, { ...base, testId: "reg-account-name", domId: "opp-account-name" });
    const website = similarity(base, {
      ...base,
      name: "Company website",
      label: "Company website",
      placeholder: "e.g. sabiafoods.com.br",
      testId: "nw-company-website",
      domId: "company-website",
      bbox: { x: 163, y: 367, w: 634, h: 38 },
    });
    expect(churned).toBeGreaterThan(0.75);
    expect(website).toBeLessThan(0.55);
    expect(churned - website).toBeGreaterThan(0.15);
  });
  it("treats decoration and case as the same name", () => {
    expect(similarity({ ...base, label: "Company name" }, { ...base, label: "company name:" })).toBe(1);
  });
});

import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type PortalHandle, startPartnerPortal } from "../index.ts";
import { launchBrowser, newRunId, openContext } from "./helpers.ts";

let browser: Browser;
let portal: PortalHandle;

beforeAll(async () => {
  [browser, portal] = await Promise.all([launchBrowser(), startPartnerPortal({ port: 0 })]);
});

afterAll(async () => {
  await browser?.close();
  await portal?.close();
});

async function formPage(): Promise<{ page: Page; close: () => Promise<void> }> {
  const { context, page } = await openContext(browser, portal, { ui: "v1", runId: newRunId("combo") });
  await page.goto(`${portal.url}/deals/new`);
  return { page, close: () => context.close() };
}

describe("accessible combobox", () => {
  it("filters as you type and selects with Enter or arrow keys", async () => {
    const { page, close } = await formPage();
    try {
      const country = page.getByRole("combobox", { name: "Country", exact: true });
      expect(await country.getAttribute("aria-expanded")).toBe("false");
      await country.click();
      expect(await country.getAttribute("aria-expanded")).toBe("true");
      const listbox = page.getByRole("listbox");
      expect(await listbox.count()).toBe(1);
      expect(await country.getAttribute("aria-controls")).toBe(await listbox.getAttribute("id"));
      expect(await page.getByRole("option").count()).toBe(13);

      await page.keyboard.type("bra");
      expect(await page.getByRole("option").allTextContents()).toEqual(["Brazil"]);
      expect(await country.getAttribute("aria-activedescendant")).toBe(
        await page.getByRole("option", { name: "Brazil" }).getAttribute("id"),
      );
      await page.keyboard.press("Enter");
      expect(await country.inputValue()).toBe("Brazil");
      expect(await country.getAttribute("aria-expanded")).toBe("false");
      expect(await page.getByRole("listbox").count()).toBe(0);
      // Enter on a combobox never submits the form.
      expect(new URL(page.url()).pathname).toBe("/deals/new");
      expect(await page.getByTestId("nw-error-summary").count()).toBe(0);

      // ArrowDown opens on the current value, ArrowDown moves, Enter selects.
      await country.press("ArrowDown");
      expect(await page.getByRole("option", { selected: true }).textContent()).toBe("Brazil");
      await country.press("ArrowDown");
      await country.press("Enter");
      expect(await country.inputValue()).toBe("Chile");

      // Typing an exact name and leaving the field commits it; unknown text reverts.
      await country.fill("mexico");
      await country.press("Tab");
      expect(await country.inputValue()).toBe("Mexico");
      await country.fill("Atlantis");
      await page.getByText("No matches for").waitFor();
      await country.press("Escape");
      expect(await country.inputValue()).toBe("Mexico");
      await country.fill("Atlant");
      await page.getByLabel("City", { exact: true }).click();
      expect(await country.inputValue()).toBe("Mexico");
    } finally {
      await close();
    }
  });

  it("selects with a mouse click and shows the value", async () => {
    const { page, close } = await formPage();
    try {
      const product = page.getByRole("combobox", { name: "Product", exact: true });
      await product.click();
      await page.getByRole("option", { name: "Tidewater Cloud Enterprise", exact: true }).click();
      expect(await product.inputValue()).toBe("Tidewater Cloud Enterprise");
      expect(await product.getAttribute("aria-expanded")).toBe("false");
      expect(await product.evaluate((el) => el === document.activeElement)).toBe(true);

      // Options carry predictable testids: <field testid>-option-<slug>.
      await product.click();
      expect(await page.getByTestId("nw-product-option-tidewater-cloud-starter").count()).toBe(1);
      await page.getByTestId("nw-product-option-tidewater-cloud-starter").click();
      expect(await product.inputValue()).toBe("Tidewater Cloud Starter");

      // A click outside closes the list without changing the value.
      await product.click();
      await page.getByRole("heading", { name: "Register a deal" }).click();
      expect(await page.getByRole("listbox").count()).toBe(0);
      expect(await product.inputValue()).toBe("Tidewater Cloud Starter");
    } finally {
      await close();
    }
  });
});

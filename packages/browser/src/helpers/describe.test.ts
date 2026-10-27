import type { Target } from "@dockhand/core";
import { startPartnerPortal } from "@dockhand/portals";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { centreOf, FIXTURE_ORIGIN, fixtureContext, launchTestBrowser } from "../test-support.ts";
import { describeAt, describeLocator } from "./describe.ts";
import { REGISTER_FORM } from "./fixtures.ts";
import { toLocator } from "./locators.ts";

let browser: Browser;

beforeAll(async () => {
  browser = await launchTestBrowser();
});
afterAll(async () => {
  await browser?.close();
});

/** Every candidate resolves to exactly one element, and that element is (or is inside) `selector`'s element. */
async function expectCandidatesHit(page: Page, target: Target, selector: string) {
  const ref = await page.locator(selector).elementHandle();
  if (!ref) throw new Error(`no element for ${selector}`);
  const file = target.fingerprint.inputType === "file";
  for (const c of target.candidates) {
    const loc = toLocator(page, c, { allowHidden: file });
    expect(await loc.count(), JSON.stringify(c)).toBe(1);
    expect(
      await loc.evaluate((el, r) => el === r || (r as Element).contains(el), ref),
      JSON.stringify(c),
    ).toBe(true);
  }
  await ref.dispose();
}

describe("describeAt on a fixture form", () => {
  let page: Page;
  beforeAll(async () => {
    ({ page } = await fixtureContext(browser, { "/form": REGISTER_FORM }));
    await page.goto(`${FIXTURE_ORIGIN}/form`);
  });

  it("strips the CSS required-asterisk from role names and keeps only unique candidates", async () => {
    const { x, y } = await centreOf(page, "#\\:r1\\:");
    const t = await describeAt(page, x, y);
    expect(t.fingerprint).toMatchObject({
      tag: "input",
      role: "textbox",
      name: "Company name",
      label: "Company name",
    });
    expect(t.fingerprint.testId).toBe("company");
    expect(t.fingerprint.domId).toBeUndefined(); // ":r1:" is a generated React id
    expect(t.candidates[0]).toEqual({ by: "testid", value: "company" });
    expect(t.candidates).toContainEqual({ by: "role", role: "textbox", name: "Company name", exact: true });
    expect(t.candidates).toContainEqual({ by: "label", value: "Company name", exact: true });
    expect(t.candidates).toContainEqual({ by: "css", value: 'input[name="company"]' });
    expect(t.candidates.length).toBeLessThanOrEqual(6);
    await expectCandidatesHit(page, t, "#\\:r1\\:");
  });

  it("resolves a click on label text to the labelled input", async () => {
    const box = await page.locator('label[for=":r1:"]').boundingBox();
    if (!box) throw new Error("no label box");
    const t = await describeAt(page, Math.round(box.x + 10), Math.round(box.y + box.height / 2));
    expect(t.fingerprint).toMatchObject({ tag: "input", name: "Company name" });
    await expectCandidatesHit(page, t, "#\\:r1\\:");
  });

  it("describes a file input with the label first and Playwright's button role", async () => {
    const { x, y } = await centreOf(page, "#w9");
    const t = await describeAt(page, x, y);
    expect(t.fingerprint).toMatchObject({
      tag: "input",
      inputType: "file",
      role: "button",
      label: "W-9 form",
    });
    expect(t.candidates[0]).toEqual({ by: "label", value: "W-9 form", exact: true });
    expect(t.candidates).toContainEqual({ by: "css", value: 'input[name="w9"]' });
    await expectCandidatesHit(page, t, "#w9");
  });

  it("drops the label candidate of a combobox whose listbox carries the same label", async () => {
    const { x, y } = await centreOf(page, "#country-input");
    const t = await describeAt(page, x, y);
    expect(t.fingerprint).toMatchObject({ role: "combobox", name: "Country" });
    expect(t.candidates[0]).toEqual({ by: "role", role: "combobox", name: "Country", exact: true });
    expect(t.candidates.some((c) => c.by === "label")).toBe(false);
    expect(await page.getByLabel("Country").count()).toBe(2); // the trap the filter avoids
    await expectCandidatesHit(page, t, "#country-input");
  });

  it("keeps duplicate labels out and records the section", async () => {
    const { x, y } = await centreOf(page, "#\\:r4\\:");
    const t = await describeAt(page, x, y);
    expect(t.fingerprint).toMatchObject({ role: "textbox", name: "Email", section: "Primary contact" });
    expect(t.candidates.some((c) => c.by === "label" || c.by === "role")).toBe(false);
    expect(t.candidates.length).toBeGreaterThan(0);
    await expectCandidatesHit(page, t, "#\\:r4\\:");
  });

  it("climbs from an icon to its button and from a label's text to its checkbox", async () => {
    const svg = await centreOf(page, "button[type=submit] svg");
    const button = await describeAt(page, svg.x, svg.y);
    expect(button.fingerprint).toMatchObject({
      tag: "button",
      role: "button",
      name: "Submit registration",
      formSubmit: true,
    });
    expect(button.candidates[0]).toEqual({ by: "testid", value: "submit-reg" }); // the hidden duplicate is ignored
    await expectCandidatesHit(page, button, "button[type=submit]");

    const span = await centreOf(page, ".chk span");
    const check = await describeAt(page, span.x, span.y);
    expect(check.fingerprint).toMatchObject({
      role: "checkbox",
      name: "I confirm the customer consented",
      value: "false",
    });
    await expectCandidatesHit(page, check, "input[name=consent]");
  });

  it("describes a clickable div by its text and stable id", async () => {
    const { x, y } = await centreOf(page, "#adv span");
    const t = await describeAt(page, x, y);
    expect(t.fingerprint).toMatchObject({ tag: "div", text: "Advanced options", domId: "adv" });
    expect(t.candidates).toContainEqual({ by: "css", value: "#adv" });
    expect(t.candidates).toContainEqual({ by: "text", value: "Advanced options", exact: true });
    await expectCandidatesHit(page, t, "#adv");
  });

  it("returns no candidates for blank space", async () => {
    const t = await describeAt(page, 1200, 700);
    expect(t.candidates).toEqual([]);
    expect(["body", "html"]).toContain(t.fingerprint.tag);
  });

  it("describeLocator matches describeAt", async () => {
    const { x, y } = await centreOf(page, "#\\:r2\\:");
    const viaPoint = await describeAt(page, x, y);
    const viaLocator = await describeLocator(page.getByPlaceholder("acme.com"));
    expect(viaLocator.candidates).toEqual(viaPoint.candidates);
    expect(viaLocator.fingerprint.name).toBe("Website");
  });
});

describe("describeAt on Caravela Partner Hub v1", () => {
  it("gives unique candidates for every form control, identical across page loads", async () => {
    const portal = await startPartnerPortal({ port: 0, latencyMs: [0, 0] });
    try {
      const capture = async () => {
        const context = await browser.newContext({
          viewport: { width: 1280, height: 800 },
          deviceScaleFactor: 1,
        });
        await context.addCookies(
          await portal.session({ runId: "describe-stability", ui: "v1", mutation: null }),
        );
        const page = await context.newPage();
        await page.goto(`${portal.url}/deals/new`);
        const controls = page.locator("form input, form textarea, form button");
        const n = await controls.count();
        const out: { id: string; target: Target }[] = [];
        for (let i = 0; i < n; i++) {
          const el = controls.nth(i);
          if (!(await el.isVisible())) continue;
          await el.scrollIntoViewIfNeeded();
          const box = await el.boundingBox();
          if (!box) continue;
          const t = await describeAt(
            page,
            Math.round(box.x + box.width / 2),
            Math.round(box.y + box.height / 2),
          );
          const id = (await el.getAttribute("id")) ?? `#${i}`;
          const selector = (await el.getAttribute("id")) ? `[id="${id}"]` : `form button >> nth=${i}`;
          if (await el.getAttribute("id")) await expectCandidatesHit(page, t, selector);
          expect(t.candidates.length, id).toBeGreaterThan(0);
          out.push({ id, target: t });
        }
        await context.close();
        return out;
      };
      const first = await capture();
      const second = await capture();
      expect(first.length).toBeGreaterThanOrEqual(14);
      expect(second.map((x) => x.target.candidates)).toEqual(first.map((x) => x.target.candidates));
      const company = first.find((x) => x.target.fingerprint.label === "End customer company");
      expect(company?.target.candidates[0]).toEqual({ by: "testid", value: "nw-company-name" });
      const country = first.find(
        (x) => x.target.fingerprint.role === "combobox" && x.target.fingerprint.name === "Country",
      );
      expect(country?.target.candidates[0]).toEqual({
        by: "role",
        role: "combobox",
        name: "Country",
        exact: true,
      });
    } finally {
      await portal.close();
    }
  });
});

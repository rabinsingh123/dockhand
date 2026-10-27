import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createMutator,
  MUTATION_OPERATORS,
  type MutationOperator,
  operatorsFor,
  PARTNER_FIELDS,
  PARTNER_INSERTABLE_FIELDS,
  type PortalHandle,
  resolveOperators,
  SUPPLIER_FIELDS,
  SUPPLIER_INSERTABLE_FIELDS,
  startPartnerPortal,
  startSupplierPortal,
} from "../index.ts";
import { partnerSections } from "../shared/partnerSchema.ts";
import { supplierBaseSections, supplierSteps } from "../shared/supplierSchema.ts";
import {
  fillPartnerForm,
  launchBrowser,
  newRunId,
  openContext,
  pickOption,
  rootHtml,
  samplePartner,
} from "./helpers.ts";

describe("mutation engine (pure)", () => {
  it("exports every operator with its expected heal category", () => {
    expect(Object.fromEntries(MUTATION_OPERATORS.map((o) => [o.id, o.category]))).toEqual({
      label_synonym: "heal_deterministic_or_model",
      testid_churn: "heal_deterministic",
      button_rename: "heal_model",
      reorder_fields: "heal_deterministic",
      wrapper_divs: "heal_deterministic",
      class_churn: "heal_deterministic",
      id_churn: "heal_deterministic",
      placeholder_change: "heal_deterministic",
      insert_optional_field: "heal_deterministic",
      insert_required_field: "must_fail_safe",
      move_field_to_step: "heal_model",
      combobox_to_radio: "heal_model",
    });
    for (const o of MUTATION_OPERATORS) expect(o.description.length).toBeGreaterThan(10);
    expect(operatorsFor("partner")).not.toContain("move_field_to_step");
    expect(operatorsFor("supplier")).toContain("move_field_to_step");
  });

  it("picks 1-3 operators deterministically from the seed; explicit lists override", () => {
    for (let seed = 0; seed < 200; seed++) {
      const ops = resolveOperators("partner", { seed });
      expect(ops.length).toBeGreaterThanOrEqual(1);
      expect(ops.length).toBeLessThanOrEqual(3);
      expect(ops).not.toContain("move_field_to_step");
      expect(resolveOperators("partner", { seed })).toEqual(ops);
    }
    const seen = new Set<string>();
    for (let seed = 0; seed < 200; seed++)
      for (const op of resolveOperators("supplier", { seed })) seen.add(op);
    expect(seen.size).toBe(12);
    expect(
      resolveOperators("partner", { seed: 1, operators: ["move_field_to_step", "label_synonym"] }),
    ).toEqual(["label_synonym"]);
    expect(resolveOperators("partner", { seed: 1, operators: [] })).toEqual([]);
  });

  it("same seed gives the same plan; a different seed gives a different one", () => {
    const all = operatorsFor("partner");
    const a = createMutator("partner", { seed: 11, operators: all });
    const b = createMutator("partner", { seed: 11, operators: all });
    const c = createMutator("partner", { seed: 12, operators: all });
    for (const base of ["nw-company-name", "nw-submit", "nw-country"])
      expect(a.testid(base)).toEqual(b.testid(base));
    expect(a.cls("btn")).toBe(b.cls("btn"));
    expect(a.id("company-name")).toBe(b.id("company-name"));
    expect(a.cls("btn")).not.toBe(c.cls("btn"));
    expect(JSON.stringify(partnerSections("v1", a))).toBe(JSON.stringify(partnerSections("v1", b)));
    expect(JSON.stringify(partnerSections("v1", a))).not.toBe(JSON.stringify(partnerSections("v1", c)));
  });

  it("insert_required_field always adds Partner tier (Gold/Silver/Bronze) right after Product", () => {
    for (const version of ["v1", "v2"] as const) {
      for (const seed of [0, 1, 99]) {
        const fields = partnerSections(
          version,
          createMutator("partner", { seed, operators: ["insert_required_field"] }),
        ).flatMap((s) => s.fields);
        const idx = fields.findIndex((f) => f.key === "partnerTier");
        expect(fields[idx - 1]?.key).toBe("product");
        expect(fields[idx]).toMatchObject({
          kind: "combobox",
          required: true,
          options: ["Gold", "Silver", "Bronze"],
        });
      }
    }
  });

  it("move_field_to_step moves exactly one field to a different wizard step", () => {
    const stepOf = (steps: ReturnType<typeof supplierSteps>) =>
      new Map(
        steps.flatMap((s) => s.sections.flatMap((sec) => sec.fields.map((f) => [f.key, s.key] as const))),
      );
    const base = stepOf(supplierSteps("acme", createMutator("supplier", null)));
    for (const seed of [1, 2, 3, 4, 5]) {
      const moved = stepOf(
        supplierSteps("acme", createMutator("supplier", { seed, operators: ["move_field_to_step"] })),
      );
      const changed = [...base.keys()].filter((k) => base.get(k) !== moved.get(k));
      expect(changed).toHaveLength(1);
    }
  });

  it("exports canonical field catalogs", () => {
    expect(PARTNER_FIELDS.map((f) => f.key)).toEqual([
      "companyName",
      "companyWebsite",
      "country",
      "city",
      "contactName",
      "contactEmail",
      "contactPhone",
      "product",
      "seats",
      "estimatedValue",
      "expectedCloseDate",
      "referralPartner",
      "notes",
      "consent",
    ]);
    expect(PARTNER_FIELDS.find((f) => f.key === "product")).toMatchObject({
      type: "combobox",
      required: true,
    });
    expect(PARTNER_INSERTABLE_FIELDS.find((f) => f.key === "partnerTier")?.insertedBy).toBe(
      "insert_required_field",
    );
    const supplierKeys = SUPPLIER_FIELDS.map((f) => f.key);
    expect(new Set(supplierKeys).size).toBe(supplierKeys.length);
    expect(SUPPLIER_FIELDS.find((f) => f.key === "dunsNumber")?.tenants).toEqual(["globex"]);
    expect(SUPPLIER_FIELDS.find((f) => f.key === "remitCity")?.showWhen).toEqual({
      key: "remitSameAsAddress",
      equals: false,
    });
    expect(SUPPLIER_FIELDS.find((f) => f.key === "w9File")).toMatchObject({
      type: "file",
      required: true,
      step: "compliance",
    });
    expect(SUPPLIER_INSERTABLE_FIELDS.map((f) => f.key)).toContain("supplierCategory");
    // Both tenants expose the same canonical keys apart from globex's optional D-U-N-S number.
    const keys = (t: "acme" | "globex") =>
      supplierBaseSections(t)
        .flatMap((s) => s.fields.map((f) => f.key))
        .sort();
    expect(keys("globex").filter((k) => k !== "dunsNumber")).toEqual(keys("acme"));
  });
});

describe("mutations in the browser", () => {
  let browser: Browser;
  let partner: PortalHandle;
  let supplier: PortalHandle;

  beforeAll(async () => {
    [browser, partner, supplier] = await Promise.all([
      launchBrowser(),
      startPartnerPortal({ port: 0, latencyMs: [50, 100] }),
      startSupplierPortal({ port: 0, latencyMs: [50, 100] }),
    ]);
  });

  afterAll(async () => {
    await browser?.close();
    await partner?.close();
    await supplier?.close();
  });

  async function formHtml(
    mutation: { seed: number; operators?: MutationOperator[] },
    ui: "v1" | "v2" = "v1",
  ) {
    const { context, page } = await openContext(browser, partner, { ui, mutation, runId: newRunId("dom") });
    try {
      await page.goto(`${partner.url}/deals/new`);
      return await rootHtml(page);
    } finally {
      await context.close();
    }
  }

  it("same seed renders an identical DOM; another seed does not", async () => {
    const all = operatorsFor("partner");
    expect(await formHtml({ seed: 1234 })).toBe(await formHtml({ seed: 1234 }));
    const full = await formHtml({ seed: 77, operators: all });
    expect(await formHtml({ seed: 77, operators: all })).toBe(full);
    expect(await formHtml({ seed: 78, operators: all })).not.toBe(full);
    expect(await formHtml({ seed: 77, operators: all }, "v2")).toBe(
      await formHtml({ seed: 77, operators: all }, "v2"),
    );
  });

  it("testid_churn removes every v1 testid but the form still works by label", async () => {
    const runId = newRunId("churn");
    const { context, page } = await openContext(browser, partner, {
      ui: "v1",
      runId,
      mutation: { seed: 3, operators: ["testid_churn"] },
    });
    try {
      await page.goto(`${partner.url}/deals/new`);
      expect(await page.locator('[data-testid^="nw-"]').count()).toBe(0);
      expect(await page.locator("[data-testid]").count()).toBeGreaterThan(0);
      await fillPartnerForm(page, samplePartner(partner, { companyName: "Churn Test S.A." }));
      await page.getByRole("button", { name: "Submit registration", exact: true }).click();
      await page.waitForURL(/\/deals\/NW-REG-\d{5}$/);
      expect(partner.submissions({ runId })[0]?.mutation).toEqual({ seed: 3, operators: ["testid_churn"] });
    } finally {
      await context.close();
    }
  });

  it("insert_required_field blocks submission until Partner tier is filled (client and server)", async () => {
    const runId = newRunId("req");
    const mutation = { seed: 21, operators: ["insert_required_field"] as MutationOperator[] };
    const { context, page } = await openContext(browser, partner, { ui: "v1", runId, mutation });
    try {
      await page.goto(`${partner.url}/deals/new`);
      await fillPartnerForm(page, samplePartner(partner, { companyName: "Tier Test Ltda." }));
      await page.getByRole("button", { name: "Submit registration", exact: true }).click();
      await page.getByTestId("nw-error-summary").waitFor();
      expect(await page.getByTestId("nw-error-summary").textContent()).toContain("Partner tier is required.");
      const tier = page.getByRole("combobox", { name: "Partner tier", exact: true });
      expect(await tier.getAttribute("aria-invalid")).toBe("true");
      expect(new URL(page.url()).pathname).toBe("/deals/new");
      expect(partner.submissions({ runId })).toHaveLength(0);

      await pickOption(page, "Partner tier", "Gold");
      await page.getByRole("button", { name: "Submit registration", exact: true }).click();
      await page.waitForURL(/\/deals\/NW-REG-\d{5}$/);
      expect(await page.locator('dd[data-field="partnerTier"]').textContent()).toBe("Gold");
      expect(partner.submissions({ runId })[0]?.fields.partnerTier).toBe("Gold");
    } finally {
      await context.close();
    }

    // The server enforces it too, for contexts that rendered the mutation.
    const [cookie] = await partner.session({ runId: `${runId}-api`, mutation });
    if (!cookie) throw new Error("no cookie");
    const body = {
      companyName: "Tier API Ltda.",
      country: "Peru",
      city: "Lima",
      contactName: "Rosa Quispe",
      contactEmail: "rosa@tier.example",
      product: "Tidewater Cloud Starter",
      seats: "5",
      expectedCloseDate: "2099-01-01",
      consent: true,
    };
    const res = await fetch(`${partner.url}/api/deals`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${cookie.name}=${cookie.value}` },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { fieldErrors: Record<string, string> };
    expect(Object.keys(json.fieldErrors)).toEqual(["partnerTier"]);
  });

  it("class_churn rewrites every class but keeps the styling", async () => {
    const styleOf = async (operators: MutationOperator[]) => {
      const { context, page } = await openContext(browser, partner, {
        ui: "v1",
        runId: newRunId("cls"),
        mutation: { seed: 4, operators },
      });
      try {
        await page.goto(`${partner.url}/deals/new`);
        const button = page.getByRole("button", { name: "Submit registration", exact: true });
        return {
          classes: await button.getAttribute("class"),
          style: await button.evaluate((el) => {
            const s = getComputedStyle(el);
            return [s.backgroundColor, s.color, s.height, s.borderRadius, s.fontWeight].join("|");
          }),
          inputHeight: await page
            .getByLabel("City", { exact: true })
            .evaluate((el) => getComputedStyle(el).height),
        };
      } finally {
        await context.close();
      }
    };
    const plain = await styleOf([]);
    const churned = await styleOf(["class_churn", "wrapper_divs", "id_churn"]);
    expect(plain.classes).toBe("btn btn-primary");
    expect(churned.classes).not.toContain("btn");
    expect(churned.style).toBe(plain.style);
    expect(churned.inputHeight).toBe(plain.inputHeight);
  });

  it("every operator renders cleanly on both portals", async () => {
    for (const op of operatorsFor("partner")) {
      for (const ui of ["v1", "v2"] as const) {
        const { context, page, errors } = await openContext(browser, partner, {
          ui,
          runId: newRunId(op),
          mutation: { seed: 8, operators: [op] },
        });
        try {
          await page.goto(`${partner.url}/deals/new`);
          await page.locator("form").waitFor();
          expect(errors, `${op} on partner ${ui}`).toEqual([]);
          expect(await page.locator("input, textarea").count()).toBeGreaterThan(12);
          expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);
        } finally {
          await context.close();
        }
      }
    }
    for (const op of operatorsFor("supplier")) {
      const { context, page, errors } = await openContext(browser, supplier, {
        runId: newRunId(op),
        mutation: { seed: 8, operators: [op] },
      });
      try {
        await page.goto(`${supplier.url}/t/acme/invite/ACME-7731`);
        await page
          .locator("button")
          .filter({ hasText: /registration|started/i })
          .first()
          .click();
        await page.waitForURL(/\/register\/company$/);
        await page.locator("form").waitFor();
        expect(errors, `${op} on supplier`).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);
      } finally {
        await context.close();
      }
    }
  });
});

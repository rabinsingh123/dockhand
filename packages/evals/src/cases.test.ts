import { readFileSync } from "node:fs";
import { Skill } from "@dockhand/core";
import { MUTATION_OPERATORS, operatorsFor, PARTNER_FIELDS, PARTNER_PRODUCTS } from "@dockhand/portals";
import { describe, expect, it } from "vitest";
import { generateCases, withRepAnswer } from "./cases.ts";
import { PORTALS } from "./portals.ts";

const fixture = (name: string) =>
  Skill.parse(JSON.parse(readFileSync(new URL(`./__fixtures__/${name}.json`, import.meta.url), "utf8")));
const caravela = fixture("caravela_register_deal");
const supplier = fixture("acme_supplier_registration");
const TODAY = "2026-10-27";

describe("generateCases", () => {
  it("is deterministic per seed, and case i does not depend on n", () => {
    const a = generateCases("replay", caravela, 12, 7, { today: TODAY });
    expect(generateCases("replay", caravela, 12, 7, { today: TODAY })).toEqual(a);
    expect(generateCases("replay", caravela, 5, 7, { today: TODAY })).toEqual(a.slice(0, 5));
    const other = generateCases("replay", caravela, 12, 8, { today: TODAY });
    expect(other.map((c) => c.params.company_name)).not.toEqual(a.map((c) => c.params.company_name));
    expect(new Set(a.map((c) => c.id)).size).toBe(12);
    expect(
      a.every((c) => c.portal.runId === c.id && c.portal.ui === "v1" && c.portal.mutation === null),
    ).toBe(true);
  });

  it("puts every synthetic email and website under the reserved .example TLD", () => {
    const values = [
      ...generateCases("replay", caravela, 30, 1, { today: TODAY }),
      ...generateCases("replay", supplier, 30, 1, { today: TODAY }),
    ].flatMap((c) => Object.values(c.params).filter((v): v is string => typeof v === "string"));
    const domains = values.filter((v) => /@|^[a-z0-9-]+\.[a-z.]+$/.test(v)).map((v) => v.split("@").pop());
    expect(domains.length).toBeGreaterThan(30);
    expect(domains.filter((d) => !d?.endsWith(".example"))).toEqual([]);
  });

  it("normalizes expected fields: ISO future dates, plain numbers, catalog options, booleans", () => {
    const cases = generateCases("replay", caravela, 60, 1, { today: TODAY });
    const keys = new Set(PARTNER_FIELDS.map((f) => f.key));
    for (const c of cases) {
      const e = c.expected;
      for (const k of Object.keys(e)) expect(keys.has(k)).toBe(true);
      expect(e.expectedCloseDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect((e.expectedCloseDate as string) > TODAY).toBe(true);
      expect(e.seats).toMatch(/^\d+$/);
      expect(Number(e.seats)).toBeGreaterThanOrEqual(1);
      if (e.estimatedValue !== undefined) expect(e.estimatedValue).toMatch(/^\d+(\.\d{1,2})?$/);
      expect(PARTNER_PRODUCTS).toContain(e.product);
      expect(e.consent).toBe("true");
      expect((e.companyName as string).length).toBeLessThanOrEqual(120);
      // The param and the expected value agree; an omitted optional param means an absent field.
      expect(e.companyName).toBe(c.params.company_name);
      expect(e.seats).toBe(String(c.params.seats));
      expect("referralPartner" in e).toBe(c.params.referral_partner !== undefined);
    }
    const names = cases.map((c) => c.expected.companyName as string);
    expect(names.some((n) => /[áâãàçéêíóôõúÁÂÃÇÉÍÓÚ]/.test(n))).toBe(true);
    expect(names.some((n) => n.length > 60)).toBe(true);
    expect(cases.some((c) => c.params.company_website === undefined)).toBe(true);
  });

  it("covers every applicable mutation operator with k seeds and the operator's expected category", () => {
    const ops = operatorsFor("partner");
    const cases = generateCases("mutation", caravela, 22, 3, { today: TODAY });
    const k = Math.ceil(22 / ops.length);
    expect(cases).toHaveLength(ops.length * k);
    for (const op of ops) {
      const mine = cases.filter((c) => c.portal.mutation?.operators?.[0] === op);
      expect(mine).toHaveLength(k);
      const category = MUTATION_OPERATORS.find((o) => o.id === op)?.category;
      expect(mine.every((c) => c.expectedCategory === category)).toBe(true);
      expect(new Set(mine.map((c) => c.portal.mutation?.seed)).size).toBe(k);
    }
    expect(cases.some((c) => c.portal.mutation?.operators?.includes("move_field_to_step"))).toBe(false);
  });

  it("repair covers ui v2 and the heal_model operators", () => {
    const cases = generateCases("repair", caravela, 6, 1, { today: TODAY });
    const groups = new Set(cases.map((c) => c.portal.mutation?.operators?.[0] ?? c.portal.ui));
    expect(groups).toEqual(new Set(["v2", "button_rename", "combobox_to_radio"]));
    const supplierGroups = new Set(
      generateCases("repair", supplier, 3, 1, { today: TODAY }).map((c) => c.portal.mutation?.operators?.[0]),
    );
    expect(supplierGroups).toEqual(new Set(["button_rename", "move_field_to_step", "combobox_to_radio"]));
  });

  it("supplier cases: file placeholders graded by filename, numbers plain, literal radios and boxes expected", () => {
    const [c] = generateCases("replay", supplier, 1, 2, { today: TODAY });
    if (!c) throw new Error("no case");
    expect(c.tenant).toBe("acme");
    expect(c.params.tenant).toBe("acme");
    expect(c.params.invite_code).toMatch(/^ACME-\d{4}$/);
    expect(c.params.w9_file).toMatchObject({ filename: "w9-sample.pdf" });
    expect(c.expected).toMatchObject({
      w9File: "w9-sample.pdf",
      coiFile: "insurance-certificate-sample.pdf",
      entityType: "LLC",
      conflictOfInterest: "No",
      diversity: "None of these",
      remitSameAsAddress: "true",
      bankConfirm: "true",
      codeOfConduct: "true",
    });
    expect(c.expected.yearFounded).toMatch(/^\d{4}$/);
    expect(c.expected.taxId).toMatch(/^\d{2}-\d{7}$/);
    expect(c.expected.legalName).toBe(c.params.legal_name);
  });

  it("withRepAnswer adds the answer param and the expected inserted field", () => {
    const [c] = generateCases("mutation", caravela, 11, 1, { today: TODAY }).filter(
      (x) => x.expectedCategory === "must_fail_safe",
    );
    if (!c) throw new Error("no must_fail_safe case");
    const tier = PORTALS.caravela.insertable.find((f) => f.key === "partnerTier");
    if (!tier) throw new Error("no partnerTier field");
    const answered = withRepAnswer(c, tier, "Gold");
    expect(answered.params.partner_tier).toBe("Gold");
    expect(answered.expected.partnerTier).toBe("Gold");
    expect(answered.portal.runId).toBe(answered.id);
    expect(answered.id).not.toBe(c.id);
  });
});

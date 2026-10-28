import { Skill, type Trace } from "@dockhand/core";
import { describe, expect, it } from "vitest";
import { PARTNER_PARAM_SPECS, PARTNER_PARAMS, partnerTrace, T } from "./__fixtures__/partner-trace.ts";
import {
  compile,
  generalizeId,
  generalizeIdFor,
  playwrightKey,
  rebaseSkill,
  slotParamName,
} from "./compile.ts";
import { renderTemplate } from "./template.ts";

const meta = {
  name: "register_partner_deal",
  title: "Register a deal on Caravela Partner Hub",
  params: PARTNER_PARAM_SPECS,
  createdFrom: { kind: "goal" as const, traceRunId: "01JTRACERUN0000000000000001" },
};

describe("compile: partner-portal trace", () => {
  const { skill, warnings } = compile(partnerTrace(), meta);

  it("matches the golden program", async () => {
    await expect(`${JSON.stringify({ skill, warnings }, null, 2)}\n`).toMatchFileSnapshot(
      "./__snapshots__/compile.partner.json.snap",
    );
  });

  it("is a valid skill once versioned", () => {
    expect(() => Skill.parse({ ...skill, version: 1, parentVersion: null })).not.toThrow();
  });

  it("collapses the messy run into one step per field, in first-touch order", () => {
    expect(skill.steps.map((s) => `${s.id} ${s.op} ${s.intent}`)).toEqual([
      "s1 goto Open /deals",
      "s2 click Click 'Register a deal'",
      "s3 waitFor Wait for /deals/new",
      "s4 fill Fill 'End customer company'",
      "s5 fill Fill 'Company website'",
      "s6 select Select 'Country'",
      "s7 fill Fill 'City'",
      "s8 fill Fill 'Contact full name'",
      "s9 fill Fill 'Contact email'",
      "s10 fill Fill 'Contact phone'",
      "s11 select Select 'Product'",
      "s12 fill Fill 'Seats'",
      "s13 fill Fill 'Estimated value (USD)'",
      "s14 fill Fill 'Expected close date'",
      "s15 fill Fill 'Notes'",
      "s16 check Check 'The end customer agreed to be contacted by Caravela'",
      "s17 click Click 'Submit registration'",
    ]);
  });

  it("templates every value, with formatters and normalized matches", () => {
    const values = Object.fromEntries(
      skill.steps.flatMap((s) =>
        s.op === "fill" ? [[s.id, s.value]] : s.op === "select" ? [[s.id, s.option]] : [],
      ),
    );
    expect(values).toEqual({
      s4: "{{company}}",
      s5: "{{website}}",
      s6: "{{country}}",
      s7: "{{city}}",
      s8: "{{contact_name}}",
      s9: "{{contact_email}}",
      s10: "{{contact_phone}}",
      s11: "{{product}}",
      s12: "{{seats}}",
      s13: "{{est_value}}",
      s14: "{{close_date|date:DD/MM/YYYY}}",
      s15: "{{notes}}",
    });
    const commit = skill.steps.at(-1);
    expect(commit).toMatchObject({ op: "click", commit: true, target: T.submit });
    expect(skill.steps.find((s) => s.id === "s16")).toMatchObject({ op: "check", checked: true });
  });

  it("derives the success check from the ID that appears only after the commit", () => {
    expect(skill.success).toEqual({
      urlIncludes: "/deals/NW-REG-",
      textPattern: "NW-REG-\\d{5}",
      extract: [{ name: "confirmation_id", regex: "NW-REG-\\d{5}" }],
    });
  });

  it("keeps only the params the program uses", () => {
    expect(skill.params.map((p) => p.name)).toEqual(Object.keys(PARTNER_PARAMS));
  });

  it("warns about the misclick and the two values typed differently from the params", () => {
    expect(warnings.map((w) => `${w.code}@${w.stepIdx}`)).toEqual([
      "DROPPED_ACTION@2",
      "ROUNDTRIP_MISMATCH@6",
      "ROUNDTRIP_MISMATCH@9",
    ]);
  });

  it("round-trips: rendering the templates with the run's params gives what the run entered", () => {
    const entered = skill.steps.flatMap((s) =>
      s.op === "fill"
        ? [renderTemplate(s.value, PARTNER_PARAMS)]
        : s.op === "select"
          ? [renderTemplate(s.option, PARTNER_PARAMS)]
          : [],
    );
    expect(entered).toContain("15/03/2027");
    expect(entered).toContain("Tidewater Cloud Business");
  });
});

describe("compile: edge rules", () => {
  const base = partnerTrace();

  it("keeps a literal (with a warning) when no param matches", () => {
    const trace: Trace = { ...base, params: { ...base.params, notes: "something else" } };
    const { skill, warnings } = compile(trace, meta);
    expect(skill.steps.find((s) => s.id === "s15")).toMatchObject({
      op: "fill",
      value: "Pilot for the finance team",
    });
    expect(warnings).toContainEqual({
      stepIdx: 14,
      code: "LITERAL_VALUE",
      detail: `will always enter "Pilot for the finance team" in 'Notes'`,
    });
    expect(skill.params.map((p) => p.name)).not.toContain("notes");
  });

  it("flags two params sharing a value and picks the one named like the field", () => {
    const trace: Trace = { ...base, params: { ...base.params, referral_name: "Mariana Costa" } };
    const { skill, warnings } = compile(trace, meta);
    expect(skill.steps.find((s) => s.id === "s8")).toMatchObject({ value: "{{contact_name}}" });
    expect(warnings.find((w) => w.code === "AMBIGUOUS_PARAM")).toMatchObject({ stepIdx: 7 });
  });

  it("drops a first submit that bounced on validation and keeps the retry", () => {
    const steps = base.steps.map((s) =>
      s.tags.includes("blocked") ? { ...s, tags: ["commit" as const] } : s,
    );
    const { skill, warnings } = compile({ ...base, steps }, meta);
    expect(skill.steps.filter((s) => s.op === "click" && s.commit)).toHaveLength(1);
    expect(warnings.some((w) => w.code === "DROPPED_ACTION" && w.detail.startsWith("submit attempt"))).toBe(
      true,
    );
  });

  it("compiles uploads from the upload tag, absorbing the chooser click", () => {
    const fileInput = {
      candidates: [{ by: "label" as const, value: "W-9 form", exact: true }],
      fingerprint: { tag: "input", inputType: "file", label: "W-9 form", bbox: { x: 0, y: 0, w: 1, h: 1 } },
    };
    const chooser = {
      candidates: [{ by: "role" as const, role: "button", name: "Choose file for W-9 form", exact: true }],
      fingerprint: {
        tag: "button",
        role: "button",
        name: "Choose file for W-9 form",
        bbox: { x: 0, y: 0, w: 90, h: 30 },
      },
    };
    const at = base.steps[5] as Trace["steps"][number];
    const steps = [
      ...base.steps.slice(0, 6),
      { ...at, i: 100, action: { type: "click" as const, x: 45, y: 15 }, target: chooser, tags: [] },
      {
        ...at,
        i: 101,
        action: { type: "fn" as const, name: "attach_file" as const, args: { slot: "W-9 form" } },
        target: undefined,
        tags: ["upload" as const],
        upload: { slot: "W-9 form", target: fileInput },
      },
      ...base.steps.slice(6),
    ];
    const { skill } = compile({ ...base, steps, params: { ...base.params } }, meta);
    const upload = skill.steps.find((s) => s.op === "upload");
    expect(upload).toMatchObject({ fileParam: "w_9_form", target: fileInput });
    expect(skill.steps.some((s) => s.op === "click" && s.target === chooser)).toBe(false);
    expect(skill.params.find((p) => p.name === "w_9_form")).toMatchObject({ type: "file", required: true });
  });

  it("templates URL segments in goto and waitFor", () => {
    const trace: Trace = {
      ...base,
      startUrl: "http://127.0.0.1:4200/t/acme/invite/ACME-7731",
      params: { ...base.params, tenant: "acme", invite_code: "ACME-7731" },
      steps: base.steps.map((s, i) =>
        i === 0
          ? {
              ...s,
              urlBefore: "http://127.0.0.1:4200/t/acme/invite/ACME-7731",
              urlAfter: "http://127.0.0.1:4200/t/acme/register/company",
            }
          : s,
      ),
    };
    const { skill } = compile(trace, meta);
    expect(skill.steps[0]).toMatchObject({
      op: "goto",
      url: "http://127.0.0.1:4200/t/{{tenant}}/invite/{{invite_code}}",
    });
    expect(skill.steps[2]).toMatchObject({ op: "waitFor", urlIncludes: "/t/{{tenant}}/register/company" });
    expect(skill.params.map((p) => p.name)).toEqual(expect.arrayContaining(["tenant", "invite_code"]));
  });

  it("rebases goto URLs onto another origin", () => {
    const { skill } = compile(base, meta);
    const moved = rebaseSkill(skill, "http://127.0.0.1:59999/");
    expect(moved.steps[0]).toMatchObject({ op: "goto", url: "http://127.0.0.1:59999/deals" });
    expect(skill.steps[0]).toMatchObject({ url: "http://127.0.0.1:4100/deals" });
  });
});

describe("compile helpers", () => {
  it.each([
    ["NW-REG-48213", "NW-REG-\\d{5}"],
    ["SG-ACME-004211", "SG-ACME-\\d{6}"],
    ["AB12CD345", "AB\\d{2}CD\\d{3}"],
  ])("generalizeId(%s)", (token, regex) => {
    expect(generalizeId(token)).toBe(regex);
    expect(new RegExp(regex).test(token)).toBe(true);
  });

  it("keeps run values out of the ID check, so it holds for every tenant", () => {
    const regex = generalizeIdFor("SG-ACME-004211", { tenant: "acme", invite_code: "ACME-7731" });
    expect(regex).toBe(String.raw`SG-[A-Z]+-\d{6}`);
    expect(new RegExp(regex).test("SG-GLOBEX-120934")).toBe(true);
    expect(generalizeIdFor("NW-REG-48213", { company: "Rega" })).toBe(String.raw`NW-REG-\d{5}`);
  });

  it.each([
    [["ENTER"], "Enter"],
    [["CTRL", "A"], "Control+a"],
    [["shift", "TAB"], "Shift+Tab"],
  ])("playwrightKey(%j)", (keys, key) => {
    expect(playwrightKey(keys)).toBe(key);
  });

  it.each([
    ["W-9 form", "w_9_form"],
    ["coi", "coi"],
    ["2024 insurance", "file_2024_insurance"],
  ])("slotParamName(%s)", (slot, name) => {
    expect(slotParamName(slot)).toBe(name);
  });
});

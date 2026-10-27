import { describe, expect, it } from "vitest";
import { createLocalFakeGateway, promptText } from "./__fixtures__/fake-models.ts";
import { PARTNER_PARAM_SPECS, partnerTrace } from "./__fixtures__/partner-trace.ts";
import { annotateSkill, annotateSkillDetailed, applyRenames, type SkillAnnotation } from "./annotate.ts";
import { compile } from "./compile.ts";

const trace = partnerTrace();
const { skill: body } = compile(trace, {
  name: "register_partner_deal",
  title: "Register a deal on Caravela Partner Hub",
  params: PARTNER_PARAM_SPECS,
  createdFrom: { kind: "goal", traceRunId: trace.runId },
});

function annotation(over: Partial<SkillAnnotation> = {}): SkillAnnotation {
  return {
    title: "Register a partner deal",
    steps: [
      { id: "s4", intent: "Enter the end customer's legal company name" },
      { id: "s17", intent: "Submit the registration" },
      { id: "s99", intent: "Invented step" },
    ],
    params: [
      {
        name: "company",
        newName: "customer_company",
        description: "Legal name of the end customer",
        type: "string",
      },
      { name: "seats", newName: "seats", description: "Number of seats", type: "date" },
      { name: "close_date", newName: "close_date", description: "Expected close date", type: "date" },
    ],
    success: {
      description: "The confirmation page shows the registration ID",
      textPattern: null,
      idRegex: "NW-REG-\\d+",
      idName: "registration_id",
    },
    ...over,
  };
}

const ctx = { runId: "01JRUN", timeoutMs: 30_000 };

describe("annotateSkill", () => {
  it("makes one compile_annotate call to muse-spark-1.3 with the program and the confirmation page", async () => {
    const models = createLocalFakeGateway(() => annotation());
    await annotateSkill(body, trace, null, models, ctx);
    expect(models.calls).toHaveLength(1);
    const call = models.calls[0];
    expect(call?.req.model).toBe("muse-spark-1.3");
    expect(call?.ctx).toMatchObject({ purpose: "compile_annotate", runId: "01JRUN" });
    const prompt = promptText(call?.req as never);
    expect(prompt).toContain('"id": "s17"');
    expect(prompt).toContain("NW-REG-48213");
  });

  it("applies intents, descriptions and a rename consistently, and rejects what does not verify", async () => {
    const models = createLocalFakeGateway(() => annotation());
    const r = await annotateSkillDetailed(body, trace, null, models, ctx);
    expect(r.body.title).toBe("Register a partner deal");
    expect(r.body.steps.find((s) => s.id === "s4")).toMatchObject({
      intent: "Enter the end customer's legal company name",
      value: "{{customer_company}}",
    });
    expect(r.body.params.map((p) => p.name)).toContain("customer_company");
    expect(r.body.params.map((p) => p.name)).not.toContain("company");
    expect(r.body.params.find((p) => p.name === "seats")?.type).toBe("number");
    expect(r.rejected).toEqual(
      expect.arrayContaining([
        "intent for unknown step s99",
        "type seats: date does not fit the run's value",
      ]),
    );
    expect(r.body.success).toEqual({
      urlIncludes: "/deals/NW-REG-",
      textPattern: "NW-REG-\\d+",
      extract: [{ name: "registration_id", regex: "NW-REG-\\d+" }],
    });
    expect(r.successDescription).toBe("The confirmation page shows the registration ID");
  });

  it("rejects all renames when two params would collide", async () => {
    const models = createLocalFakeGateway(() =>
      annotation({
        params: [
          { name: "city", newName: "company", description: "City", type: "string" },
          { name: "website", newName: "site", description: "Website", type: "string" },
        ],
      }),
    );
    const r = await annotateSkillDetailed(body, trace, null, models, ctx);
    expect(r.body.params.map((p) => p.name)).toEqual(body.params.map((p) => p.name));
    expect(r.rejected).toContain("renames: two params would share a name");
    expect(r.body.steps.find((s) => s.id === "s5")).toMatchObject({ value: "{{website}}" });
  });

  it("rejects an ID regex that matches more than one token and a text pattern not on the page", async () => {
    const models = createLocalFakeGateway(() =>
      annotation({
        success: { description: "", textPattern: "Order placed", idRegex: "\\d{2}", idName: null },
      }),
    );
    const r = await annotateSkillDetailed(body, trace, null, models, ctx);
    expect(r.body.success).toEqual(body.success);
    expect(r.rejected.some((x) => x.startsWith("id regex \\d{2}"))).toBe(true);
    expect(r.rejected).toContain("text pattern Order placed: does not match the confirmation page");
  });

  it("returns the body unchanged when the model call fails or there is no gateway", async () => {
    const failing = createLocalFakeGateway(() => {
      throw new Error("MODEL_ERROR: no key");
    });
    const r = await annotateSkillDetailed(body, trace, null, failing, ctx);
    expect(r.body).toBe(body);
    expect(r.skipped).toContain("no key");
    expect(await annotateSkill(body, trace, null, null, ctx)).toBe(body);
  });

  it("returns the body unchanged when the output does not validate", async () => {
    const models = createLocalFakeGateway(() => ({ title: 3 }));
    expect(await annotateSkill(body, trace, null, models, ctx)).toBe(body);
  });
});

describe("applyRenames", () => {
  it("refuses a rename that leaves a template pointing at a missing param", () => {
    const broken = {
      ...body,
      steps: [...body.steps, { ...body.steps[3], id: "s50", value: "{{ghost}}" } as never],
    };
    const r = applyRenames(broken, { company: "customer_company" });
    expect(r).toEqual({ ok: false, reason: "the skill would reference missing param ghost" });
  });
});

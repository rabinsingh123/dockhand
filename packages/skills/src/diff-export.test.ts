import type { SkillBody, Step, Target } from "@dockhand/core";
import { describe, expect, it } from "vitest";
import { PARTNER_PARAM_SPECS, partnerTrace } from "./__fixtures__/partner-trace.ts";
import { compile } from "./compile.ts";
import { diffSkills } from "./diff.ts";
import { exportPlaywright } from "./export.ts";

const trace = partnerTrace();
const v1: SkillBody = compile(trace, {
  name: "register_partner_deal",
  title: "Register a deal on Caravela Partner Hub",
  params: PARTNER_PARAM_SPECS,
  createdFrom: { kind: "goal", traceRunId: trace.runId },
}).skill;

function retarget(step: Step, name: string, testId?: string): Step {
  const old = (step.op === "select" ? step.trigger : (step as { target: Target }).target) as Target;
  const target: Target = {
    candidates: [
      ...(testId ? [{ by: "testid" as const, value: testId }] : []),
      { by: "role", role: old.fingerprint.role ?? "button", name, exact: true },
    ],
    fingerprint: { ...old.fingerprint, name, label: old.fingerprint.label ? name : undefined, testId },
  };
  return step.op === "select" ? { ...step, trigger: target } : ({ ...step, target } as Step);
}

/** v2 as a run on the redesigned portal would patch it. */
function patchedV2(): SkillBody {
  const steps = v1.steps.map((s) => {
    if (s.id === "s2") return retarget(s, "Register a deal", "reg-new-registration");
    if (s.id === "s11") return retarget(s, "Solution", "reg-solution");
    if (s.id === "s17") return retarget(s, "Register opportunity");
    return s;
  });
  const tier: Step = {
    id: "s18",
    op: "select",
    intent: "Select 'Partner tier'",
    trigger: {
      candidates: [{ by: "role", role: "combobox", name: "Partner tier", exact: true }],
      fingerprint: {
        tag: "input",
        role: "combobox",
        name: "Partner tier",
        label: "Partner tier",
        bbox: { x: 0, y: 0, w: 1, h: 1 },
      },
    },
    option: "{{partner_tier}}",
  };
  const swapped = [...steps.slice(0, 3), steps[4] as Step, steps[3] as Step, ...steps.slice(5)];
  return {
    ...v1,
    params: [
      ...v1.params,
      {
        name: "partner_tier",
        type: "enum",
        required: true,
        description: "Partner tier",
        enumValues: ["Gold", "Silver", "Bronze"],
      },
    ],
    steps: [...swapped.slice(0, -1), tier, swapped.at(-1) as Step],
  };
}

describe("diffSkills", () => {
  it("describes heals, the asked param, inserted and moved steps with labels, not selectors", () => {
    const lines = diffSkills(v1, patchedV2(), [
      { stepId: "s2", rung: "fallback" },
      { stepId: "s11", rung: "open_weights" },
      { stepId: "s17", rung: "computer_use" },
      { stepId: "s18", rung: "ask_rep" },
    ]);
    expect(lines).toEqual([
      "new param partner_tier (asked the rep)",
      "step 2: new selectors for 'Register a deal' (healed: fallback selector)",
      "step 5 moved (was step 4)",
      "step 11: 'Product' → 'Solution' (healed: open-weights model)",
      "new step 17: 'Select 'Partner tier'' (asked the rep)",
      "step 18: 'Submit registration' → 'Register opportunity' (healed: computer use)",
    ]);
  });

  it("says nothing for identical skills and reports removals", () => {
    expect(diffSkills(v1, v1)).toEqual([]);
    const fewer = {
      ...v1,
      steps: v1.steps.filter((s) => s.id !== "s15"),
      params: v1.params.filter((p) => p.name !== "notes"),
    };
    expect(diffSkills(v1, fewer)).toEqual(["param notes removed", "step 15 removed: 'Fill 'Notes''"]);
  });
});

describe("exportPlaywright", () => {
  it("is deterministic, readable TypeScript with the candidates in rank order", async () => {
    const code = exportPlaywright({ ...v1, version: 1 });
    expect(exportPlaywright({ ...v1, version: 1 })).toBe(code);
    expect(code).toContain('page.getByTestId("nw-company-name"),');
    expect(code).toContain('fmtDate(p.close_date, "DD/MM/YYYY")');
    expect(code).toContain('page.getByRole("option", { name: String(p.country), exact: true }).click();');
    expect(code).toContain("(commit: Dockhand asks the rep before this click)");
    await expect(code).toMatchFileSnapshot("./__snapshots__/export.partner.ts.snap");
  });
});

import type { Step, StepResult } from "@dockhand/core";
import { describe, expect, it } from "vitest";
import { cardBody, repairSummary, stopReason } from "./messages.ts";

const target = (name: string) => ({
  candidates: [],
  fingerprint: { tag: "input", name, label: name, bbox: { x: 0, y: 0, w: 0, h: 0 } },
});
const fill = (id: string, name: string): Step => ({
  id,
  intent: "",
  op: "fill",
  target: target(name),
  value: "x",
});
const click = (id: string, name: string): Step => ({ id, intent: "", op: "click", target: target(name) });
const healed = (stepId: string, rung: StepResult["rung"]): StepResult => ({
  idx: 0,
  stepId,
  status: "healed",
  ...(rung ? { rung } : {}),
  ms: 1,
});

describe("repairSummary", () => {
  it("groups repairs by rung, cheapest first, naming what changed", () => {
    const before = [fill("s1", "City"), fill("s2", "Product"), click("s3", "Submit registration")];
    const after = [
      fill("s1", "City"),
      fill("s2", "Solution"),
      click("s3", "Register opportunity"),
      fill("s4", "Partner tier"),
    ];
    const results = [
      healed("s1", "fallback"),
      healed("s2", "open_weights"),
      healed("s3", "open_weights"),
      healed("s4", "ask_rep"),
      { idx: 4, stepId: "s5", status: "ok" as const, ms: 1 },
    ];
    expect(repairSummary(results, before, after)).toBe(
      "4 steps repaired: 1 found again for free, 2 by Muse Spark Open ('Product' → 'Solution', 'Submit registration' → 'Register opportunity'), 1 from your answer ('Partner tier')",
    );
    expect(repairSummary([{ idx: 0, stepId: "s1", status: "ok", ms: 1 }], before, before)).toBeNull();
  });
});

describe("rep-facing text", () => {
  it("never shows step ids or raw runner details", () => {
    expect(
      stopReason("Caravela Partner Hub", "STEP_NOT_FOUND", "s17 (Click 'Submit'): waited 8000 ms: x"),
    ).toBe("Caravela Partner Hub changed and I couldn't repair a step (\"Click 'Submit'\")");
  });

  it("keeps the instructions at the end of a card however long the values are", () => {
    const body = cardBody(
      ["Head"],
      Array.from({ length: 40 }, (_, i) => `• Field ${i}: ${"x".repeat(200)}`),
      ["Tail"],
    );
    expect([...body].length).toBeLessThanOrEqual(1024);
    expect(body.endsWith("Tail")).toBe(true);
    expect(body).toMatch(/…and \d+ more/);
  });
});

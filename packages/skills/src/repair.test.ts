import {
  type ComputerUseModel,
  type CuRunInput,
  type CuRunResult,
  createMemoryArtifactStore,
  type RepairRequest,
  type RunComputerUse,
  type Skill,
  type Trace,
} from "@dockhand/core";
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { createLocalFakeGateway } from "./__fixtures__/fake-models.ts";
import { PARTNER_PARAM_SPECS, PARTNER_PARAMS, partnerTrace, T } from "./__fixtures__/partner-trace.ts";
import { compile } from "./compile.ts";
import { createCuRepairer, createOpenWeightsRepairer } from "./repair.ts";

const trace = partnerTrace();
const skill: Skill = {
  ...compile(trace, {
    name: "register_partner_deal",
    title: "Register a deal on Caravela Partner Hub",
    params: PARTNER_PARAM_SPECS,
    createdFrom: { kind: "goal", traceRunId: trace.runId },
  }).skill,
  version: 1,
  parentVersion: null,
};

const model: ComputerUseModel = {
  provider: "scripted",
  model: "scripted",
  open() {
    throw new Error("not used");
  },
};
const hooks = {
  approveCommit: async () => "approved" as const,
  approveSafety: async () => "rejected" as const,
};
const ctx = { purpose: "heal_match" as const, runId: "01JRUN", stepIdx: 0, timeoutMs: 60_000 };
const page = {} as Page;

function request(stepId: string): RepairRequest {
  return {
    page,
    runId: "01JRUN",
    skill,
    stepIdx: skill.steps.findIndex((s) => s.id === stepId),
    params: { ...PARTNER_PARAMS, company: "Umbu Energia Ltda." },
    error: { code: "STEP_NOT_FOUND", message: "no candidate matched" },
  };
}

/** A sub-trace where the model clicked the company field and typed `typed`. */
function subTrace(typed: string): Trace {
  const url = "http://127.0.0.1:4100/deals/new";
  return {
    runId: "01JRUN",
    portalId: "partner",
    startUrl: url,
    viewport: { w: 1280, h: 800 },
    params: { ...PARTNER_PARAMS, company: "Umbu Energia Ltda." },
    steps: [
      {
        i: 0,
        ts: 1,
        action: { type: "click", x: 500, y: 280 },
        target: T.company,
        fieldValueAfter: "",
        urlBefore: url,
        urlAfter: url,
        tags: [],
      },
      {
        i: 1,
        ts: 2,
        action: { type: "type", text: typed },
        target: T.company,
        fieldValueAfter: typed,
        urlBefore: url,
        urlAfter: url,
        tags: [],
      },
    ],
    final: {
      url,
      text: "",
      screenshot: { id: "a", sha256: "b", mime: "image/png", bytes: 1, relPath: "a.png" },
    },
    outcome: "done",
  };
}

function fakeCu(result: (input: CuRunInput) => Partial<CuRunResult>) {
  const inputs: CuRunInput[] = [];
  const run: RunComputerUse = async (_model, input) => {
    inputs.push(input);
    return { trace: subTrace(""), outcome: "done", ...result(input) };
  };
  return { run, inputs };
}

const base = {
  model,
  artifacts: createMemoryArtifactStore(),
  writeGuard: { origins: ["http://127.0.0.1:4100"], allow: [] },
};

describe("createCuRepairer", () => {
  it("runs a commit step in propose_only mode and turns the proposal into an approved-later click", async () => {
    const proposed = { ...T.submit, fingerprint: { ...T.submit.fingerprint, name: "Register opportunity" } };
    const cu = fakeCu(() => ({ proposed }));
    const r = await createCuRepairer({ ...base, runComputerUse: cu.run })(request("s17"), hooks, ctx);
    expect(r).toMatchObject({ ok: true, rung: "computer_use" });
    expect(r.ok && r.steps).toEqual([
      { id: "s17", intent: "Click 'Submit registration'", op: "click", target: proposed, commit: true },
    ]);
    const input = cu.inputs[0] as CuRunInput;
    expect(input.commitPolicy).toBe("propose_only");
    expect(input.limits).toMatchObject({ maxActions: 8, maxCostUsd: 0.5 });
    expect(input.guidance).toEqual(["Click 'Submit registration'"]);
    expect(input.goal).toContain("propose_target");
  });

  it("fails a commit repair that proposed nothing", async () => {
    const cu = fakeCu(() => ({ outcome: "budget_exceeded", message: "ran out of actions" }));
    const r = await createCuRepairer({ ...base, runComputerUse: cu.run })(request("s17"), hooks, ctx);
    expect(r).toEqual({ ok: false, rung: "computer_use", reason: "ran out of actions", costUsd: 0 });
  });

  it("compiles a fill repair into a templated step, with a narrow goal and the gate on", async () => {
    const cu = fakeCu(() => ({ trace: subTrace("Umbu Energia Ltda.") }));
    const r = await createCuRepairer({ ...base, runComputerUse: cu.run })(request("s4"), hooks, ctx);
    expect(r.ok).toBe(true);
    expect(r.ok && r.steps).toEqual([
      expect.objectContaining({ op: "fill", value: "{{company}}", target: T.company }),
    ]);
    const input = cu.inputs[0] as CuRunInput;
    expect(input.commitPolicy).toBe("gate");
    expect(input.goal).toContain('Enter exactly "Umbu Energia Ltda."');
    expect(input.commitHints).toEqual(["Submit registration"]);
  });

  it("rejects a repair that typed something other than the param", async () => {
    const cu = fakeCu(() => ({ trace: subTrace("Umbu Energia") }));
    const r = await createCuRepairer({ ...base, runComputerUse: cu.run })(request("s4"), hooks, ctx);
    expect(r).toMatchObject({ ok: false, rung: "computer_use" });
    expect(!r.ok && r.reason).toMatch(/did not enter company|not a param/);
  });
});

describe("createOpenWeightsRepairer", () => {
  it("skips without a call when no open-weights provider is configured", async () => {
    const models = createLocalFakeGateway(() => ({ index: 1, confidence: 1, reason: "" }), {
      openWeights: false,
    });
    const r = await createOpenWeightsRepairer(models, { model: "muse-spark-open" })(
      request("s17"),
      hooks,
      ctx,
    );
    expect(r).toEqual({
      ok: false,
      rung: "open_weights",
      reason: "no open-weights provider is configured",
      costUsd: 0,
    });
    expect(models.calls).toHaveLength(0);
  });

  it("refuses steps without an element", async () => {
    const models = createLocalFakeGateway(() => ({ index: 1, confidence: 1, reason: "" }));
    const r = await createOpenWeightsRepairer(models, { model: "muse-spark-open" })(
      request("s3"),
      hooks,
      ctx,
    );
    expect(r).toMatchObject({ ok: false, reason: "the step has no element to find" });
  });
});

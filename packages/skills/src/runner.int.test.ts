// Runner integration on the Caravela partner portal: ground truth comes from portal.submissions(runId).

import { DH_SCRIPT, describeLocator } from "@dockhand/browser";
import {
  type ComputerUseModel,
  type CuRunInput,
  createMemoryArtifactStore,
  type ParamValue,
  type RunComputerUse,
  type RunHooks,
  type Skill,
  type Step,
  type StructuredRequest,
  type Trace,
} from "@dockhand/core";
import {
  addDaysIso,
  PARTNER_REG_ID_RE,
  type PortalHandle,
  type SessionOptions,
  startPartnerPortal,
} from "@dockhand/portals";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalFakeGateway, promptText } from "./__fixtures__/fake-models.ts";
import { PARTNER_PARAM_SPECS, partnerTrace } from "./__fixtures__/partner-trace.ts";
import { runCanary } from "./canary.ts";
import { compile } from "./compile.ts";
import { createCuRepairer, createOpenWeightsRepairer } from "./repair.ts";
import { type RunSkillOptions, runSkill } from "./runner.ts";
import { stepTarget, withStepTarget } from "./targets.ts";

let browser: Browser;
let portal: PortalHandle;
/** Compiled from the hand-written trace. */
let fixtureSkill: Skill;
/** The same program with targets captured from the live v1 page (as the recorder would capture them). */
let v1: Skill;
const artifacts = createMemoryArtifactStore();
let seq = 0;

const runId = (name: string) => `skills-${name}-${process.pid}-${++seq}`;

async function openPage(session: SessionOptions): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });
  await context.addInitScript({ content: DH_SCRIPT });
  await context.addCookies(await portal.session(session));
  const page = await context.newPage();
  return { page, close: () => context.close() };
}

async function recapture(skill: Skill): Promise<Skill> {
  const { page, close } = await openPage({ ui: "v1", mutation: null, runId: runId("recapture") });
  try {
    await page.goto(`${portal.url}/deals`);
    const steps: Step[] = [];
    for (const s of skill.steps) {
      if (s.op === "waitFor" && s.urlIncludes === "/deals/new") await page.goto(`${portal.url}/deals/new`);
      const t = stepTarget(s);
      const testId = t?.candidates.find((c) => c.by === "testid");
      steps.push(
        t && testId?.by === "testid"
          ? withStepTarget(s, await describeLocator(page.getByTestId(testId.value)))
          : s,
      );
    }
    return { ...skill, steps };
  } finally {
    await close();
  }
}

function freshParams(over: Record<string, ParamValue> = {}): Record<string, ParamValue> {
  return {
    company: "Cajá Logística S.A.",
    website: "caja-logistica.example",
    country: "Chile",
    city: "Valparaíso",
    contact_name: "Rodrigo Pereira",
    contact_email: "rodrigo.pereira@caja-logistica.example",
    contact_phone: "+56 9 8765 4321",
    product: "Tidewater Cloud Enterprise",
    seats: 340,
    est_value: 255000,
    close_date: addDaysIso(portal.config().serverDate, 120),
    notes: "Expansion to the Santiago office",
    ...over,
  };
}

function expectedFields(p: Record<string, ParamValue>): Record<string, unknown> {
  return {
    companyName: p.company,
    companyWebsite: p.website,
    country: p.country,
    city: p.city,
    contactName: p.contact_name,
    contactEmail: p.contact_email,
    contactPhone: p.contact_phone,
    product: p.product,
    seats: p.seats,
    estimatedValue: p.est_value,
    expectedCloseDate: p.close_date,
    notes: p.notes,
    consent: true,
  };
}

function recordingHooks(over: Partial<RunHooks> = {}) {
  const approvals: Parameters<RunHooks["approveCommit"]>[0][] = [];
  const hooks: RunHooks = {
    approveCommit: async (r) => {
      approvals.push(r);
      return "approved";
    },
    approveSafety: async () => "rejected",
    ...over,
  };
  return { hooks, approvals };
}

function options(id: string, over: Partial<RunSkillOptions> = {}): RunSkillOptions {
  return {
    runId: id,
    stepTimeoutMs: 1500,
    screenshots: "fail_only",
    allowFallbackHeal: true,
    artifacts,
    successTimeoutMs: 8000,
    ...over,
  };
}

/** Open-weights stand-in: picks the element with the step's old name, or its known new name (null: gives up). */
function fakeOpenWeights(
  renamed: Record<string, string | null> = {
    "Submit registration": "Register opportunity",
    Product: "Solution",
  },
) {
  return createLocalFakeGateway((req: StructuredRequest<unknown>) => {
    const lines = promptText(req).split("\n");
    const prefix = "Element the step used before the change: ";
    const old = JSON.parse((lines.find((l) => l.startsWith(prefix)) ?? prefix).slice(prefix.length) || "{}");
    const list = JSON.parse(
      lines[lines.indexOf("Elements of the same kind on the page now:") + 1] ?? "[]",
    ) as {
      index: number;
      name?: string;
      label?: string;
    }[];
    const oldName: string = old.label ?? old.name;
    const want = oldName in renamed ? renamed[oldName] : oldName;
    const hit = want === null ? undefined : list.find((e) => e.name === want || e.label === want);
    return hit
      ? { index: hit.index, confidence: 0.92, reason: `'${want}' does what '${oldName}' did` }
      : { index: null, confidence: 0, reason: "nothing like it" };
  });
}

beforeAll(async () => {
  [browser, portal] = await Promise.all([
    chromium.launch({ headless: true }),
    startPartnerPortal({ port: 0, latencyMs: [10, 40] }),
  ]);
  const compiled = compile(partnerTrace(portal.url), {
    name: "register_partner_deal",
    title: "Register a deal on Caravela Partner Hub",
    params: PARTNER_PARAM_SPECS,
    createdFrom: { kind: "goal", traceRunId: "01JTRACERUN0000000000000001" },
  }).skill;
  fixtureSkill = { ...compiled, version: 1, parentVersion: null };
  v1 = await recapture(fixtureSkill);
});

afterAll(async () => {
  await browser?.close();
  await portal?.close();
});

describe("runSkill on the partner portal", () => {
  it("replays the compiled v1 with fresh values: one approval, full read-back, ground truth matches", async () => {
    const id = runId("v1");
    const params = freshParams();
    const { page, close } = await openPage({ ui: "v1", mutation: null, runId: id });
    const { hooks, approvals } = recordingHooks();
    try {
      const r = await runSkill(page, fixtureSkill, params, hooks, {
        ...options(id),
        writeGuard: { origins: [portal.url], allow: [] },
      });
      expect(r.error).toBeUndefined();
      expect(r.outcome).toBe("success");
      expect(r.steps.map((s) => s.status)).toEqual(fixtureSkill.steps.map(() => "ok"));
      expect(r.patched).toBeUndefined();
      expect(r.execCostUsd).toBe(0);
      expect(r.verification).toEqual({ checked: 13, matched: 13, mismatches: [] });
      expect(r.extracted.confirmation_id).toMatch(PARTNER_REG_ID_RE);
      expect(approvals).toHaveLength(1);
      expect(approvals[0]?.highlight?.w).toBeGreaterThan(0);
      expect(approvals[0]?.readback).toContainEqual({ label: "City", value: "Valparaíso" });

      const subs = portal.submissions({ runId: id });
      expect(subs).toHaveLength(1);
      expect(subs[0]?.id).toBe(r.extracted.confirmation_id);
      expect(subs[0]?.fields).toEqual(expectedFields(params));
    } finally {
      await close();
    }
  });

  it("skips steps whose optional params were not given", async () => {
    const id = runId("optional");
    const params = freshParams({ company: "Umbu Energia Ltda." });
    delete params.website;
    delete params.notes;
    const { page, close } = await openPage({ ui: "v1", mutation: null, runId: id });
    try {
      const r = await runSkill(page, v1, params, recordingHooks().hooks, options(id));
      expect(r.outcome).toBe("success");
      expect(r.steps.filter((s) => s.status === "skipped").map((s) => s.stepId)).toEqual(["s5", "s15"]);
      const fields = portal.submissions({ runId: id })[0]?.fields ?? {};
      expect(fields.companyWebsite).toBeUndefined();
      expect(fields.companyName).toBe("Umbu Energia Ltda.");
    } finally {
      await close();
    }
  });

  it("dry run stops before the commit with everything read back", async () => {
    const id = runId("dry");
    const { page, close } = await openPage({ ui: "v1", mutation: null, runId: id });
    const { hooks, approvals } = recordingHooks();
    try {
      const r = await runSkill(page, v1, freshParams(), hooks, options(id, { dryRun: true }));
      expect(r.outcome).toBe("dry_run_ok");
      expect(r.verification?.matched).toBe(13);
      expect(approvals).toHaveLength(0);
      expect(portal.submissions({ runId: id })).toHaveLength(0);
      expect(new URL(page.url()).pathname).toBe("/deals/new");
    } finally {
      await close();
    }
  });

  it("stops with READBACK_MISMATCH when a field changes between fill and commit", async () => {
    const id = runId("readback");
    const { page, close } = await openPage({ ui: "v1", mutation: null, runId: id });
    const { hooks, approvals } = recordingHooks();
    try {
      await page.goto(`${portal.url}/deals/new`);
      // A page script rewrites City when consent is ticked (after City was filled, before the commit). It runs
      // on "change", after React has handled the checkbox click, so the checkbox itself is left alone.
      await page.evaluate(() => {
        document.addEventListener("change", (e) => {
          if ((e.target as Element | null)?.id !== "consent") return;
          const city = document.getElementById("city") as HTMLInputElement;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
          setter?.call(city, "Rio de Janeiro");
          city.dispatchEvent(new Event("input", { bubbles: true }));
        });
      });
      const skill = { ...v1, steps: v1.steps.slice(3) }; // already on the form
      const r = await runSkill(page, skill, freshParams(), hooks, options(id));
      expect(r.outcome).toBe("failed");
      expect(r.errorCode).toBe("READBACK_MISMATCH");
      expect(r.verification?.mismatches).toEqual([
        { stepId: "s7", label: "City", expected: "Valparaíso", actual: "Rio de Janeiro" },
      ]);
      expect(r.steps.at(-1)).toMatchObject({
        stepId: "s17",
        status: "failed",
        errorCode: "READBACK_MISMATCH",
      });
      expect(approvals).toHaveLength(0);
      expect(portal.submissions({ runId: id })).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("ends as unknown when the commit is never confirmed, and never clicks again", async () => {
    const id = runId("unknown");
    const { page, close } = await openPage({ ui: "v1", mutation: null, runId: id });
    const { hooks, approvals } = recordingHooks();
    let posts = 0;
    try {
      await page.route("**/api/deals", (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        posts++; // held forever: the response never comes back
      });
      const r = await runSkill(page, v1, freshParams(), hooks, options(id, { successTimeoutMs: 1500 }));
      expect(r.outcome).toBe("unknown");
      expect(r.errorCode).toBe("UNKNOWN_OUTCOME");
      expect(posts).toBe(1);
      expect(approvals).toHaveLength(1);
      expect(r.finalScreenshot).toBeDefined();
    } finally {
      await close();
    }
  });

  it("heals churned testids with fallback candidates and zero model calls", async () => {
    const id = runId("churn");
    const models = fakeOpenWeights();
    const { page, close } = await openPage({
      ui: "v1",
      mutation: { seed: 7, operators: ["testid_churn"] },
      runId: id,
    });
    try {
      const params = freshParams({ company: "Pequi Saúde S.A." });
      const r = await runSkill(
        page,
        v1,
        params,
        {
          ...recordingHooks().hooks,
          repairers: [createOpenWeightsRepairer(models, { model: "muse-spark-open" })],
        },
        options(id),
      );
      expect(r.error).toBeUndefined();
      expect(r.outcome).toBe("success");
      expect(models.calls).toHaveLength(0);
      const heals = r.steps.filter((s) => s.status === "healed");
      expect(heals.length).toBeGreaterThan(0);
      expect(heals.some((s) => s.rung === "fallback")).toBe(true);
      expect(r.steps.every((s) => s.status === "ok" || s.status === "healed")).toBe(true);
      // Heals are promoted: the patched step leads with the element's fresh candidates.
      const healedId = heals[0]?.stepId as string;
      const before = stepTarget(v1.steps.find((s) => s.id === healedId) as Step);
      const after = stepTarget(r.patched?.steps.find((s) => s.id === healedId) as Step);
      expect(after?.candidates[0]).not.toEqual(before?.candidates[0]);
      expect(r.patched?.changelog).toMatch(/healed: (fallback selector|similarity match)/);
      expect(portal.submissions({ runId: id })[0]?.fields).toEqual(expectedFields(params));
    } finally {
      await close();
    }
  });

  it("v2: free heals where possible, the renamed submit fixed by the open-weights rung", async () => {
    const id = runId("v2");
    const models = fakeOpenWeights();
    const { page, close } = await openPage({ ui: "v2", mutation: null, runId: id });
    const { hooks, approvals } = recordingHooks();
    try {
      const params = freshParams({ company: "Graviola Têxtil Ltda." });
      const r = await runSkill(
        page,
        v1,
        params,
        { ...hooks, repairers: [createOpenWeightsRepairer(models, { model: "muse-spark-open" })] },
        options(id),
      );
      expect(r.error).toBeUndefined();
      expect(r.outcome).toBe("success");
      expect(r.steps.at(-1)).toMatchObject({ stepId: "s17", status: "repaired", rung: "open_weights" });
      expect(r.steps.some((s) => s.status === "healed")).toBe(true);
      expect(approvals).toHaveLength(1);
      expect(approvals[0]?.highlight).toBeDefined();
      const submit = r.patched?.steps.find((s) => s.id === "s17");
      expect(submit).toMatchObject({ op: "click", commit: true });
      expect(stepTarget(submit as Step)?.fingerprint.name).toBe("Register opportunity");
      expect(r.patched?.changelog).toContain(
        "'Submit registration' → 'Register opportunity' (healed: open-weights model)",
      );
      expect(models.calls.length).toBeGreaterThanOrEqual(1);
      expect(models.calls.every((c) => c.ctx.purpose === "heal_match")).toBe(true);
      expect(portal.submissions({ runId: id })[0]?.fields).toEqual(expectedFields(params));
    } finally {
      await close();
    }
  });

  it("asks the rep for a new required field, adds the param and the step, and retries once", async () => {
    const id = runId("ask");
    const questions: { label: string; options?: string[] }[] = [];
    const { hooks, approvals } = recordingHooks({
      askRep: async (q) => {
        questions.push({ label: q.label, ...(q.options ? { options: q.options } : {}) });
        return "Gold";
      },
    });
    const { page, close } = await openPage({
      ui: "v1",
      mutation: { seed: 3, operators: ["insert_required_field"] },
      runId: id,
    });
    try {
      const params = freshParams({ company: "Murici Agro Ltda." });
      const r = await runSkill(page, v1, params, hooks, options(id));
      expect(r.error).toBeUndefined();
      expect(r.outcome).toBe("success");
      expect(questions).toEqual([{ label: "Partner tier", options: ["Gold", "Silver", "Bronze"] }]);
      expect(r.steps).toContainEqual(expect.objectContaining({ status: "asked", rung: "ask_rep" }));
      expect(r.patched?.params.at(-1)).toMatchObject({
        name: "partner_tier",
        type: "enum",
        required: true,
        enumValues: ["Gold", "Silver", "Bronze"],
      });
      const steps = r.patched?.steps ?? [];
      expect(steps.at(-2)).toMatchObject({ op: "select", option: "{{partner_tier}}" });
      expect(steps.at(-1)).toMatchObject({ id: "s17", commit: true });
      expect(r.patched?.changelog).toContain("new param partner_tier (asked the rep)");
      // Asked before the approval card: one approval for one complete form, no refused submit first.
      expect(approvals).toHaveLength(1);
      expect(portal.submissions({ runId: id })[0]?.fields).toEqual({
        ...expectedFields(params),
        partnerTier: "Gold",
      });
    } finally {
      await close();
    }
  });

  it("heals a dropdown that became radio buttons for free, picking the option by value", async () => {
    const id = runId("radio");
    const { hooks } = recordingHooks();
    const { page, close } = await openPage({
      ui: "v1",
      mutation: { seed: 5, operators: ["combobox_to_radio"] },
      runId: id,
    });
    try {
      const params = freshParams({ company: "Ipê Roxo Ltda." });
      const r = await runSkill(page, v1, params, hooks, options(id));
      expect(r.error).toBeUndefined();
      expect(r.outcome).toBe("success");
      expect(r.steps).toContainEqual(expect.objectContaining({ status: "healed", rung: "similarity" }));
      const pick = r.patched?.steps.find((s) => s.op === "check" && s.target.fingerprint.role === "radio");
      expect(pick?.op === "check" ? pick.target.candidates[0] : undefined).toEqual({
        by: "role",
        role: "radio",
        name: "{{product}}",
        exact: true,
      });
      expect(r.verification?.mismatches).toEqual([]);
      expect(portal.submissions({ runId: id })[0]?.fields).toEqual(expectedFields(params));
    } finally {
      await close();
    }
  });

  // evalBaseline (eval baselines only): unset, the two tests above pin today's behavior. Here a present option that
  // is not an explicit false keeps that behavior, and only `false` switches the one thing it names off.
  it("eval baseline: only widgetSwap false turns off the free dropdown-to-radio heal", async () => {
    const run = async (tag: string, evalBaseline: NonNullable<RunSkillOptions["evalBaseline"]>) => {
      const id = runId(tag);
      const { page, close } = await openPage({
        ui: "v1",
        mutation: { seed: 5, operators: ["combobox_to_radio"] },
        runId: id,
      });
      try {
        const r = await runSkill(
          page,
          v1,
          freshParams({ company: "Ipê Branco Ltda." }),
          recordingHooks().hooks,
          options(id, { evalBaseline }),
        );
        return { r, subs: portal.submissions({ runId: id }) };
      } finally {
        await close();
      }
    };
    const kept = await run("radio-swap-kept", { readBackGate: true });
    expect(kept.r.outcome).toBe("success");
    expect(kept.r.steps).toContainEqual(expect.objectContaining({ status: "healed", rung: "similarity" }));
    expect(kept.subs).toHaveLength(1);

    const off = await run("radio-swap-off", { widgetSwap: false });
    expect(off.r.outcome).toBe("failed");
    expect(off.r.steps.some((s) => s.rung === "similarity")).toBe(false);
    expect(off.r.steps.at(-1)?.status).toBe("failed");
    expect(off.subs).toHaveLength(0);
  });

  it("eval baseline: only readBackGate false lets a commit past a read-back mismatch, still reported", async () => {
    const run = async (tag: string, evalBaseline: NonNullable<RunSkillOptions["evalBaseline"]>) => {
      const id = runId(tag);
      const { page, close } = await openPage({ ui: "v1", mutation: null, runId: id });
      try {
        await page.goto(`${portal.url}/deals/new`);
        // The same page script as the READBACK_MISMATCH test: City is rewritten after it was filled.
        await page.evaluate(() => {
          document.addEventListener("change", (e) => {
            if ((e.target as Element | null)?.id !== "consent") return;
            const city = document.getElementById("city") as HTMLInputElement;
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
            setter?.call(city, "Rio de Janeiro");
            city.dispatchEvent(new Event("input", { bubbles: true }));
          });
        });
        const skill = { ...v1, steps: v1.steps.slice(3) };
        const r = await runSkill(
          page,
          skill,
          freshParams(),
          recordingHooks().hooks,
          options(id, { evalBaseline }),
        );
        return { r, subs: portal.submissions({ runId: id }) };
      } finally {
        await close();
      }
    };
    const mismatch = [{ stepId: "s7", label: "City", expected: "Valparaíso", actual: "Rio de Janeiro" }];
    const gated = await run("readback-gated", { widgetSwap: true, readBackGate: true });
    expect(gated.r.outcome).toBe("failed");
    expect(gated.r.errorCode).toBe("READBACK_MISMATCH");
    expect(gated.r.verification?.mismatches).toEqual(mismatch);
    expect(gated.subs).toHaveLength(0);

    const open = await run("readback-open", { readBackGate: false });
    expect(open.r.outcome).toBe("success");
    expect(open.r.verification?.mismatches).toEqual(mismatch);
    expect(open.subs[0]?.fields.city).toBe("Rio de Janeiro");
  });

  it("stops safely with needs_input when the rep gives no answer", async () => {
    const id = runId("noanswer");
    const { hooks } = recordingHooks({ askRep: async () => null });
    const { page, close } = await openPage({
      ui: "v1",
      mutation: { seed: 3, operators: ["insert_required_field"] },
      runId: id,
    });
    try {
      const r = await runSkill(page, v1, freshParams(), hooks, options(id));
      expect(r.outcome).toBe("needs_input");
      expect(r.errorCode).toBe("NEEDS_INPUT");
      expect(portal.submissions({ runId: id })).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("treats a validation error on a field it filled as bad data: no repair, no question", async () => {
    const id = runId("baddata");
    const models = fakeOpenWeights();
    let asked = 0;
    const { hooks } = recordingHooks({
      askRep: async () => {
        asked++;
        return "x";
      },
    });
    const { page, close } = await openPage({ ui: "v1", mutation: null, runId: id });
    try {
      const r = await runSkill(
        page,
        v1,
        freshParams({ contact_email: "rodrigo.pereira" }),
        { ...hooks, repairers: [createOpenWeightsRepairer(models, { model: "muse-spark-open" })] },
        options(id),
      );
      expect(r.outcome).toBe("failed");
      expect(r.errorCode).toBe("PORTAL_VALIDATION");
      expect(r.error).toContain("Contact email must be a valid email address");
      expect(asked).toBe(0);
      expect(models.calls).toHaveLength(0);
      expect(portal.submissions({ runId: id })).toHaveLength(0);
    } finally {
      await close();
    }
  });
});

describe("paid rungs on a live page", () => {
  const cuModel: ComputerUseModel = {
    provider: "scripted",
    model: "scripted",
    open() {
      throw new Error("the fake runComputerUse never opens a session");
    },
  };

  function emptyTrace(input: CuRunInput): Trace {
    return {
      runId: input.runId,
      portalId: input.portalId,
      startUrl: input.page.url(),
      viewport: { w: 1280, h: 800 },
      params: input.params,
      steps: [],
      final: {
        url: input.page.url(),
        text: "",
        screenshot: { id: "x", sha256: "x", mime: "image/png", bytes: 0, relPath: "x.png" },
      },
      outcome: "done",
    };
  }

  it("v2: the renamed submit is proposed by computer use (propose_only) and clicked only after approval", async () => {
    const id = runId("v2cu");
    const ow = fakeOpenWeights({ "Submit registration": null, Product: "Solution" });
    const cuInputs: CuRunInput[] = [];
    const runComputerUse: RunComputerUse = async (_model, input) => {
      cuInputs.push(input);
      if (input.commitPolicy !== "propose_only")
        return { trace: emptyTrace(input), outcome: "failed", message: "not scripted" };
      const proposed = await describeLocator(
        input.page.getByRole("button", { name: "Register opportunity" }),
      );
      return { trace: emptyTrace(input), outcome: "done", proposed };
    };
    const { page, close } = await openPage({ ui: "v2", mutation: null, runId: id });
    const { hooks, approvals } = recordingHooks();
    try {
      const params = freshParams({ company: "Cupuaçu Têxtil Ltda." });
      const r = await runSkill(
        page,
        v1,
        params,
        {
          ...hooks,
          repairers: [
            createOpenWeightsRepairer(ow, { model: "muse-spark-open" }),
            createCuRepairer({
              model: cuModel,
              runComputerUse,
              artifacts,
              writeGuard: { origins: [portal.url], allow: [] },
            }),
          ],
        },
        options(id, { stepTimeoutMs: 1000 }),
      );
      expect(r.error).toBeUndefined();
      expect(r.outcome).toBe("success");
      expect(r.steps.find((s) => s.stepId === "s11")).toMatchObject({
        status: "repaired",
        rung: "open_weights",
      });
      expect(r.steps.at(-1)).toMatchObject({ stepId: "s17", status: "repaired", rung: "computer_use" });
      expect(cuInputs).toHaveLength(1);
      expect(cuInputs[0]?.commitPolicy).toBe("propose_only");
      expect(approvals).toHaveLength(1);
      expect(approvals[0]?.highlight?.w).toBeGreaterThan(0);
      expect(r.patched?.changelog).toContain(
        "'Submit registration' → 'Register opportunity' (healed: computer use)",
      );
      expect(portal.submissions({ runId: id })[0]?.fields).toEqual(expectedFields(params));
    } finally {
      await close();
    }
  });

  it("open weights: a null pick, an index outside the list and a low-confidence pick are all refused", async () => {
    const id = runId("owguard");
    const { page, close } = await openPage({ ui: "v2", mutation: null, runId: id });
    try {
      await page.goto(`${portal.url}/deals/new`);
      const request = {
        page,
        runId: id,
        skill: v1,
        stepIdx: v1.steps.length - 1,
        params: freshParams(),
        error: { code: "STEP_NOT_FOUND" as const, message: "no candidate matched" },
      };
      const ctx = { purpose: "heal_match" as const, runId: id, timeoutMs: 30_000 };
      const answers = [
        { index: null, confidence: 0.9, reason: "nothing submits" },
        { index: 9999, confidence: 0.9, reason: "made up" },
        { index: 0, confidence: 0.2, reason: "unsure" },
      ];
      const reasons: string[] = [];
      for (const answer of answers) {
        const models = createLocalFakeGateway(() => answer);
        const r = await createOpenWeightsRepairer(models, { model: "muse-spark-open" })(
          request,
          recordingHooks().hooks,
          ctx,
        );
        expect(r.ok).toBe(false);
        if (!r.ok) reasons.push(r.reason);
        expect(models.calls[0]?.ctx.purpose).toBe("heal_match");
        expect(models.calls[0]?.req.model).toBe("muse-spark-open");
      }
      expect(reasons).toEqual([
        "no match: nothing submits",
        "index 9999 is not in the list",
        "low confidence 0.2: unsure",
      ]);
    } finally {
      await close();
    }
  });
});

describe("uploads and extraction on a fixture page", () => {
  it("sets a hidden file input from an artifact and extracts a reference from the page", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript({ content: DH_SCRIPT });
    await context.route("http://fixture.test/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html><body><main>
          <h1>Documents</h1>
          <label for="w9">W-9 form</label>
          <input id="w9" name="w9" type="file" accept="application/pdf" style="display:none">
          <button type="button" onclick="document.getElementById('w9').click()">Choose file for W-9 form</button>
          <p>Reference: REF-40213</p>
        </main></body></html>`,
      }),
    );
    const page = await context.newPage();
    try {
      const bytes = new TextEncoder().encode("%PDF-1.4 fake w9");
      const ref = await artifacts.put(bytes, "application/pdf", {
        kind: "upload_fixture",
        filename: "w9.pdf",
      });
      const skill: Skill = {
        name: "upload_w9",
        version: 1,
        parentVersion: null,
        title: "Upload a W-9",
        portalId: "fixture",
        params: [{ name: "w9_form", type: "file", required: true, description: "W-9 form" }],
        steps: [
          { id: "s1", op: "goto", intent: "Open the documents page", url: "http://fixture.test/docs" },
          {
            id: "s2",
            op: "upload",
            intent: "Upload the W-9",
            fileParam: "w9_form",
            target: {
              candidates: [
                { by: "label", value: "W-9 form", exact: true },
                { by: "css", value: "#w9" },
              ],
              fingerprint: {
                tag: "input",
                inputType: "file",
                label: "W-9 form",
                domId: "w9",
                bbox: { x: 0, y: 0, w: 0, h: 0 },
              },
            },
          },
          { id: "s3", op: "extract", intent: "Read the reference", name: "reference", regex: "REF-\\d{5}" },
        ],
        success: { extract: [] },
        createdFrom: { kind: "goal", traceRunId: "x" },
        changelog: "",
      };
      const r = await runSkill(
        page,
        skill,
        { w9_form: { file: ref, filename: "w9.pdf" } },
        recordingHooks().hooks,
        options("upload"),
      );
      expect(r.error).toBeUndefined();
      expect(r.outcome).toBe("success");
      expect(r.extracted).toEqual({ reference: "REF-40213" });
      const file = await page.evaluate(() => {
        const f = (document.getElementById("w9") as HTMLInputElement).files?.[0];
        return f ? { name: f.name, size: f.size, type: f.type } : null;
      });
      expect(file).toEqual({ name: "w9.pdf", size: bytes.byteLength, type: "application/pdf" });
    } finally {
      await context.close();
    }
  });
});

describe("a page still drawing after load", () => {
  it("waits for the app's requests after a navigation instead of repairing a half-drawn page", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript({ content: DH_SCRIPT });
    // The app shell loads at once; the form comes after a request that takes twice the step's wait.
    await context.route("http://slow.test/api/metadata", async (route) => {
      await new Promise((r) => setTimeout(r, 3000));
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    await context.route("http://slow.test/app", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html><body><main id="app">Loading…</main><script>
          fetch("/api/metadata").then(() => {
            document.getElementById("app").innerHTML =
              '<label for="fn">First Name</label><input id="fn" name="firstName" type="text">';
          });
        </script></body></html>`,
      }),
    );
    const page = await context.newPage();
    try {
      const skill: Skill = {
        name: "slow_app",
        version: 1,
        parentVersion: null,
        title: "Fill a slow app",
        portalId: "fixture",
        params: [{ name: "first_name", type: "string", required: true, description: "First name" }],
        steps: [
          { id: "s1", op: "goto", intent: "Open the app", url: "http://slow.test/app" },
          {
            id: "s2",
            op: "fill",
            intent: "Enter the first name",
            value: "{{first_name}}",
            target: {
              candidates: [{ by: "label", value: "First Name", exact: true }],
              fingerprint: {
                tag: "input",
                inputType: "text",
                label: "First Name",
                bbox: { x: 0, y: 0, w: 0, h: 0 },
              },
            },
          },
        ],
        success: { extract: [] },
        createdFrom: { kind: "goal", traceRunId: "x" },
        changelog: "",
      };
      const rec = recordingHooks();
      const r = await runSkill(page, skill, { first_name: "Rafaela" }, rec.hooks, options("slow"));
      expect(r.error).toBeUndefined();
      expect(r.outcome).toBe("success");
      expect(r.steps[1]).toMatchObject({ status: "ok", candidateIdx: 0 });
      expect(await page.inputValue("#fn")).toBe("Rafaela");
    } finally {
      await context.close();
    }
  });
});

describe("runCanary", () => {
  it("passes dry runs on the UI the skill was learned on and reports failures on another", async () => {
    const contexts: (() => Promise<void>)[] = [];
    const pageFor = (ui: "v1" | "v2") => async () => {
      const { page, close } = await openPage({ ui, mutation: null, runId: runId(`canary-${ui}`) });
      contexts.push(close);
      return page;
    };
    try {
      const sets = [
        freshParams(),
        freshParams({ company: "Pitanga Foods Ltda.", country: "Mexico", seats: 12 }),
      ];
      const ok = await runCanary(pageFor("v1"), v1, sets, { artifacts, stepTimeoutMs: 1500 });
      expect(ok).toEqual({ passed: 2, total: 2, failures: [] });
      const bad = await runCanary(pageFor("v2"), v1, sets.slice(0, 1), { artifacts, stepTimeoutMs: 800 });
      expect(bad.passed).toBe(0);
      expect(bad.failures[0]?.outcome).toBe("failed");
      expect(bad.failures[0]?.steps.length).toBeGreaterThan(0);
    } finally {
      await Promise.all(contexts.map((c) => c()));
    }
  });
});

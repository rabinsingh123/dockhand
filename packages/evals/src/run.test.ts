// runCase against the real Caravela portal (port 0) with ground truth from portal.submissions(runId).

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserPool, type DockhandBrowserPool } from "@dockhand/browser";
import { createMemoryArtifactStore, type EvalCase, openDb, Skill, type Step } from "@dockhand/core";
import type { PortalHandle, Submission } from "@dockhand/portals";
import { stepTarget } from "@dockhand/skills";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateCases, withRepAnswer } from "./cases.ts";
import { createEvalLedger, type EvalLedger } from "./ledger.ts";
import { PORTALS } from "./portals.ts";
import { repairSetup } from "./repairers.ts";
import { gradeSubmissions, primarySelectorsOnly, runCase } from "./run.ts";

const skill = Skill.parse(
  JSON.parse(readFileSync(new URL("./__fixtures__/caravela_register_deal.json", import.meta.url), "utf8")),
);
let portal: PortalHandle;
let pool: DockhandBrowserPool;
let ledger: EvalLedger;
let mutation: EvalCase[];
let replay: EvalCase[];

beforeAll(async () => {
  portal = await PORTALS.caravela.start({ latencyMs: [10, 30] });
  pool = createBrowserPool({
    headless: true,
    maxContexts: 2,
    storageStateDir: mkdtempSync(join(tmpdir(), "dockhand-evals-")),
  });
  ledger = createEvalLedger(openDb(":memory:"));
  const today = portal.config().serverDate;
  replay = generateCases("replay", skill, 1, 11, { today });
  mutation = generateCases("mutation", skill, 11, 11, { today });
});

afterAll(async () => {
  await pool?.closeAll();
  await portal?.close();
});

const deps = () => ({ portal, pool, skill, ledger, stepTimeoutMs: 4000, successTimeoutMs: 10_000 });
const byOperator = (op: string) => {
  const c = mutation.find((x) => x.portal.mutation?.operators?.[0] === op);
  if (!c) throw new Error(`no ${op} case`);
  return c;
};

describe("runCase on Caravela Partner Hub", () => {
  it("v1 replay: success, every expected field in the submission, no heals, no model calls", async () => {
    const c = replay[0] as EvalCase;
    const r = await runCase(c, deps());
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({ ok: true, outcome: "success", silentWrong: false, safeStop: false, heals: [] });
    expect(r).toMatchObject({ modelCalls: 0, execCostUsd: 0, provider: "none", ui: "v1", repair: "none" });
    expect(r.fields.correct).toBe(Object.keys(c.expected).length);
    expect(r.fields.mismatches).toEqual([]);
    expect(portal.submissions({ runId: c.portal.runId })).toHaveLength(1);
  });

  it("testid_churn: healed by the free fallback rung, 0 model calls", async () => {
    const r = await runCase(byOperator("testid_churn"), deps());
    expect(r).toMatchObject({
      ok: true,
      outcome: "success",
      silentWrong: false,
      modelCalls: 0,
      provider: "none",
    });
    expect(r.heals.find((h) => h.rung === "fallback")?.count).toBeGreaterThan(0);
    expect(r.heals.every((h) => h.rung === "fallback" || h.rung === "similarity")).toBe(true);
    expect(r.expectedCategory).toBe("heal_deterministic");
  });

  it("insert_required_field without an answer: stops safely, writes nothing", async () => {
    const c = byOperator("insert_required_field");
    const r = await runCase(c, deps());
    expect(r).toMatchObject({ ok: true, safeStop: true, silentWrong: false, outcome: "needs_input" });
    expect(r.errorCode).toBe("NEEDS_INPUT");
    expect(r.expectedCategory).toBe("must_fail_safe");
    expect(portal.submissions({ runId: c.portal.runId })).toHaveLength(0);
  });

  it("insert_required_field with the rep's answer: asks once, submits the answer", async () => {
    const tier = PORTALS.caravela.insertable.find((f) => f.key === "partnerTier");
    if (!tier) throw new Error("no partnerTier");
    const c = withRepAnswer(byOperator("insert_required_field"), tier, "Silver");
    const r = await runCase(c, deps());
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({ ok: true, outcome: "success", safeStop: false, silentWrong: false });
    expect(r.heals).toContainEqual({ rung: "ask_rep", count: 1 });
    expect(portal.submissions({ runId: c.portal.runId })[0]?.fields.partnerTier).toBe("Silver");
  });

  it("--repair fake: the stand-in rung-2 picker heals a renamed submit, booked as a non-model provider", async () => {
    const c = generateCases("repair", skill, 15, 11, { today: portal.config().serverDate }).find(
      (x) => x.portal.mutation?.operators?.[0] === "button_rename",
    );
    if (!c) throw new Error("no button_rename case");
    const repair = repairSetup("fake", { ledger, artifacts: createMemoryArtifactStore() });
    const r = await runCase(c, { ...deps(), repair });
    expect(r).toMatchObject({ ok: true, outcome: "success", silentWrong: false, repair: "fake" });
    expect(r.heals).toEqual([{ rung: "open_weights", count: 1 }]);
    expect(r).toMatchObject({ modelCalls: 1, provider: "scripted", execCostUsd: 0 });
  });
});

describe("baseline arms (scripts/evals/baseline.ts)", () => {
  const own = (c: EvalCase, tag: string): EvalCase => ({
    ...c,
    portal: { ...c.portal, runId: `${c.id}-${tag}` },
  });

  it("primarySelectorsOnly keeps each target's first candidate and nothing else", () => {
    const cut = primarySelectorsOnly(skill);
    expect(cut.steps.map((s) => s.op)).toEqual(skill.steps.map((s) => s.op));
    cut.steps.forEach((s, i) => {
      const before = stepTarget(skill.steps[i] as Step);
      expect(stepTarget(s)?.candidates).toEqual(before ? before.candidates.slice(0, 1) : undefined);
      expect(stepTarget(s)?.fingerprint).toEqual(before?.fingerprint);
    });
  });

  it("noHeal: churned testids are not healed, so the run stops before writing anything", async () => {
    const c = own(byOperator("testid_churn"), "noheal");
    const r = await runCase(c, { ...deps(), baseline: { noHeal: { readBack: true } } });
    expect(r).toMatchObject({ ok: false, silentWrong: false, heals: [], modelCalls: 0, repair: "none" });
    expect(r.outcome).toBe("failed");
    expect(portal.submissions({ runId: c.portal.runId })).toHaveLength(0);
  });

  it("noHeal on the unchanged UI: primary selectors alone replay it correctly", async () => {
    const c = own(replay[0] as EvalCase, "noheal");
    const r = await runCase(c, { ...deps(), baseline: { noHeal: { readBack: false } } });
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({ ok: true, outcome: "success", silentWrong: false, heals: [] });
  });

  it("script: runs in place of the runner and is graded from the portal's log, not from its own claim", async () => {
    const c = own(replay[0] as EvalCase, "script");
    let saw: Record<string, unknown> | undefined;
    const quiet = await runCase(c, {
      ...deps(),
      baseline: {
        script: async (_page, params) => {
          saw = params;
        },
      },
    });
    expect(saw).toEqual(c.params);
    expect(quiet).toMatchObject({ ok: false, outcome: "success", silentWrong: false, heals: [] });
    expect(quiet.fields.correct).toBe(0);

    const broken = await runCase(c, {
      ...deps(),
      baseline: {
        script: async () => {
          throw new Error("no candidate matched exactly one element");
        },
      },
    });
    expect(broken).toMatchObject({
      ok: false,
      outcome: "failed",
      error: "no candidate matched exactly one element",
    });
    expect(portal.submissions({ runId: c.portal.runId })).toHaveLength(0);
  });
});

describe("gradeSubmissions", () => {
  const sub = (fields: Submission["fields"], extra: Partial<Submission> = {}): Submission => ({
    id: "NW-REG-00001",
    portal: "partner",
    runId: "r",
    version: "v1",
    fields,
    createdAt: "2026-10-27T00:00:00Z",
    ...extra,
  });

  it("a wrong or extra field is silent wrong; canonical forms compare equal", () => {
    const expected = { companyName: "Cajá Logística S.A.", seats: "340", consent: "true" };
    const right = gradeSubmissions(expected, [
      sub({ companyName: "Cajá Logística S.A.", seats: 340, consent: true }),
    ]);
    expect(right).toMatchObject({ submitted: true, silentWrong: false, fields: { correct: 3, total: 3 } });
    const wrong = gradeSubmissions(expected, [
      sub({ companyName: "Caja Logistica", seats: 340, consent: true }),
    ]);
    expect(wrong.silentWrong).toBe(true);
    expect(wrong.fields.mismatches).toEqual([
      { field: "companyName", expected: "Cajá Logística S.A.", actual: "Caja Logistica" },
    ]);
    const extra = gradeSubmissions(expected, [
      sub({ companyName: "Cajá Logística S.A.", seats: 340, consent: true, partnerTier: "Gold" }),
    ]);
    expect(extra.silentWrong).toBe(true);
    expect(extra.fields.total).toBe(4);
    expect(gradeSubmissions(expected, [])).toMatchObject({ submitted: false, silentWrong: false });
  });

  it("files are graded by filename and bytes", () => {
    const files = [{ field: "w9File", filename: "w9-sample.pdf", size: 10, sha256: "aa" }];
    const ok = gradeSubmissions({ w9File: "w9-sample.pdf" }, [sub({}, { files })], { w9File: "aa" });
    expect(ok.silentWrong).toBe(false);
    const swapped = gradeSubmissions({ w9File: "w9-sample.pdf" }, [sub({}, { files })], { w9File: "bb" });
    expect(swapped.fields.mismatches[0]?.actual).toBe("w9-sample.pdf (different bytes)");
  });
});

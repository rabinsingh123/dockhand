import { createFixedClock, openDb, type SkillBody, type SkillDraft } from "@dockhand/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PARTNER_PARAM_SPECS, partnerTrace } from "./__fixtures__/partner-trace.ts";
import { compile } from "./compile.ts";
import { createSkillStore } from "./store.ts";

const trace = partnerTrace();
const v1: SkillBody = compile(trace, {
  name: "register_partner_deal",
  title: "Register a deal on Caravela Partner Hub",
  params: PARTNER_PARAM_SPECS,
  createdFrom: { kind: "goal", traceRunId: trace.runId },
}).skill;

const draft: SkillDraft = {
  name: "register_partner_deal",
  title: "Register a deal",
  portalId: "partner",
  startUrl: "http://127.0.0.1:4100/deals",
  goal: "Register the deal on the Caravela partner portal",
  steps: ["Click Register a deal", "Fill the form with {{company}}", "Submit the registration"],
  params: PARTNER_PARAM_SPECS.slice(0, 2),
  commitStep: "Submit registration",
  success: "A registration ID like NW-REG-12345",
};

describe("createSkillStore", () => {
  let db: ReturnType<typeof openDb>;
  let store: ReturnType<typeof createSkillStore>;

  beforeEach(() => {
    db = openDb(":memory:");
    store = createSkillStore(db, createFixedClock(1_793_000_000_000));
  });
  afterEach(() => db.close());

  it("versions with integers, keeps exactly one active, and rolls back", () => {
    const s1 = store.saveVersion(v1, null, true, "compile", "01JRUN1");
    const s2 = store.saveVersion({ ...v1, changelog: "step 17: healed" }, 1, true, "heal", "01JRUN2");
    const s3 = store.saveVersion({ ...v1, title: "Candidate" }, 2, false, "repair");
    expect([s1.version, s2.version, s3.version]).toEqual([1, 2, 3]);
    expect([s1.parentVersion, s2.parentVersion, s3.parentVersion]).toEqual([null, 1, 2]);
    expect(store.active("register_partner_deal")?.version).toBe(2);
    expect(store.get("register_partner_deal", 3)?.title).toBe("Candidate");

    store.activate("register_partner_deal", 1);
    expect(store.active("register_partner_deal")?.version).toBe(1);
    const actives = db.raw.prepare("SELECT version FROM skills WHERE active = 1").all();
    expect(actives).toEqual([{ version: 1 }]);
    expect(store.list()).toEqual([
      {
        name: "register_partner_deal",
        title: "Register a deal on Caravela Partner Hub",
        activeVersion: 1,
        versions: 3,
      },
    ]);
  });

  it("is backed by the partial unique index (two active rows are impossible)", () => {
    store.saveVersion(v1, null, true, "compile");
    store.saveVersion(v1, 1, false, "heal");
    expect(() =>
      db.raw
        .prepare("UPDATE skills SET active = 1 WHERE name = 'register_partner_deal' AND version = 2")
        .run(),
    ).toThrow(/UNIQUE/);
  });

  it("leaves the active version alone when activation or a save fails", () => {
    store.saveVersion(v1, null, true, "compile");
    expect(() => store.activate("register_partner_deal", 9)).toThrow(/no version 9/);
    expect(() => store.saveVersion({ ...v1, name: "Bad Name" }, null, true, "compile")).toThrow();
    expect(() => store.saveVersion(v1, 7, true, "heal")).toThrow(/no version 7/);
    expect(store.active("register_partner_deal")?.version).toBe(1);
    expect(store.list()[0]?.versions).toBe(1);
  });

  it("accepts ask_rep as a source and stores the changelog", () => {
    store.saveVersion(v1, null, true, "compile");
    store.saveVersion(
      { ...v1, changelog: "new param partner_tier (asked the rep)" },
      1,
      true,
      "ask_rep",
      "01JRUN3",
    );
    const row = db.raw.prepare("SELECT source, changelog, source_run_id FROM skills WHERE version = 2").get();
    expect(row).toEqual({
      source: "ask_rep",
      changelog: "new param partner_tier (asked the rep)",
      source_run_id: "01JRUN3",
    });
  });

  it("saves drafts, finds the open draft for a portal, and marks it compiled with v1", () => {
    const id = store.saveDraft(draft, "01JJOB");
    expect(store.getDraft(id)).toEqual(draft);
    expect(store.draftForPortal("partner")).toEqual({ id, draft });
    expect(store.draftForPortal("supplier")).toBeUndefined();
    store.saveVersion(
      { ...v1, createdFrom: { kind: "video", draftId: id, traceRunId: "01JRUN1" } },
      null,
      true,
      "compile",
    );
    expect(store.draftForPortal("partner")).toBeUndefined();
    expect(store.getDraft(id)).toEqual(draft);
  });

  it("returns undefined for unknown skills", () => {
    expect(store.active("nope")).toBeUndefined();
    expect(store.get("nope", 1)).toBeUndefined();
    expect(store.getDraft("nope")).toBeUndefined();
    expect(store.list()).toEqual([]);
  });
});

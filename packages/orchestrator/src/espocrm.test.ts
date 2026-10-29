import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFixedClock, type Skill, type SkillStore, workspaceRoot } from "@dockhand/core";
import { describe, expect, it } from "vitest";
import {
  ESPOCRM_DEFAULTS,
  espoAdminPassword,
  espoFromEnv,
  inputsMentionEspo,
  type LeadUnderstanding,
  leadParams,
  leadRequest,
  mentionsEspo,
  normalizeLead,
  planLead,
} from "./espocrm.ts";
import { teachPortals } from "./flows/teach.ts";
import type { BuildPlanContext } from "./plan.ts";
import { ESPOCRM } from "./portals.ts";
import { understandingRequest } from "./understand.ts";
import { portalDirectory } from "./wiring.ts";

const fixture = JSON.parse(
  readFileSync(join(workspaceRoot(), "fixtures", "oss", "espocrm-lead-request.json"), "utf8"),
) as { text: string; lead: LeadUnderstanding };
const skillFixture = JSON.parse(
  readFileSync(join(workspaceRoot(), "fixtures", "oss", "espocrm-create-lead.skill-v1.json"), "utf8"),
) as { skill: Skill };

function store(skills: Skill[] = []): SkillStore {
  return {
    active: (name) => skills.find((s) => s.name === name),
    get: () => undefined,
    list: () => skills.map((s) => ({ name: s.name, title: s.title, activeVersion: s.version, versions: 1 })),
    saveVersion: () => {
      throw new Error("not in a pure test");
    },
    activate: () => {},
    saveDraft: () => "D1",
    getDraft: () => undefined,
    draftForPortal: () => undefined,
  };
}

function ctx(skills: SkillStore): BuildPlanContext {
  return {
    jobId: "01JOB",
    skills,
    rep: { phone: "5511999990001", name: "Ana", tz: "America/Sao_Paulo", locale: "pt-BR", languageBias: [] },
    company: {},
    companyFiles: {},
    attachments: [],
    clock: createFixedClock(Date.UTC(2026, 9, 29, 13, 0, 0)),
    portals: { [ESPOCRM]: { ...ESPOCRM_DEFAULTS, url: "http://127.0.0.1:8090" } },
  };
}

describe("EspoCRM requests", () => {
  it("routes only messages that name EspoCRM", () => {
    expect(mentionsEspo(fixture.text)).toBe(true);
    expect(mentionsEspo("add this lead to Espo CRM")).toBe(true);
    expect(mentionsEspo("register this deal on Caravela")).toBe(false);
    expect(inputsMentionEspo([{ kind: "voice", text: "cria um lead no EspoCRM" }])).toBe(true);
  });

  it("normalizes a lead: enums to EspoCRM's options, country names, websites without a scheme", () => {
    const l = normalizeLead({
      ...fixture.lead,
      status: "in process",
      source: "partner",
      country: "Brasil",
      website: "https://ipelogistica.example/",
      email: "not an email",
    });
    expect(l).toMatchObject({ status: "In Process", source: "Partner", country: "Brazil", email: null });
    expect(l.website).toBe("ipelogistica.example");
  });

  it("replays the compiled skill with every value the rep gave", () => {
    const out = planLead(fixture.lead, ctx(store([skillFixture.skill])));
    expect(out.type).toBe("plan");
    if (out.type !== "plan") return;
    expect(out.plan.intent).toBe("create_lead");
    expect(out.plan.writes).toBe(true);
    const action = out.plan.actions[0];
    expect(action?.kind).toBe("skill_replay");
    if (action?.kind === "skill_replay") expect(action.params).toEqual(leadParams(fixture.lead));
    expect(out.plan.approvalText).not.toMatch(/Not in this skill/);
  });

  it("plans a first run with the commit control named when no skill exists, and asks for a missing name", () => {
    const out = planLead(fixture.lead, ctx(store()));
    expect(out.type === "plan" && out.plan.actions[0]?.kind).toBe("computer_use");
    if (out.type === "plan" && out.plan.actions[0]?.kind === "computer_use") {
      expect(out.plan.actions[0].startUrl).toBe("http://127.0.0.1:8090/#Lead/create");
      expect(out.plan.actions[0].goal).toMatch(/request_commit before you click "Save"/);
    }
    const ask = planLead({ ...fixture.lead, lastName: null }, ctx(store()));
    expect(ask).toMatchObject({ type: "ask", missing: ["last_name"] });
  });

  it("asks its own question: the general understanding prompt stays as it was", () => {
    const lead = leadRequest([{ kind: "text", text: fixture.text }]);
    const general = understandingRequest({
      rep: { tz: "America/Sao_Paulo" },
      nowMs: Date.UTC(2026, 9, 29),
      inputs: [{ kind: "text", text: fixture.text }],
      skills: [],
    });
    expect(lead.schemaName).toBe("lead_understanding");
    expect(general.schemaName).toBe("understanding");
    expect(general.instructions).not.toMatch(/EspoCRM/);
  });

  it("joins the portal directory only when ESPOCRM_URL is set, and teach sees it only when the caption names it", () => {
    const config = { ports: { partnerPortal: 5101, supplierPortal: 5102 } } as Parameters<
      typeof portalDirectory
    >[0];
    expect(Object.keys(portalDirectory(config, undefined, {}))).toEqual(["caravela", "supplier"]);
    const dir = portalDirectory(config, undefined, {
      ESPOCRM_URL: "http://127.0.0.1:8090/",
      ESPO_ADMIN_PASSWORD: "from-env",
    });
    expect(dir[ESPOCRM]).toMatchObject({ url: "http://127.0.0.1:8090", commitHints: ["Save"] });
    expect(Object.keys(teachPortals(dir, "how I register a deal"))).toEqual(["caravela", "supplier"]);
    expect(Object.keys(teachPortals(dir, "creating a lead in EspoCRM"))).toContain(ESPOCRM);
    expect(espoFromEnv({})).toBeNull();
  });

  it("has no built-in admin password: the env, else the one setup generated, else a clear error", () => {
    const url = { ESPOCRM_URL: "http://127.0.0.1:8090" };
    expect(espoAdminPassword({ ESPO_ADMIN_PASSWORD: "from-env" }, () => "from-file")).toBe("from-env");
    expect(espoFromEnv(url, () => "Xy7generated24chars0000  ")?.password).toBe("Xy7generated24chars0000");
    expect(() => espoFromEnv(url, () => null)).toThrow(/ESPO_ADMIN_PASSWORD.*setup.ps1/);
    expect(readFileSync(new URL("./espocrm.ts", import.meta.url), "utf8")).not.toContain("espo-local-admin");
  });
});

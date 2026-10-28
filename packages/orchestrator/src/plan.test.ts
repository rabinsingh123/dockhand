import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ArtifactRef,
  createFixedClock,
  type ParamSpec,
  type Skill,
  SkillDraft,
  type SkillStore,
  type Understanding,
  workspaceRoot,
} from "@dockhand/core";
import { describe, expect, it } from "vitest";
import { syntheticParamSets } from "./params.ts";
import { type BuildPlanContext, buildPlan, WHAT_I_DO } from "./plan.ts";
import { CARAVELA, PORTAL_DEFAULTS, SUPPLIER } from "./portals.ts";
import { blankUnderstanding, normalizeUnderstanding } from "./understand.ts";

const root = workspaceRoot();
const fixture = (p: string) => JSON.parse(readFileSync(join(root, "fixtures", p), "utf8"));
const cafe: Understanding = fixture("inbound/referral-cafe-aurora.expected.json").understanding;
const acme: Understanding = fixture("inbound/acme-supplier-invitation.expected.json").understanding;
const voice = fixture("voice/expected.json").scripts as { id: string; expected: Understanding }[];
const quoteU = voice.find((v) => v.id === "vn2-quote-cafe-aurora")?.expected as Understanding;
const missingSeats = voice.find((v) => v.id === "vn3-register-vila-nova-missing-seats")
  ?.expected as Understanding;
const draft: SkillDraft = fixture("teach/caravela-register-deal.expected.json").draft;
const profile = fixture("profile/tidewater.json") as Record<string, string>;

const ref = (id: string, mime: string): ArtifactRef => ({
  id,
  sha256: id,
  mime,
  bytes: 1,
  relPath: `artifacts/${id}`,
});
const files = {
  w9: { file: ref("W9", "application/pdf"), filename: "w9-sample.pdf" },
  coi: { file: ref("COI", "application/pdf"), filename: "insurance-certificate-sample.pdf" },
};

function store(o: { skills?: Skill[]; draft?: SkillDraft } = {}): SkillStore {
  const skills = o.skills ?? [];
  return {
    active: (name) => skills.find((s) => s.name === name),
    get: (name, version) => skills.find((s) => s.name === name && s.version === version),
    list: () =>
      skills.map((s) => ({ name: s.name, title: s.title, activeVersion: s.version, versions: s.version })),
    saveVersion: () => {
      throw new Error("not in a pure test");
    },
    activate: () => {},
    saveDraft: () => "D1",
    getDraft: () => o.draft,
    draftForPortal: (portalId) =>
      o.draft && o.draft.portalId === portalId ? { id: "D1", draft: o.draft } : undefined,
  };
}

function ctx(skills: SkillStore, over: Partial<BuildPlanContext> = {}): BuildPlanContext {
  return {
    jobId: "01JOB",
    skills,
    rep: {
      phone: "5511999990001",
      name: "Ana Ribeiro",
      tz: "America/Sao_Paulo",
      locale: "pt-BR",
      languageBias: ["Portuguese", "English"],
    },
    company: profile,
    companyFiles: files,
    attachments: [],
    clock: createFixedClock(Date.UTC(2026, 9, 27, 13, 0, 0)),
    portals: {
      [CARAVELA]: {
        ...(PORTAL_DEFAULTS[CARAVELA] as { id: string; name: string; startPath: string }),
        url: "http://127.0.0.1:5101",
      },
      [SUPPLIER]: {
        ...(PORTAL_DEFAULTS[SUPPLIER] as { id: string; name: string; startPath: string }),
        url: "http://127.0.0.1:5102",
      },
    },
    ...over,
  };
}

const spec = (name: string, type: ParamSpec["type"], required = true, enumValues?: string[]): ParamSpec => ({
  name,
  type,
  required,
  description: name,
  ...(enumValues ? { enumValues } : {}),
});

const caravelaV1: Skill = {
  name: "register_partner_deal",
  version: 1,
  parentVersion: null,
  title: "Register a partner deal",
  portalId: CARAVELA,
  params: [
    spec("company", "string"),
    spec("website", "string", false),
    spec("country", "enum", true, ["Brazil", "Chile"]),
    spec("city", "string"),
    spec("contact_name", "string"),
    spec("contact_email", "email"),
    spec("product", "enum", true, [
      "Tidewater Cloud Starter",
      "Tidewater Cloud Business",
      "Tidewater Cloud Enterprise",
    ]),
    spec("seats", "number"),
    spec("est_value", "number", false),
    spec("close_date", "date"),
    spec("referral_partner", "string", false),
  ],
  steps: [
    { id: "s1", intent: "Open the form", op: "goto", url: "http://127.0.0.1:5101/deals/new" },
    {
      id: "s2",
      intent: "Company",
      op: "fill",
      target: { candidates: [], fingerprint: { tag: "input", bbox: { x: 0, y: 0, w: 1, h: 1 } } },
      value: "{{company}}",
    },
  ],
  success: { extract: [{ name: "registration_id", regex: "NW-REG-\\d{5}" }] },
  createdFrom: { kind: "video", traceRunId: "R1" },
  changelog: "",
};

/** The draft Muse Wonder returned for the teach video, as recorded live (fixtures/cassettes/teach). */
function recordedTeachDraft(): SkillDraft {
  const tape = JSON.parse(
    readFileSync(join(root, "fixtures", "cassettes", "teach", "teach-934b313cee29b7eb.json"), "utf8"),
  );
  const find = (o: unknown): string | undefined => {
    if (typeof o === "string") return o.includes('"commitStep"') ? o : undefined;
    if (o && typeof o === "object")
      for (const v of Object.values(o)) {
        const hit = find(v);
        if (hit) return hit;
      }
    return undefined;
  };
  const raw = JSON.parse(find(tape) ?? "{}") as SkillDraft & { params: Record<string, unknown>[] };
  // The wire format sends absent optionals as null (the gateway drops them the same way).
  return SkillDraft.parse({
    ...raw,
    params: raw.params.map((p) => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== null))),
  });
}

describe("buildPlan: register_deal from the recorded live teach draft", () => {
  it("uses the request's seats when a live draft guessed the wrong type for them (seats: boolean)", () => {
    const recorded = recordedTeachDraft();
    const wrong = {
      ...recorded,
      params: recorded.params.map((p) => (p.name === "seats" ? { ...p, type: "boolean" as const } : p)),
    };
    const out = buildPlan(cafe, ctx(store({ draft: wrong })));
    const action = out.type === "plan" ? out.plan.actions[0] : undefined;
    expect(action?.kind === "computer_use" ? action.params.seats : undefined).toBe(25);
  });

  it("treats the video's enum values as examples and the consent box as a constant tick", () => {
    const recorded = recordedTeachDraft();
    expect(recorded.params.find((p) => p.name === "country")?.enumValues).not.toContain("United States");
    expect(recorded.params.find((p) => p.type === "boolean")).toMatchObject({ required: true });
    const out = buildPlan({ ...cafe, country: "United States" }, ctx(store({ draft: recorded })));
    expect(out.type, JSON.stringify(out)).toBe("plan");
    const action = out.type === "plan" ? out.plan.actions[0] : undefined;
    expect(action?.kind).toBe("computer_use");
    expect(action?.kind === "computer_use" ? action.params : {}).toMatchObject({
      end_customer_company: "Café Aurora Ltda.",
      country: "United States",
      end_customer_agreed_to_be_contacted: true,
    });
  });
});

describe("buildPlan: register_deal", () => {
  it("replays the active Caravela skill with params from the Understanding, never est_value", () => {
    const out = buildPlan(cafe, ctx(store({ skills: [caravelaV1] })));
    expect(out.type).toBe("plan");
    if (out.type !== "plan") return;
    expect(out.plan.writes).toBe(true);
    expect(out.plan.actions).toEqual([
      {
        kind: "skill_replay",
        skill: "register_partner_deal",
        version: 1,
        params: {
          company: "Café Aurora Ltda.",
          website: "cafeaurora.example",
          country: "Brazil",
          city: "São Paulo",
          contact_name: "Júlia Prado",
          contact_email: "julia@cafeaurora.example",
          product: "Tidewater Cloud Business",
          seats: 25,
          close_date: "2027-01-29",
          referral_partner: "Rota Consultoria",
        },
      },
    ]);
    expect(out.plan.approvalText).toContain("register_partner_deal v1");
    expect(out.plan.approvalText).toContain("• Close date: 29 Jan 2027");
  });

  it("runs computer use guided by the teach draft when no skill exists yet", () => {
    const out = buildPlan(cafe, ctx(store({ draft })));
    if (out.type !== "plan") throw new Error(out.type);
    const [action] = out.plan.actions;
    expect(action).toMatchObject({
      kind: "computer_use",
      portalId: CARAVELA,
      startUrl: "http://127.0.0.1:5101/deals/new",
      draftId: "D1",
      compileAs: "register_partner_deal",
    });
    if (action?.kind !== "computer_use") return;
    expect(action.params).toMatchObject({
      company_name: "Café Aurora Ltda.",
      expected_close_date: "2027-01-29",
      seats: 25,
    });
    expect(action.params).not.toHaveProperty("estimated_value_usd");
    expect(action.goal).toContain('before you click "Submit registration"');
  });

  it("asks for a screen recording when it knows neither a skill nor a draft", () => {
    const out = buildPlan(cafe, ctx(store()));
    expect(out).toMatchObject({ type: "reply" });
    if (out.type === "reply") expect(out.text).toContain("Send me a screen recording");
  });

  it("asks for missing required info instead of planning", () => {
    const out = buildPlan(missingSeats, ctx(store({ skills: [caravelaV1] })));
    expect(out).toMatchObject({ type: "ask", missing: ["seats"] });
    if (out.type === "ask") expect(out.question).toContain("I still need: seats");
  });

  it("refuses an option the portal does not list", () => {
    const out = buildPlan(
      { ...cafe, product: "Tidewater Cloud Platinum" },
      ctx(store({ skills: [caravelaV1] })),
    );
    expect(out).toMatchObject({ type: "ask", missing: ["product"] });
  });
});

describe("buildPlan: supplier_onboarding", () => {
  it("names the buyer company, not the contact, from the recorded live understanding of the Acme PDF", () => {
    const tape = JSON.parse(
      readFileSync(
        join(root, "fixtures", "cassettes", "understand", "understand-abe7197a70878dda.json"),
        "utf8",
      ),
    );
    const find = (o: unknown): string | undefined => {
      if (typeof o === "string") return o.includes('"buyerName"') ? o : undefined;
      if (o && typeof o === "object")
        for (const v of Object.values(o)) {
          const hit = find(v);
          if (hit) return hit;
        }
      return undefined;
    };
    const recorded = JSON.parse(find(tape) ?? "{}") as Understanding;
    expect(recorded).toMatchObject({ buyerName: "Laura Bennett", contactName: "Laura Bennett" });
    const u = normalizeUnderstanding(recorded);
    expect(u.buyerName).toBe("Acme Group");
    const out = buildPlan(u, ctx(store()));
    if (out.type !== "plan") throw new Error(out.type);
    expect(out.plan.approvalText).toContain("supplier for Acme Group (invite ACME-7731)");
    expect(out.plan.approvalText).not.toContain("Laura Bennett");
  });

  it("plans a zero-shot run from the profile, the invite and both files", () => {
    const out = buildPlan(acme, ctx(store()));
    if (out.type !== "plan") throw new Error(out.type);
    const [action] = out.plan.actions;
    expect(action).toMatchObject({
      kind: "computer_use",
      portalId: SUPPLIER,
      startUrl: "http://127.0.0.1:5102/t/acme/invite/ACME-7731",
      compileAs: "supplier_onboarding",
    });
    if (action?.kind !== "computer_use") return;
    expect(action.params).toMatchObject({
      tenant: "acme",
      invite_code: "ACME-7731",
      legal_name: "Tidewater Cloud Ltda.",
      bank_confirm: true,
    });
    expect(action.params.w9).toEqual(files.w9);
    expect(action.goal).toContain("request_commit before the final submit");
    expect(out.plan.approvalText).toContain("stop before the final submit");
  });

  it("replays the supplier skill with the invitation's tenant and code", () => {
    const skill: Skill = {
      ...caravelaV1,
      name: "supplier_onboarding",
      portalId: SUPPLIER,
      params: [
        spec("tenant", "string"),
        spec("invite_code", "string"),
        spec("legal_name", "string"),
        spec("w9", "file"),
        spec("coi", "file"),
        { ...spec("company_tax_id", "string"), example: "00-1234567" },
      ],
    };
    const globex = {
      ...acme,
      tenant: null,
      inviteCode: null,
      portalUrl: "http://localhost:5102/t/globex/invite/GLOBEX-2048",
      buyerName: "Globex Industrial",
    };
    const out = buildPlan(globex, ctx(store({ skills: [skill] })));
    if (out.type !== "plan") throw new Error(out.type);
    expect(out.plan.actions[0]).toMatchObject({
      kind: "skill_replay",
      params: {
        tenant: "globex",
        invite_code: "GLOBEX-2048",
        legal_name: "Tidewater Cloud Ltda.",
        company_tax_id: "00-1234567",
        w9: files.w9,
        coi: files.coi,
      },
    });
  });

  it("asks for the invite when the letter has none", () => {
    expect(
      buildPlan({ ...acme, tenant: null, inviteCode: null, portalUrl: null }, ctx(store())),
    ).toMatchObject({
      type: "ask",
      missing: ["tenant", "invite code"],
    });
  });
});

describe("buildPlan: quote", () => {
  it("plans company, deal, PDF, attachment and a reply in the buyer's language", () => {
    const out = buildPlan(quoteU, ctx(store()));
    if (out.type !== "plan") throw new Error(out.type);
    expect(out.plan.actions.map((a) => a.kind)).toEqual([
      "crm_upsert_company",
      "crm_create_deal",
      "quote_pdf",
      "crm_attach_quote",
      "draft_reply",
    ]);
    expect(out.plan.actions[1]).toEqual({
      kind: "crm_create_deal",
      name: "Café Aurora · 25 seats · Business",
      amountMinor: 3_213_000,
      currency: "BRL",
      closeDate: "2026-12-31",
    });
    expect(out.plan.actions[2]).toMatchObject({
      kind: "quote_pdf",
      request: {
        company: "Café Aurora",
        seats: 25,
        startDate: "2027-01-01",
        currency: "BRL",
        language: "pt-BR",
        plan: "business",
      },
    });
    expect(out.plan.approvalText).toContain("R$ 32.130,00");
  });

  it("asks for the company and seats when they are missing", () => {
    expect(buildPlan({ ...quoteU, company: null, seats: null }, ctx(store()))).toMatchObject({
      type: "ask",
      missing: ["company", "seats"],
    });
  });
});

describe("buildPlan: teach, question, unknown", () => {
  it("plans a teach action for an mp4 attachment, without a plan gate", () => {
    const video = ref("V1", "video/mp4");
    const out = buildPlan(blankUnderstanding("teach"), ctx(store(), { attachments: [video] }));
    expect(out).toMatchObject({ type: "plan", plan: { writes: false, actions: [{ kind: "teach", video }] } });
  });

  it("answers questions and unknown requests with the fixed list of what Dockhand does", () => {
    expect(buildPlan(blankUnderstanding("question"), ctx(store()))).toEqual({
      type: "reply",
      text: WHAT_I_DO,
    });
    expect(buildPlan(blankUnderstanding("unknown"), ctx(store()))).toEqual({
      type: "reply",
      text: WHAT_I_DO,
    });
  });
});

describe("syntheticParamSets", () => {
  it("varies only free text, keeping options, codes, URLs and files", () => {
    const target = { candidates: [], fingerprint: { tag: "input", bbox: { x: 0, y: 0, w: 1, h: 1 } } };
    const skill = {
      params: [
        spec("company", "string"),
        spec("country", "enum", true, ["Brazil", "Chile"]),
        spec("tax_id", "string"),
        spec("email", "email"),
        spec("close", "date"),
        spec("w9", "file"),
      ],
      steps: [
        {
          id: "a",
          intent: "",
          op: "fill" as const,
          target,
          value: "{{company}} / {{tax_id}} / {{email}} / {{close|date:DD/MM/YYYY}}",
        },
        { id: "b", intent: "", op: "select" as const, trigger: target, option: "{{country}}" },
      ],
    };
    const [set] = syntheticParamSets(
      skill,
      {
        company: "Café Aurora Ltda.",
        country: "Brazil",
        tax_id: "00-1234567",
        email: "a@b.example",
        close: "2027-01-29",
        w9: files.w9,
      },
      1,
    );
    expect(set).toEqual({
      company: "Café Aurora Ltda. Norte",
      country: "Brazil",
      tax_id: "00-1234567",
      email: "canary1.a@b.example",
      close: "2027-02-05",
      w9: files.w9,
    });
  });
});

// Deterministic plan builders, one per intent (architect review §1.2). Pure: the same Understanding and
// context always give the same plan, approval text and question.

import type {
  ArtifactRef,
  ParamSpec,
  ParamValue,
  Plan,
  PlanAction,
  PlanContext,
  Skill,
  SkillDraft,
  Transcript,
  Understanding,
} from "@dockhand/core";
import { cardBody } from "./messages.ts";
import {
  type FileParam,
  humanize,
  paramsFromProfile,
  paramsFromUnderstanding,
  profileParams,
} from "./params.ts";
import { CARAVELA, ESPOCRM, type PortalInfo, parseInviteUrl, SUPPLIER, startUrlFor } from "./portals.ts";
import { quoted } from "./sanitize.ts";
import { addDaysIso, firstOfNextMonth, todayIso } from "./time.ts";
import {
  defaultPlan,
  formatMoney,
  PRICE_BOOK,
  type PricedQuoteRequest,
  planFromText,
  priceQuote,
} from "./tools/quotes.ts";

export type PlanOutcome =
  | { type: "plan"; plan: Plan }
  | { type: "ask"; missing: string[]; question: string }
  | { type: "reply"; text: string };

export interface BuildPlanContext extends PlanContext {
  portals: Record<string, PortalInfo>;
  /** Upload slot -> company document (w9, coi) for supplier onboarding. */
  companyFiles: Record<string, FileParam>;
  /** Transcript of a teach video's narration, when intake already made one. */
  narration?: Transcript;
}

export const SUPPLIER_SKILL = "supplier_onboarding";
/**
 * Computer-use action budgets for first runs. §2.8 said 30 and 80, but the loop counts single actions and a
 * field takes click + select-all + type: 13 Caravela fields need ~45, the 40-field supplier wizard ~130.
 */
export const FIRST_RUN_LIMITS = { [CARAVELA]: 60, [SUPPLIER]: 160, [ESPOCRM]: 60 } as const;

export const WHAT_I_DO = [
  "I'm Dockhand. Forward me the work and I do it in your sales tools:",
  "• *Quote*: a pricing request (voice note or text). I create the HubSpot company and deal, the quote PDF and a reply for you to send.",
  "• *Partner deal*: a photo of the signed referral form. I register it on Caravela Partner Hub.",
  "• *Supplier onboarding*: the buyer's invitation PDF. I fill their supplier portal and stop before the final submit.",
  "• *Teach me*: a screen recording (mp4) of you doing a portal task once.",
  "Commands: /skills, /history, /stats, /rollback <skill> <version>",
].join("\n");

export function buildPlan(u: Understanding, ctx: BuildPlanContext): PlanOutcome {
  switch (u.intent) {
    case "quote":
      return planQuote(u, ctx);
    case "register_deal":
      return planRegisterDeal(u, ctx);
    case "supplier_onboarding":
      return planSupplier(u, ctx);
    case "teach":
      return planTeach(ctx);
    default:
      return { type: "reply", text: WHAT_I_DO };
  }
}

// ---------- helpers ----------

function plan(
  ctx: BuildPlanContext,
  u: Understanding,
  actions: PlanAction[],
  writes: boolean,
  approvalText: string,
): PlanOutcome {
  return { type: "plan", plan: { jobId: ctx.jobId, intent: u.intent, actions, writes, approvalText } };
}

function ask(
  missing: ParamSpec[] | string[],
  what: string,
  rejected: { spec: ParamSpec; value: string }[] = [],
): PlanOutcome {
  const names = missing.map((m) => (typeof m === "string" ? m : m.name));
  const items = missing.map((m) => {
    if (typeof m === "string") return humanize(m);
    const options = m.enumValues?.length ? ` (${m.enumValues.join(", ")})` : "";
    return `${humanize(m.name)}${options}`;
  });
  const bad = rejected.map((r) => `"${r.value}" is not an option for ${humanize(r.spec.name)}.`);
  return {
    type: "ask",
    missing: names,
    question: [
      `To ${what} I still need: ${items.join("; ")}.`,
      ...bad,
      "Reply with the missing details.",
    ].join("\n"),
  };
}

/** The active skill for a portal: by its usual name first, then any active skill on that portal. */
export function activeSkillFor(
  skills: PlanContext["skills"],
  portalId: string,
  preferred?: string,
): Skill | undefined {
  if (preferred) {
    const s = skills.active(preferred);
    if (s?.portalId === portalId) return s;
  }
  for (const row of skills.list()) {
    const s = skills.active(row.name);
    if (s?.portalId === portalId) return s;
  }
  return undefined;
}

export function displayValue(v: ParamValue): string {
  if (typeof v === "object") return v.filename;
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split("-");
    const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][
      Number(m) - 1
    ];
    return `${Number(d)} ${month} ${y}`;
  }
  return String(v);
}

function valueLines(params: Record<string, ParamValue>, max = 14): string[] {
  const entries = Object.entries(params);
  const lines = entries.slice(0, max).map(([k, v]) => `• ${capitalize(humanize(k))}: ${displayValue(v)}`);
  if (entries.length > max) lines.push(`• …and ${entries.length - max} more`);
  return lines;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------- register_deal ----------

function planRegisterDeal(u: Understanding, ctx: BuildPlanContext): PlanOutcome {
  const portal = ctx.portals[CARAVELA];
  if (!portal) return { type: "reply", text: "Caravela Partner Hub is not configured on this Dockhand." };
  const skill = activeSkillFor(ctx.skills, CARAVELA, "register_partner_deal");
  if (skill) {
    const m = paramsFromUnderstanding(skill.params, u);
    if (m.missing.length > 0 || m.rejected.length > 0) {
      return ask(
        [...m.missing, ...m.rejected.map((r) => r.spec)],
        `register this deal on ${portal.name}`,
        m.rejected,
      );
    }
    return plan(
      ctx,
      u,
      [{ kind: "skill_replay", skill: skill.name, version: skill.version, params: m.params }],
      true,
      cardBody(
        [`Register this deal on ${portal.name} (${skill.name} v${skill.version}):`],
        valueLines(m.params),
        ["I'll fill the form and show it to you before submitting."],
      ),
    );
  }

  const found = ctx.skills.draftForPortal(CARAVELA);
  if (found) {
    const draft = found.draft;
    const m = paramsFromUnderstanding(draft.params, u, { fromDraft: true });
    if (m.missing.length > 0 || m.rejected.length > 0) {
      return ask(
        [...m.missing, ...m.rejected.map((r) => r.spec)],
        `register this deal on ${portal.name}`,
        m.rejected,
      );
    }
    return plan(
      ctx,
      u,
      [
        {
          kind: "computer_use",
          portalId: CARAVELA,
          startUrl: startUrlFor(portal, draft.startUrl, m.params),
          draftId: found.id,
          goal: firstRunGoal(draft, portal),
          params: m.params,
          compileAs: draft.name,
        },
      ],
      true,
      cardBody(
        [
          `Register this deal on ${portal.name}. First time: computer use, following the steps you taught me, then I turn the run into a skill.`,
        ],
        valueLines(m.params),
        ["I'll show you the filled form before submitting."],
      ),
    );
  }

  return {
    type: "reply",
    text: `I haven't learned ${portal.name} yet. Send me a screen recording (mp4, as a document is best) of you registering one deal, and I'll learn it.`,
  };
}

function firstRunGoal(draft: SkillDraft, portal: PortalInfo): string {
  return `${draft.goal} Work on ${portal.name}. Use exactly the values given below. When every field is filled, ask for approval with request_commit before you click ${quoted(draft.commitStep)}. Finish when the screen shows: ${draft.success}`;
}

// ---------- supplier_onboarding ----------

function planSupplier(u: Understanding, ctx: BuildPlanContext): PlanOutcome {
  const portal = ctx.portals[SUPPLIER];
  if (!portal) return { type: "reply", text: "The supplier portal is not configured on this Dockhand." };
  const fromUrl = parseInviteUrl(u.portalUrl);
  const tenant = u.tenant ?? fromUrl?.tenant ?? null;
  const inviteCode = u.inviteCode ?? fromUrl?.inviteCode ?? null;
  if (!tenant || !inviteCode) {
    return ask(
      [...(tenant ? [] : ["tenant"]), ...(inviteCode ? [] : ["invite code"])],
      "start the supplier registration",
    );
  }
  const buyer = u.buyerName ?? u.company ?? tenant;
  const files = ctx.companyFiles;
  const missingFiles = ["w9", "coi"].filter((slot) => !files[slot]);
  if (missingFiles.length > 0) {
    return {
      type: "reply",
      text: `The company profile has no ${missingFiles.join(" and ")} document to upload.`,
    };
  }
  const company = ctx.company;
  const keyFacts = [
    `• Legal name: ${company.legalName ?? "?"}`,
    `• Tax ID: ${company.taxId ?? "?"}`,
    `• Address: ${[company.street1, company.city, company.country].filter(Boolean).join(", ")}`,
    `• Primary contact: ${company.primaryContactName ?? "?"} (${company.primaryContactEmail ?? "?"})`,
    `• Bank: ${company.bankName ?? "?"}`,
    `• Files: ${Object.values(files)
      .map((f) => f.filename)
      .join(", ")}`,
  ];

  const skill = activeSkillFor(ctx.skills, SUPPLIER, SUPPLIER_SKILL);
  if (skill) {
    const m = paramsFromProfile(skill.params, company, { tenant, inviteCode, files });
    if (m.missing.length > 0) {
      return {
        type: "reply",
        text: `The company profile has no value for: ${m.missing.map((s) => humanize(s.name)).join(", ")}. Add it to the profile and send the invitation again.`,
      };
    }
    return plan(
      ctx,
      u,
      [{ kind: "skill_replay", skill: skill.name, version: skill.version, params: m.params }],
      true,
      [
        `Register Tidewater Cloud as a supplier for ${buyer} (invite ${inviteCode}) with ${skill.name} v${skill.version}: ${Object.keys(m.params).length} values from the company profile.`,
        ...keyFacts,
        "I'll stop before the final submit and show you the filled form.",
      ].join("\n"),
    );
  }

  const params: Record<string, ParamValue> = {
    tenant,
    invite_code: inviteCode,
    ...profileParams(company),
    ...files,
  };
  return plan(
    ctx,
    u,
    [
      {
        kind: "computer_use",
        portalId: SUPPLIER,
        startUrl: startUrlFor(portal, undefined, params),
        goal: supplierGoal(buyer),
        params,
        compileAs: SUPPLIER_SKILL,
      },
    ],
    true,
    [
      `Register Tidewater Cloud as a supplier for ${buyer} (invite ${inviteCode}). First time on this portal: computer use fills every step from the company profile and uploads the documents.`,
      ...keyFacts,
      "I'll stop before the final submit and show you the filled form.",
    ].join("\n"),
  );
}

export function supplierGoal(buyer: string): string {
  return [
    `Register Tidewater Cloud as a supplier for ${quoted(buyer)} on this supplier portal, starting from the invitation page that is open.`,
    "Start the registration, then fill every field on every step of the wizard with the values given (use the value whose name matches the field), choosing options exactly as given.",
    'Upload the W-9 into the W-9 field with attach_file slot "w9" and the certificate of insurance with slot "coi".',
    "Go through each step with its Next button. On the last step, call request_commit before the final submit and submit only after approval.",
    "Finish when the screen shows the registration confirmation with the supplier ID.",
  ].join(" ");
}

// ---------- quote ----------

function planQuote(u: Understanding, ctx: BuildPlanContext): PlanOutcome {
  const missing: string[] = [];
  if (!u.company) missing.push("company");
  if (!u.seats) missing.push("seats");
  if (missing.length > 0 || !u.company || !u.seats) return ask(missing, "prepare this quote");
  const today = todayIso(ctx.clock.now(), ctx.rep.tz);
  const country = u.country ?? "";
  const brazil = country === "Brazil" || (country === "" && u.language === "pt");
  const language = u.language === "pt" ? "pt-BR" : "en";
  const startDate = u.startDate && u.startDate > today ? u.startDate : firstOfNextMonth(today);
  const planId = planFromText(u.product) ?? defaultPlan(u.seats);
  const request: PricedQuoteRequest = {
    company: u.company,
    city: u.city ?? "",
    country,
    seats: u.seats,
    startDate,
    currency: brazil ? "BRL" : "USD",
    language,
    plan: planId,
  };
  const quote = priceQuote(request, today);
  const dayBefore = addDaysIso(startDate, -1);
  const closeDate = u.closeDate ?? (dayBefore > today ? dayBefore : addDaysIso(today, 30));
  const planName = PRICE_BOOK[planId].name;
  const dealName = `${u.company} · ${u.seats} seats · ${planName.replace("Tidewater Cloud ", "")}`;
  const total = formatMoney(quote.totalMinor, quote.currency, language);
  return plan(
    ctx,
    u,
    [
      {
        kind: "crm_upsert_company",
        company: u.company,
        ...(u.city ? { city: u.city } : {}),
        ...(country ? { country } : {}),
      },
      {
        kind: "crm_create_deal",
        name: dealName,
        amountMinor: quote.totalMinor,
        currency: quote.currency,
        closeDate,
      },
      { kind: "quote_pdf", request },
      { kind: "crm_attach_quote" },
      { kind: "draft_reply", language },
    ],
    true,
    [
      `Quote for ${u.company}: ${u.seats} seats of ${planName}, starting ${displayValue(startDate)}.`,
      `• HubSpot company: ${u.company}${u.city ? ` (${u.city})` : ""}, found or created`,
      `• HubSpot deal: "${dealName}", ${total}, close ${displayValue(closeDate)}`,
      `• Quote PDF (${language}), ${total} for 12 months, attached to the deal`,
      `• A reply in ${language === "pt-BR" ? "Portuguese" : "English"} for you to forward`,
    ].join("\n"),
  );
}

// ---------- teach ----------

function planTeach(ctx: BuildPlanContext): PlanOutcome {
  const video: ArtifactRef | undefined = ctx.attachments.find(
    (a) => a.mime.split(";")[0]?.trim() === "video/mp4",
  );
  if (!video) {
    return {
      type: "reply",
      text: "To teach me a task, send a screen recording of you doing it once, as an mp4 (video or document).",
    };
  }
  return {
    type: "plan",
    plan: {
      jobId: ctx.jobId,
      intent: "teach",
      actions: [{ kind: "teach", video, ...(ctx.narration ? { narration: ctx.narration } : {}) }],
      writes: false,
      approvalText: "",
    },
  };
}

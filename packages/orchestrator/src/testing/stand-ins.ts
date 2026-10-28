// Scripted stand-ins for every model call, for META_MODE=fake: the E2E harness, CI and `pnpm dev` without keys.
// Fixture-backed answers (extraction by file hash, understanding by what the prompt mentions, the teach draft),
// a heal_match stand-in that knows the mock portals' renames, and computer-use scripts built from each run's
// values. None of it says anything about model quality: ledger rows are provider "fake" or "scripted" at $0,
// and nothing produced here may appear in reported numbers.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createScriptedModel } from "@dockhand/browser";
import {
  type CallCtx,
  type Clock,
  type ComputerUseModel,
  type CuSession,
  type Ledger,
  type ModelGateway,
  type ParamValue,
  type ScriptStep,
  type StructuredRequest,
  type Understanding,
  workspaceRoot,
} from "@dockhand/core";
import { createFakeModelGateway, type FakeGatewayOptions } from "@dockhand/meta";
import { SUPPLIER_FIELDS } from "@dockhand/portals";
import type { Page } from "playwright";
import type { CuModelSource } from "../flows/env.ts";
import { snakeCase } from "../params.ts";
import { isoToDmy } from "../time.ts";
import type { Extraction } from "../understand.ts";

const FIXTURES = () => join(workspaceRoot(), "fixtures");

// ---------- fixtures ----------

interface InboundFixture {
  file: string;
  sha256: string;
  extraction: Extraction;
  understanding: Understanding;
  key: string;
}

let inboundCache: InboundFixture[] | undefined;

/** Every fixtures/inbound/* file with its expected extraction and Understanding. */
export function inboundFixtures(): InboundFixture[] {
  if (inboundCache) return inboundCache;
  const dir = join(FIXTURES(), "inbound");
  inboundCache = readdirSync(dir)
    .filter((f) => f.endsWith(".expected.json"))
    .map((f) => {
      const e = JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown> & {
        fixture: string;
        understanding: Understanding;
      };
      const file = join(workspaceRoot(), e.fixture);
      const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
      const referral = e.kind === "partner_referral_form";
      const facts = referral
        ? (e.asWritten as Record<string, string>)
        : {
            buyer: String(e.buyer),
            invite_url: String(e.portalUrl),
            invite_code: String(e.inviteCode),
            deadline: String(e.deadlineAsWritten),
            reference: String(e.reference),
            documents_requested: (e.documentsRequested as string[]).join(", "),
          };
      return {
        file,
        sha256,
        key: referral ? (e.understanding.company ?? "") : String(e.inviteCode),
        understanding: e.understanding,
        extraction: {
          documentType: referral ? "partner_referral_form" : "supplier_registration_invitation",
          language: (e.understanding.language ?? "en") as Extraction["language"],
          fields: Object.entries(facts).map(([name, value]) => ({
            name: name.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase(),
            value: String(value),
          })),
          summary: String(e.description ?? `${e.kind} from ${e.buyer ?? "a partner"}`),
        },
      };
    });
  return inboundCache;
}

export interface VoiceFixture {
  id: string;
  script: string;
  expected: Understanding;
  followUp?: { askFor: string; answer: string; resolves: Partial<Understanding> };
}

export function voiceFixtures(): VoiceFixture[] {
  const data = JSON.parse(readFileSync(join(FIXTURES(), "voice", "expected.json"), "utf8")) as {
    scripts: VoiceFixture[];
  };
  return data.scripts;
}

export function teachFixture(): { draft: Record<string, unknown>; videoPath: string } {
  const e = JSON.parse(
    readFileSync(join(FIXTURES(), "teach", "caravela-register-deal.expected.json"), "utf8"),
  ) as {
    draft: Record<string, unknown>;
  };
  return { draft: e.draft, videoPath: join(FIXTURES(), "teach", "caravela-register-deal.mp4") };
}

// ---------- structured answers ----------

const promptOf = (req: StructuredRequest<unknown>) =>
  req.input.map((p) => (p.type === "text" ? p.text : "")).join("\n");

/** The numbered inputs of an understanding prompt ("[1] Text from the rep: ..."), oldest first. */
function promptInputs(prompt: string): { kind: string; text: string }[] {
  const at = prompt.indexOf("What the rep sent, oldest first:");
  if (at < 0) return [];
  const body = prompt.slice(at).split("\n").slice(1).join("\n");
  return body
    .split(/^\[\d+\] /m)
    .filter((s) => s.trim() !== "")
    .map((s) => {
      const m = /^(Text from the rep|Caption from the rep|Voice note \(transcript\)): ([\s\S]*)$/.exec(
        s.trim(),
      );
      return m ? { kind: m[1] as string, text: (m[2] ?? "").trim() } : { kind: "document", text: s.trim() };
    });
}

const NUMBER_WORDS: Record<string, number> = {
  dez: 10,
  quinze: 15,
  vinte: 20,
  "vinte e cinco": 25,
  trinta: 30,
  "trinta e cinco": 35,
  quarenta: 40,
  "quarenta e cinco": 45,
  cinquenta: 50,
  sessenta: 60,
  setenta: 70,
  oitenta: 80,
  noventa: 90,
  cem: 100,
  ten: 10,
  fifteen: 15,
  twenty: 20,
  "twenty five": 25,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  hundred: 100,
};

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9@./ -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * What a follow-up text changes (stand-in for the model reading a correction such as "make it 30 seats" or an
 * answer such as "Quarenta."). Only plain, unambiguous patterns: seats, a DD/MM/YYYY close date, an email, a plan.
 */
export function textEdits(text: string, missing: string[]): Partial<Understanding> {
  const t = fold(text);
  const out: Partial<Understanding> = {};
  const seats =
    /(\d{1,5})\s*(seats?|assentos?|usuarios?|users?|licencas?|licenses?|pessoas|people)\b/.exec(t) ??
    /\b(?:seats?|assentos?|usuarios?|users?)\s*(?:=|:|to|para|is)?\s*(\d{1,5})\b/.exec(t);
  if (seats) out.seats = Number(seats[1]);
  else if (missing.includes("seats")) {
    const bare = /^\D{0,12}?(\d{1,5})\D{0,12}$/.exec(t)?.[1];
    const word = NUMBER_WORDS[t.replace(/[.!]+$/, "").trim()];
    if (bare) out.seats = Number(bare);
    else if (word) out.seats = word;
  }
  const dmy = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(t);
  if (dmy) out.closeDate = `${dmy[3]}-${String(dmy[2]).padStart(2, "0")}-${String(dmy[1]).padStart(2, "0")}`;
  const email = /[^\s@]+@[^\s@]+\.[a-z]{2,}/.exec(t);
  if (email) out.contactEmail = email[0];
  const plan = /\b(starter|business|enterprise)\b/.exec(t);
  if (plan?.[1]) out.product = `Tidewater Cloud ${plan[1].charAt(0).toUpperCase()}${plan[1].slice(1)}`;
  return out;
}

/** The fixture Understanding a prompt is about, with later texts applied as corrections. */
export function fixtureUnderstanding(prompt: string): Understanding {
  const inputs = promptInputs(prompt);
  let base: Understanding | undefined;
  let from = -1;
  inputs.forEach((input, i) => {
    if (base) return;
    const voice = voiceFixtures().find((v) => input.text.includes(v.script));
    const doc = voice ? undefined : inboundFixtures().find((f) => f.key && input.text.includes(f.key));
    const hit = voice?.expected ?? doc?.understanding;
    if (hit) {
      base = structuredClone(hit);
      from = i;
    }
  });
  if (!base) {
    // Prompts built elsewhere (unit tests) carry the fixture text without the numbered list.
    const voice = voiceFixtures().find((v) => prompt.includes(v.script));
    const doc = inboundFixtures().find((f) => f.key && prompt.includes(f.key));
    base = structuredClone(voice?.expected ?? doc?.understanding);
  }
  if (!base) {
    return {
      ...(inboundFixtures()[0]?.understanding as Understanding),
      intent: "unknown",
      missing: [],
      summaryForRep: "Not a task.",
    };
  }
  for (const input of inputs.slice(from + 1)) {
    if (input.kind === "document") continue;
    const edits = textEdits(input.text, base.missing);
    Object.assign(base, edits);
    base.missing = base.missing.filter((m) => !(m in edits));
  }
  return base;
}

/** Answers structured calls from fixtures: extraction by file hash, understanding by what the prompt mentions. */
export function fixtureStructured(req: StructuredRequest<unknown>, ctx: CallCtx): unknown {
  switch (ctx.purpose) {
    case "extract": {
      const part = req.input.find((p) => p.type === "image" || p.type === "pdf");
      const sha = part?.type === "image" ? part.image.sha256 : part?.type === "pdf" ? part.file.sha256 : "";
      const hit = inboundFixtures().find((f) => f.sha256 === sha);
      if (!hit) {
        return {
          documentType: "other",
          language: "en",
          fields: [],
          summary: "A document Dockhand has no fixture for.",
        } satisfies Extraction;
      }
      return hit.extraction;
    }
    case "understand":
      return fixtureUnderstanding(promptOf(req));
    case "teach":
      return teachFixture().draft;
    case "compile_annotate":
      return {
        title: "",
        steps: [],
        params: [],
        success: { description: "", textPattern: null, idRegex: null, idName: null },
      };
    case "heal_match":
      return pickEquivalent(req);
    default:
      throw new Error(`fixture gateway has no answer for purpose ${ctx.purpose}`);
  }
}

// ---------- heal_match stand-in ----------

/**
 * Names the mock portals use for the same control (v1 vs v2, label_synonym, button_rename). A real model needs
 * no table; the stand-in does, so the heal ladder can run end to end without keys.
 */
const SAME_THING: readonly (readonly string[])[] = [
  [
    "Submit registration",
    "Register opportunity",
    "Send registration",
    "Submit deal",
    "Confirm registration",
    "Register deal",
    "Send for review",
  ],
  ["Product", "Solution", "Offering", "Product line", "Plan"],
  ["End customer company", "Customer account name", "Customer company name", "End-user organization"],
  ["Company website", "Customer website", "Website URL", "Company URL"],
  ["Country", "Country / region", "Customer country", "Country of operation"],
  ["City", "Town / city", "Customer city", "City / municipality"],
  ["Contact full name", "Contact name", "Primary contact", "Customer contact name"],
  ["Contact email", "Email address", "Contact e-mail", "Business email"],
  ["Contact phone", "Phone number", "Contact telephone", "Mobile / phone"],
  ["Seats", "Number of users", "Licenses", "Seat count"],
  ["Estimated value (USD)", "Deal size (USD)", "Projected revenue (USD)", "Opportunity amount (USD)"],
  ["Expected close date", "Target close date", "Anticipated close date", "Forecast close date"],
  ["Referral partner", "Referred by", "Referring partner", "Partner referral"],
  ["Notes", "Comments", "Additional details", "Deal notes"],
  ["Start registration", "Begin registration", "Get started", "Continue to registration"],
  ["Next", "Continue", "Save and continue", "Next step"],
  ["Submit for approval", "Send for approval", "Finish and submit"],
];

const bare = (s: string | undefined) =>
  (s ?? "")
    .replace(/^[\s*]+|[\s*:]+$/g, "")
    .trim()
    .toLowerCase();

/** Every name that means the same control as `name` (itself included). */
export function equivalentNames(name: string): string[] {
  const want = bare(name);
  const group = SAME_THING.find((g) => g.some((n) => bare(n) === want));
  return group ? [name, ...group.filter((n) => bare(n) !== want)] : [name];
}

/** heal_match stand-in: the listed element whose name or label means the same as the old one. */
export function pickEquivalent(req: StructuredRequest<unknown>): unknown {
  const lines = promptOf(req).split("\n");
  const prefix = "Element the step used before the change: ";
  const old = JSON.parse(
    (lines.find((l) => l.startsWith(prefix)) ?? prefix).slice(prefix.length) || "{}",
  ) as {
    name?: string;
    label?: string;
  };
  const list = JSON.parse(lines[lines.indexOf("Elements of the same kind on the page now:") + 1] ?? "[]") as {
    index: number;
    name?: string;
    label?: string;
  }[];
  const oldName = old.label ?? old.name ?? "";
  const names = new Set(equivalentNames(oldName).map(bare));
  const hits = list.filter((e) => names.has(bare(e.label)) || names.has(bare(e.name)));
  const hit = hits.length === 1 ? hits[0] : undefined;
  if (!hit) return { index: null, confidence: 0, reason: `nothing on the page does what '${oldName}' did` };
  return {
    index: hit.index,
    confidence: 0.92,
    reason: `'${hit.label ?? hit.name}' does what '${oldName}' did`,
  };
}

// ---------- computer-use scripts ----------

const s = (label: string, text: string): ScriptStep => ({ do: "fill", target: { label }, text });
const pick = (name: string, option: string): ScriptStep => ({
  do: "select",
  trigger: { role: "combobox", name },
  option,
});

/** The first run of a deal registration on Caravela Partner Hub v1 (starting on /deals/new). */
export function caravelaScript(v: {
  company: string;
  website?: string;
  country: string;
  city: string;
  contactName: string;
  contactEmail: string;
  contactPhone?: string;
  product: string;
  seats: number;
  estimatedValue?: number;
  closeDateDmy: string;
  referralPartner?: string;
  notes?: string;
}): ScriptStep[] {
  return [
    s("End customer company", v.company),
    ...(v.website ? [s("Company website", v.website)] : []),
    pick("Country", v.country),
    s("City", v.city),
    s("Contact full name", v.contactName),
    s("Contact email", v.contactEmail),
    ...(v.contactPhone ? [s("Contact phone", v.contactPhone)] : []),
    pick("Product", v.product),
    s("Seats", String(v.seats)),
    ...(v.estimatedValue !== undefined ? [s("Estimated value (USD)", String(v.estimatedValue))] : []),
    s("Expected close date", v.closeDateDmy),
    ...(v.referralPartner ? [s("Referral partner", v.referralPartner)] : []),
    ...(v.notes ? [s("Notes", v.notes)] : []),
    {
      do: "check",
      target: { role: "checkbox", name: "The end customer agreed to be contacted by Caravela" },
    },
    { do: "call", name: "request_commit", args: { summary: `Register ${v.company}` } },
    { do: "click", target: { role: "button", name: "Submit registration" } },
    { do: "done", text: "Registration received." },
  ];
}

const textOf = (params: Record<string, ParamValue>, names: string[]): string | undefined => {
  for (const n of names) {
    const v = params[n];
    if (typeof v === "string" || typeof v === "number") return String(v);
  }
  return undefined;
};

/** caravelaScript from a first run's values, whatever names the teach draft gave them. */
export function caravelaScriptFromParams(params: Record<string, ParamValue>): ScriptStep[] {
  const get = (...names: string[]) => textOf(params, names);
  const close = get("expected_close_date", "close_date", "closing_date") ?? "";
  const value = get("estimated_value_usd", "estimated_value");
  const optional = (k: string, v: string | undefined) => (v ? { [k]: v } : {});
  return caravelaScript({
    company: get("company_name", "company", "end_customer_company", "customer_name") ?? "",
    country: get("country", "customer_country") ?? "",
    city: get("city", "customer_city") ?? "",
    contactName: get("contact_name", "contact_full_name", "contact") ?? "",
    contactEmail: get("contact_email", "email") ?? "",
    product: get("product", "plan") ?? "",
    seats: Number(get("seats", "seat_count", "users") ?? 0),
    closeDateDmy: /^\d{4}-\d{2}-\d{2}$/.test(close) ? isoToDmy(close) : close,
    ...optional("website", get("company_website", "website")),
    ...optional("contactPhone", get("contact_phone", "phone")),
    ...optional("referralPartner", get("referral_partner", "referred_by")),
    ...optional("notes", get("notes")),
    ...(value !== undefined ? { estimatedValue: Number(value) } : {}),
  });
}

/** Zero-shot supplier registration (acme layout) from the company profile, with both uploads. */
export function supplierScript(
  profile: Record<string, string>,
  tenant: "acme" | "globex" = "acme",
): ScriptStep[] {
  const out: ScriptStep[] = [{ do: "click", target: { role: "button", name: "Start registration" } }];
  let step: string | undefined;
  for (const f of SUPPLIER_FIELDS) {
    if (f.tenants && !f.tenants.includes(tenant)) continue;
    if (f.showWhen && profile[f.showWhen.key] !== String(f.showWhen.equals)) continue;
    if (step !== undefined && f.step !== step)
      out.push({ do: "click", target: { role: "button", name: "Next" } });
    step = f.step;
    const value = profile[f.key];
    if (value === undefined || value === "") continue;
    switch (f.type) {
      case "combobox":
        out.push(pick(f.label, value));
        break;
      case "radio":
        out.push({ do: "check", target: { role: "radio", name: value } });
        break;
      case "checkbox":
        if (value === "true" && f.defaultValue !== true)
          out.push({ do: "check", target: { role: "checkbox", name: f.label } });
        break;
      case "checkboxGroup":
        out.push({ do: "check", target: { role: "checkbox", name: value } });
        break;
      case "file":
        out.push(
          { do: "click", target: { role: "button", name: `Choose file for ${f.label}` } },
          { do: "call", name: "attach_file", args: { slot: f.key.replace(/File$/, "") } },
        );
        break;
      default:
        out.push(s(f.label, value));
    }
  }
  out.push(
    { do: "click", target: { role: "button", name: "Next" } },
    {
      do: "call",
      name: "request_commit",
      args: { summary: "Submit the Tidewater Cloud supplier registration" },
    },
    { do: "click", target: { role: "button", name: "Submit for approval" } },
    { do: "done", text: "Registration submitted." },
  );
  return out;
}

/** supplierScript from a first run's values (profile keys arrive snake_case; files as w9/coi slots). */
export function supplierScriptFromParams(params: Record<string, ParamValue>): ScriptStep[] {
  const profile: Record<string, string> = {};
  for (const f of SUPPLIER_FIELDS) {
    if (f.type === "file") {
      const slot = f.key.replace(/File$/, "");
      if (params[slot] !== undefined) profile[f.key] = slot;
      continue;
    }
    const v = params[snakeCase(f.key)];
    if (v !== undefined && typeof v !== "object") profile[f.key] = String(v);
  }
  const tenant = params.tenant === "globex" ? "globex" : "acme";
  return supplierScript(profile, tenant);
}

const quoted = (text: string, re: RegExp) => re.exec(text)?.[1];

/**
 * The stand-in for a rung-3 repair: reads the narrow goal the repairer wrote and the page, and does that one
 * step on the control that now means the same thing (or proposes it, for a commit step).
 */
export async function repairScript(instructions: string, page: Page): Promise<ScriptStep[]> {
  const goal = /^Goal: (.*)$/m.exec(instructions)?.[1] ?? "";
  const blocked = (why: string): ScriptStep[] => [{ do: "done", text: `BLOCKED: ${why}` }];
  const visible = async (role: string | undefined, name: string, label = false) => {
    const loc = label
      ? page.getByLabel(name, { exact: true })
      : page.getByRole(role as Parameters<Page["getByRole"]>[0], { name, exact: true });
    return (await loc.count().catch(() => 0)) === 1;
  };
  const oldCommit = quoted(goal, /it used to be labelled "([^"]+)"/);
  if (oldCommit) {
    for (const name of equivalentNames(oldCommit)) {
      if (await visible("button", name))
        return [{ do: "call", name: "propose_target", args: { target: { role: "button", name } } }];
    }
    return blocked(`no control on the page does what "${oldCommit}" did`);
  }
  const intent = quoted(goal, /^Complete only this step: (.*?)\.(?: Enter exactly| Do not change)/) ?? "";
  const value = quoted(goal, /Enter exactly "([^"]*)"/);
  const old = quoted(intent, /'([^']+)'/) ?? "";
  const verb = intent.split(" ")[0]?.toLowerCase() ?? "";
  for (const name of equivalentNames(old)) {
    if (verb === "select" && value !== undefined && (await visible("combobox", name)))
      return [pick(name, value), { do: "done", text: "Done." }];
    if (verb === "fill" && value !== undefined && (await visible(undefined, name, true)))
      return [s(name, value), { do: "done", text: "Done." }];
    if ((verb === "check" || verb === "uncheck") && (await visible("checkbox", name)))
      return [
        { do: "check", target: { role: "checkbox", name } },
        { do: "done", text: "Done." },
      ];
    if (verb === "click" && (await visible("button", name)))
      return [
        { do: "click", target: { role: "button", name } },
        { do: "done", text: "Done." },
      ];
  }
  return blocked(`no control on the page does what '${old || intent}' did`);
}

/** A scripted model whose script is planned when its session opens (the repair goal is only known then). */
function lazyScriptedModel(
  page: Page,
  opts: { ledger?: Ledger; model: string },
  plan: (instructions: string, page: Page) => Promise<ScriptStep[]>,
): ComputerUseModel {
  return {
    provider: "scripted",
    model: opts.model,
    open(o): CuSession {
      let inner: CuSession | undefined;
      return {
        imagesInChain: () => inner?.imagesInChain() ?? 0,
        async send(reply, ctx) {
          inner ??= createScriptedModel(await plan(o.instructions, page), page, opts).open(o);
          return inner.send(reply, ctx);
        },
      };
    },
  };
}

/**
 * Computer use for META_MODE=fake: first runs follow a script built from the run's values (Caravela deal
 * registration, supplier onboarding); repairs follow repairScript. Rows land in the ledger as provider "scripted".
 */
export function standInComputerUse(
  purpose: "cu_first_run" | "cu_repair",
  opts: { ledger?: Ledger } = {},
): CuModelSource {
  const model = `scripted-${purpose}`;
  return ({ page, portalId, params }) => {
    if (purpose === "cu_repair") return lazyScriptedModel(page, { ...opts, model }, repairScript);
    const values = params ?? {};
    const script =
      portalId === "supplier"
        ? supplierScriptFromParams(values)
        : portalId === "caravela"
          ? caravelaScriptFromParams(values)
          : [{ do: "done" as const, text: `BLOCKED: no stand-in script for portal ${portalId}` }];
    return createScriptedModel(script, page, { ...opts, model });
  };
}

/**
 * The ModelGateway for META_MODE=fake: fixture answers, the heal_match stand-in (rung 2 on), and transcripts
 * of the voice fixtures when the caller maps audio to a script. Overrides win.
 */
export function createStandInGateway(
  o: { ledger?: Ledger; clock?: Clock; overrides?: FakeGatewayOptions } = {},
): ModelGateway {
  return createFakeModelGateway({
    structured: fixtureStructured,
    transcribe: () => {
      throw new Error("fake mode has no transcript for this voice note");
    },
    openWeights: true,
    ...o.overrides,
    ...(o.ledger ? { ledger: o.ledger } : {}),
    ...(o.clock ? { clock: o.clock } : {}),
  });
}

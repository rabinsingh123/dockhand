// Values for skill params: from an Understanding (deal registration), from the company profile
// (supplier onboarding), and synthetic variants for canary dry runs. Pure functions.

import type {
  ArtifactRef,
  CompanyProfile,
  ParamSpec,
  ParamValue,
  SkillParamSpec,
  Step,
  Understanding,
} from "@dockhand/core";
import { addDaysIso, isIsoDate } from "./time.ts";

export type FileParam = { file: ArtifactRef; filename: string };

/**
 * Understanding field -> param names a skill may use for it (teach drafts and the annotator name params
 * freely). estValue is deliberately absent: referral forms state BRL while the Caravela field is USD,
 * and converting needs an exchange-rate policy we do not have.
 */
export const UNDERSTANDING_ALIASES: Partial<Record<keyof Understanding, string[]>> = {
  company: [
    "company_name",
    "company",
    "end_customer_company",
    "customer_company",
    "customer_name",
    "end_customer",
    "account_name",
    "customer",
  ],
  website: ["company_website", "website", "customer_website", "company_url", "url", "site"],
  country: ["country", "customer_country", "company_country"],
  city: ["city", "customer_city", "company_city"],
  contactName: [
    "contact_name",
    "contact_full_name",
    "customer_contact",
    "contact",
    "full_name",
    "contact_person",
  ],
  contactEmail: ["contact_email", "email", "customer_email", "contact_e_mail"],
  contactPhone: ["contact_phone", "phone", "contact_telephone", "telephone", "phone_number"],
  product: ["product", "plan", "product_name", "solution", "offering"],
  seats: ["seats", "seat_count", "licenses", "users", "quantity", "number_of_seats", "number_of_users"],
  closeDate: ["expected_close_date", "close_date", "closing_date", "expected_close", "target_close_date"],
  referralPartner: ["referral_partner", "referred_by", "partner", "referrer", "referring_partner"],
  notes: ["notes", "deal_notes", "comments", "additional_details"],
};

const TENANT_ALIASES = ["tenant", "tenant_slug", "buyer_tenant", "tenant_id"];
const INVITE_ALIASES = ["invite_code", "invitation_code", "invite", "code", "invite_id"];
export const FILE_SLOTS: Record<string, string[]> = {
  w9: ["w9", "w9_file", "w9_form", "w_9", "w_9_form"],
  coi: ["coi", "coi_file", "certificate_of_insurance", "insurance_certificate", "insurance"],
};

/** Common non-English country names the model might still return. */
const COUNTRY_NAMES: Record<string, string> = {
  brasil: "Brazil",
  mexico: "Mexico",
  "estados unidos": "United States",
  eua: "United States",
  usa: "United States",
  espanha: "Spain",
  espana: "Spain",
  colombia: "Colombia",
  india: "India",
  indonesia: "Indonesia",
  filipinas: "Philippines",
  vietna: "Vietnam",
  "viet nam": "Vietnam",
  peru: "Peru",
  chile: "Chile",
  argentina: "Argentina",
  portugal: "Portugal",
};

export function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function canonicalCountry(s: string): string {
  return COUNTRY_NAMES[fold(s)] ?? s;
}

/** "expected_close_date" -> "expected close date". */
export function humanize(name: string): string {
  return name.replace(/_/g, " ");
}

export function snakeCase(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

/** An enum value as the portal lists it: exact (accent and case blind), then the one option containing it. */
export function matchEnum(value: string, options: readonly string[] | undefined): string | null {
  if (!options || options.length === 0) return value;
  const v = fold(canonicalCountry(value));
  const exact = options.find((o) => fold(o) === v);
  if (exact) return exact;
  const containing = v.length >= 3 ? options.filter((o) => fold(o).includes(v)) : [];
  return containing.length === 1 ? (containing[0] ?? null) : null;
}

export interface Mapped {
  params: Record<string, ParamValue>;
  /** Required params with no usable value. */
  missing: ParamSpec[];
  /** Values that could not be used (an option the portal does not list). */
  rejected: { spec: ParamSpec; value: string }[];
}

function coerce(spec: ParamSpec, raw: unknown): ParamValue | null {
  if (raw === null || raw === undefined || raw === "") return null;
  switch (spec.type) {
    case "number": {
      const n = typeof raw === "number" ? raw : Number(String(raw).replace(/[^\d.-]/g, ""));
      return Number.isFinite(n) ? n : null;
    }
    case "date":
      return typeof raw === "string" && isIsoDate(raw) ? raw : null;
    case "boolean":
      return typeof raw === "boolean" ? raw : raw === "true" ? true : raw === "false" ? false : null;
    case "file":
      return typeof raw === "object" && raw !== null && "file" in raw ? (raw as FileParam) : null;
    default:
      return typeof raw === "string" || typeof raw === "number" ? String(raw) : null;
  }
}

export interface MapOptions {
  /**
   * The specs come from a teach draft: its enum values are what the video happened to show (examples, not the
   * allowed set; the portal decides), and a required checkbox no request field maps to is a constant tick
   * (the compiled program checks it), never a question for the rep.
   */
  fromDraft?: boolean;
}

function finish(specs: SkillParamSpec[], found: Map<string, unknown>, o: MapOptions = {}): Mapped {
  const params: Record<string, ParamValue> = {};
  const missing: ParamSpec[] = [];
  const rejected: Mapped["rejected"] = [];
  for (const spec of specs) {
    // A param's default (the rep's answer to a drift-watch question) fills in when the request is silent.
    const raw = found.get(spec.name) ?? spec.default;
    let value = coerce(spec, raw);
    // A draft's types are the model's guess from a video (live Wonder once typed seats as boolean): a value
    // the request gives wins over a type that cannot hold it.
    if (value === null && o.fromDraft && (typeof raw === "number" || (typeof raw === "string" && raw !== "")))
      value = raw;
    if (value !== null && spec.type === "enum" && typeof value === "string") {
      const option = matchEnum(value, spec.enumValues);
      if (option !== null) value = option;
      else if (!o.fromDraft) {
        rejected.push({ spec, value });
        continue;
      }
    }
    if (value === null) {
      if (o.fromDraft && spec.type === "boolean" && spec.required && !found.has(spec.name)) {
        params[spec.name] = true;
        continue;
      }
      if (spec.required) missing.push(spec);
      continue;
    }
    params[spec.name] = value;
  }
  return { params, missing, rejected };
}

/** Skill or draft params filled from what the rep sent. */
export function paramsFromUnderstanding(
  specs: SkillParamSpec[],
  u: Understanding,
  o: MapOptions = {},
): Mapped {
  const found = new Map<string, unknown>();
  for (const spec of specs) {
    for (const [field, aliases] of Object.entries(UNDERSTANDING_ALIASES)) {
      if (!aliases?.includes(spec.name)) continue;
      let v = u[field as keyof Understanding];
      if (field === "country" && typeof v === "string") v = canonicalCountry(v);
      if (v !== null && v !== undefined) found.set(spec.name, v);
      break;
    }
  }
  return finish(specs, found, o);
}

/** The company profile as run params: camelCase keys become snake_case; "true"/"false" become booleans. */
export function profileParams(
  profile: CompanyProfile,
  fileKeys: readonly string[] = ["w9File", "coiFile"],
): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const [key, value] of Object.entries(profile)) {
    if (fileKeys.includes(key)) continue;
    out[snakeCase(key)] = value === "true" ? true : value === "false" ? false : value;
  }
  return out;
}

/**
 * Supplier skill params: tenant and invite code from the invitation, files by slot, everything else from
 * the profile, matched by name or (after a rename) by the example the first run recorded.
 */
export function paramsFromProfile(
  specs: ParamSpec[],
  profile: CompanyProfile,
  ctx: { tenant: string; inviteCode: string; files: Record<string, FileParam> },
): Mapped {
  const byName = new Map(Object.entries(profileParams(profile)).map(([k, v]) => [k.replace(/_/g, ""), v]));
  const values = Object.values(profileParams(profile)).map(String);
  const found = new Map<string, unknown>();
  for (const spec of specs) {
    const name = spec.name;
    if (TENANT_ALIASES.includes(name)) found.set(name, ctx.tenant);
    else if (INVITE_ALIASES.includes(name)) found.set(name, ctx.inviteCode);
    else if (spec.type === "file" || Object.values(FILE_SLOTS).some((a) => a.includes(name))) {
      const slot = Object.entries(FILE_SLOTS).find(([, aliases]) => aliases.includes(name))?.[0] ?? name;
      if (ctx.files[slot]) found.set(name, ctx.files[slot]);
    } else if (byName.has(name.replace(/_/g, ""))) found.set(name, byName.get(name.replace(/_/g, "")));
    else if (spec.example !== undefined && values.filter((v) => v === spec.example).length === 1) {
      found.set(name, spec.example);
    }
  }
  return finish(specs, found);
}

/** Draft specs with each type corrected to the value a run actually used, where the guessed type cannot hold it. */
export function fitSpecsToValues(specs: ParamSpec[], values: Record<string, ParamValue>): ParamSpec[] {
  return specs.map((spec) => {
    const v = values[spec.name];
    if (v === undefined || coerce(spec, v) !== null) return spec;
    const [inferred] = inferSpecs({ [spec.name]: v });
    return inferred ? { ...spec, type: inferred.type } : spec;
  });
}

/** Specs for run params that came without a draft (zero-shot runs). */
export function inferSpecs(params: Record<string, ParamValue>): ParamSpec[] {
  return Object.entries(params).map(([name, v]): ParamSpec => {
    const type =
      typeof v === "object"
        ? "file"
        : typeof v === "number"
          ? "number"
          : typeof v === "boolean"
            ? "boolean"
            : isIsoDate(v)
              ? "date"
              : /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)
                ? "email"
                : "string";
    return { name, type, required: true, description: humanize(name) };
  });
}

/** Records each param's value from the first run as its example (shown on cards, used as ASR keywords). */
export function withExamples(specs: ParamSpec[], values: Record<string, ParamValue>): ParamSpec[] {
  return specs.map((s) => {
    const v = values[s.name];
    return v === undefined || typeof v === "object" ? s : { ...s, example: String(v) };
  });
}

// ---------- synthetic variants for canary dry runs ----------

const VARIANT_SUFFIX = ["Norte", "Sul", "Leste", "Oeste", "Centro"];

function paramsIn(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([a-z][a-z0-9_]*)/g)].map((m) => m[1] as string);
}

/** Params whose value is typed free-form into a field (only those can vary safely). */
function freeTextParams(steps: Step[]): Set<string> {
  const free = new Set<string>();
  const fixed = new Set<string>();
  for (const s of steps) {
    if (s.op === "fill") for (const p of paramsIn(s.value)) free.add(p);
    if (s.op === "select") for (const p of paramsIn(s.option)) fixed.add(p);
    if (s.op === "goto") for (const p of paramsIn(s.url)) fixed.add(p);
  }
  for (const p of fixed) free.delete(p);
  return free;
}

function varyString(v: string, i: number): string {
  // Codes, numbers, URLs, domains and short codes keep their exact value: portals validate their shape.
  if (!/[A-Za-zÀ-ÿ]{2,}/.test(v) || !/\s/.test(v.trim()) || /:\/\//.test(v)) return v;
  return `${v} ${VARIANT_SUFFIX[(i - 1) % VARIANT_SUFFIX.length]}`;
}

/** `n` param sets that differ from `base` wherever a form would accept a different value. */
export function syntheticParamSets(
  skill: { params: ParamSpec[]; steps: Step[] },
  base: Record<string, ParamValue>,
  n: number,
): Record<string, ParamValue>[] {
  const free = freeTextParams(skill.steps);
  const sets: Record<string, ParamValue>[] = [];
  for (let i = 1; i <= n; i++) {
    const set: Record<string, ParamValue> = { ...base };
    for (const spec of skill.params) {
      const v = base[spec.name];
      // Options keep the value a real run used: an option list from a teach draft may not match the portal's.
      if (v === undefined || typeof v === "object" || typeof v === "boolean" || spec.type === "enum")
        continue;
      if (!free.has(spec.name)) continue;
      if (typeof v === "number") set[spec.name] = Number.isInteger(v) ? v + i : v + i / 10;
      else if (spec.type === "date" || isIsoDate(v)) set[spec.name] = addDaysIso(v, 7 * i);
      else if (spec.type === "email" || /^[^@\s]+@[^@\s]+$/.test(v)) set[spec.name] = `canary${i}.${v}`;
      else if (spec.type === "string") set[spec.name] = varyString(v, i);
    }
    sets.push(set);
  }
  return sets;
}

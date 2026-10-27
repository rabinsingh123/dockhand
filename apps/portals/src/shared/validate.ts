// Validation + normalization shared by client (inline errors) and server (400 with field errors).

import { conditionHolds, type FieldDef, type FileMeta, type SectionDef, toBool } from "./fields.ts";
import type { FieldValue } from "./types.ts";

export interface ValidateContext {
  /** Server's local date, ISO `YYYY-MM-DD`. */
  today: string;
  files?: Record<string, FileMeta | null | undefined>;
}

export interface ValidationResult {
  /** Normalized values for visible, non-empty fields (booleans always included). */
  fields: Record<string, FieldValue>;
  /** Field key -> message, for visible fields only. */
  errors: Record<string, string>;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const URL_RE = /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(:\d{2,5})?(\/\S*)?$/i;
const PHONE_CHARS_RE = /^\+?[0-9 ().-]+$/;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function localIsoDate(d = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Parses `DD/MM/YYYY` (1-2 digit day/month allowed) or ISO `YYYY-MM-DD`. Returns ISO or null. */
export function parseDate(input: string): string | null {
  const s = input.trim();
  let y: number;
  let m: number;
  let d: number;
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (dmy) {
    d = Number(dmy[1]);
    m = Number(dmy[2]);
    y = Number(dmy[3]);
  } else if (iso) {
    y = Number(iso[1]);
    m = Number(iso[2]);
    d = Number(iso[3]);
  } else {
    return null;
  }
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** ISO `YYYY-MM-DD` -> `DD/MM/YYYY`. */
export function isoToDmy(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

/** Adds days to an ISO date (UTC arithmetic, no DST issues). */
export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

function matchOption(options: readonly string[] | undefined, value: string): string | undefined {
  const v = value.trim().toLowerCase();
  return options?.find((o) => o.toLowerCase() === v);
}

function isPdf(meta: FileMeta): boolean {
  return /\.pdf$/i.test(meta.name) || meta.type === "application/pdf";
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export interface FieldOutcome {
  value?: FieldValue;
  error?: string;
}

export function validateField(def: FieldDef, raw: unknown, ctx: ValidateContext): FieldOutcome {
  const label = def.label;
  const requiredMsg = def.requiredMessage ?? `${label} is required.`;

  if (def.kind === "checkbox") {
    const v = toBool(raw);
    if (def.required && !v) return { error: requiredMsg };
    return { value: v };
  }

  if (def.kind === "checkboxGroup") {
    const list = Array.isArray(raw) ? raw : typeof raw === "string" && raw !== "" ? [raw] : [];
    const picked = new Set<string>();
    for (const item of list) {
      const opt = typeof item === "string" ? matchOption(def.options, item) : undefined;
      if (!opt) return { error: `Select only listed options for ${label}.` };
      picked.add(opt);
    }
    if (def.exclusiveOption && picked.has(def.exclusiveOption) && picked.size > 1) {
      return { error: `"${def.exclusiveOption}" can't be combined with other ${label.toLowerCase()}.` };
    }
    if (picked.size === 0) return def.required ? { error: requiredMsg } : {};
    return { value: (def.options ?? []).filter((o) => picked.has(o)) };
  }

  if (def.kind === "file") {
    const meta = ctx.files?.[def.key];
    if (!meta) return def.required ? { error: requiredMsg } : {};
    if (!isPdf(meta)) return { error: `${label} must be a PDF file.` };
    if (meta.size === 0) return { error: `${label} is empty. Choose a different file.` };
    if (meta.size > (def.maxBytes ?? DEFAULT_MAX_BYTES))
      return { error: `${label} must be 10 MB or smaller.` };
    return {};
  }

  const s =
    typeof raw === "string" ? raw.trim() : typeof raw === "number" && Number.isFinite(raw) ? String(raw) : "";
  if (s === "") return def.required ? { error: requiredMsg } : {};
  if (def.maxLength && s.length > def.maxLength) {
    return { error: `${label} must be ${def.maxLength} characters or fewer.` };
  }

  let value: FieldValue = s;
  switch (def.kind) {
    case "email":
      if (!EMAIL_RE.test(s))
        return { error: `${label} must be a valid email address, like name@company.com.` };
      break;
    case "tel": {
      const digits = s.replace(/\D/g, "").length;
      if (!PHONE_CHARS_RE.test(s) || digits < 7 || digits > 15) {
        return { error: `${label} must be a valid phone number, like +55 11 91234 5678.` };
      }
      break;
    }
    case "url":
      if (!URL_RE.test(s)) return { error: `${label} must be a valid web address, like example.com.` };
      break;
    case "integer": {
      const compact = s.replace(/[,\s]/g, "");
      if (!/^\d+$/.test(compact)) return { error: `${label} must be a whole number.` };
      const n = Number(compact);
      if (def.min !== undefined && n < def.min) return { error: `${label} must be at least ${def.min}.` };
      if (def.max !== undefined && n > def.max) return { error: `${label} must be ${def.max} or less.` };
      value = n;
      break;
    }
    case "money": {
      const compact = s.replace(/^(usd|us\$|\$)\s*/i, "").replace(/[,\s]/g, "");
      if (!/^\d+(\.\d{1,2})?$/.test(compact)) return { error: `${label} must be an amount, like 25000.` };
      value = Number(compact);
      break;
    }
    case "date": {
      if (!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s) && !/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        return { error: `${label} must be a date in the format DD/MM/YYYY.` };
      }
      const iso = parseDate(s);
      if (!iso) return { error: `${label} must be a real date.` };
      if (def.futureDate && iso <= ctx.today) return { error: `${label} must be in the future.` };
      value = iso;
      break;
    }
    case "year": {
      const maxYear = Number(ctx.today.slice(0, 4));
      const min = def.min ?? 1800;
      if (!/^\d{4}$/.test(s) || Number(s) < min || Number(s) > maxYear) {
        return { error: `${label} must be a year between ${min} and ${maxYear}.` };
      }
      value = Number(s);
      break;
    }
    case "combobox":
    case "radio": {
      const opt = matchOption(def.options, s);
      if (!opt) return { error: `Select a ${label.toLowerCase()} from the list.` };
      value = opt;
      break;
    }
    default:
      break;
  }

  if (def.pattern && !new RegExp(def.pattern.source, def.pattern.flags).test(s)) {
    return { error: def.pattern.message.replace("{label}", label) };
  }
  return { value };
}

/** Validates visible fields of the given sections. Missing raw keys fall back to field defaults. */
export function validateSections(
  sections: readonly SectionDef[],
  raw: Record<string, unknown>,
  ctx: ValidateContext,
): ValidationResult {
  const values: Record<string, unknown> = {};
  for (const s of sections)
    for (const f of s.fields) if (f.defaultValue !== undefined) values[f.key] = f.defaultValue;
  Object.assign(values, raw);

  const fields: Record<string, FieldValue> = {};
  const errors: Record<string, string> = {};
  for (const section of sections) {
    if (!conditionHolds(section.showWhen, values)) continue;
    for (const def of section.fields) {
      if (!conditionHolds(def.showWhen, values)) continue;
      const out = validateField(def, values[def.key], ctx);
      if (out.error) errors[def.key] = out.error;
      else if (out.value !== undefined) fields[def.key] = out.value;
    }
  }
  return { fields, errors };
}

/** Human-readable value in the same format the form accepts (dates DD/MM/YYYY, lists comma-separated). */
export function displayValue(def: Pick<FieldDef, "kind"> | undefined, value: FieldValue | undefined): string {
  if (value === undefined) return "";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (def?.kind === "date" && typeof value === "string") return isoToDmy(value);
  return String(value);
}

/** Canonical value as a string, for `data-value` attributes. */
export function canonicalString(value: FieldValue | undefined): string {
  if (value === undefined) return "";
  if (Array.isArray(value)) return JSON.stringify(value);
  return String(value);
}

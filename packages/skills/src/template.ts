// Value templates and value-to-param matching.
// Grammar (nothing else): "{{name}}", "{{name|date:DD/MM/YYYY}}" (also YYYY-MM-DD, MM/DD/YYYY),
// "{{name|number:pt-BR}}" (also en-US). Params are normalized before a run: ISO dates, plain numbers.

import { DockhandError, type ParamValue } from "@dockhand/core";

export const DATE_FORMATS = ["DD/MM/YYYY", "YYYY-MM-DD", "MM/DD/YYYY"] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];
export const NUMBER_LOCALES = ["pt-BR", "en-US"] as const;
export type NumberLocale = (typeof NUMBER_LOCALES)[number];
export type TemplateFilter = `date:${DateFormat}` | `number:${NumberLocale}`;

export const TEMPLATE_FILTERS: readonly TemplateFilter[] = [
  ...DATE_FORMATS.map((f) => `date:${f}` as const),
  ...NUMBER_LOCALES.map((l) => `number:${l}` as const),
];

export interface TemplateRef {
  name: string;
  filter: TemplateFilter | null;
  /** The whole placeholder as written, e.g. "{{close_date|date:DD/MM/YYYY}}". */
  raw: string;
}

const PLACEHOLDER_RE = /\{\{([^{}]*)\}\}/g;
const PARAM_NAME_RE = /^[a-z][a-z0-9_]*$/;

function isFilter(s: string): s is TemplateFilter {
  return (TEMPLATE_FILTERS as readonly string[]).includes(s);
}

export function isParamName(s: string): boolean {
  return PARAM_NAME_RE.test(s);
}

export function toTemplate(name: string, filter: TemplateFilter | null = null): string {
  return filter ? `{{${name}|${filter}}}` : `{{${name}}}`;
}

/** Every placeholder in `t`. Throws on anything outside the grammar. */
export function parseTemplate(t: string): TemplateRef[] {
  const refs: TemplateRef[] = [];
  for (const m of t.matchAll(PLACEHOLDER_RE)) {
    const inner = (m[1] ?? "").trim();
    const bar = inner.indexOf("|");
    const name = (bar < 0 ? inner : inner.slice(0, bar)).trim();
    const filter = bar < 0 ? null : inner.slice(bar + 1).trim();
    if (!PARAM_NAME_RE.test(name)) {
      throw new DockhandError("ASSERT_FAILED", `invalid template placeholder ${m[0]}: bad param name`);
    }
    if (filter !== null && !isFilter(filter)) {
      throw new DockhandError(
        "ASSERT_FAILED",
        `invalid template placeholder ${m[0]}: unknown filter "${filter}"`,
      );
    }
    refs.push({ name, filter, raw: m[0] });
  }
  return refs;
}

export function hasTemplate(t: string): boolean {
  return /\{\{[^{}]*\}\}/.test(t);
}

/** Param names referenced by `t`, in order of first use. */
export function templateParams(t: string): string[] {
  return [...new Set(parseTemplate(t).map((r) => r.name))];
}

/** Rewrites param names inside placeholders (filters are kept). Names not in the map stay. */
export function renameTemplateParams(t: string, renames: Record<string, string>): string {
  return t.replace(PLACEHOLDER_RE, (whole) => {
    const [ref] = parseTemplate(whole);
    if (!ref) return whole;
    const to = renames[ref.name];
    return to ? toTemplate(to, ref.filter) : whole;
  });
}

// ---------- rendering ----------

export function isFileValue(v: ParamValue): v is Extract<ParamValue, { file: unknown }> {
  return typeof v === "object" && v !== null && "file" in v;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** ISO `YYYY-MM-DD` (a trailing time part is ignored) -> parts, or null when it is not a real date. */
export function parseIsoDate(s: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(s.trim());
  if (!m) return null;
  return realDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

function realDate(y: number, m: number, d: number): { y: number; m: number; d: number } | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return { y, m, d };
}

function formatDate(p: { y: number; m: number; d: number }, fmt: DateFormat): string {
  const yyyy = String(p.y).padStart(4, "0");
  if (fmt === "DD/MM/YYYY") return `${pad2(p.d)}/${pad2(p.m)}/${yyyy}`;
  if (fmt === "MM/DD/YYYY") return `${pad2(p.m)}/${pad2(p.d)}/${yyyy}`;
  return `${yyyy}-${pad2(p.m)}-${pad2(p.d)}`;
}

const PLAIN_NUMBER_RE = /^-?\d+(\.\d+)?$/;

/** Plain decimal string ("1234.5") for a number param, or null when the value is not numeric. */
export function plainNumber(v: ParamValue): string | null {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    const s = String(v);
    return /e/i.test(s) ? v.toFixed(10).replace(/\.?0+$/, "") : s;
  }
  if (typeof v === "string" && PLAIN_NUMBER_RE.test(v.trim())) return v.trim();
  return null;
}

/** Groups thousands; non-integers always show at least 2 decimals ("1.234,50"). */
function formatNumber(plain: string, locale: NumberLocale): string {
  const negative = plain.startsWith("-");
  const body = negative ? plain.slice(1) : plain;
  const [int = "0", dec] = body.split(".");
  const group = locale === "pt-BR" ? "." : ",";
  const point = locale === "pt-BR" ? "," : ".";
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  const decimals = dec === undefined ? "" : `${point}${dec.padEnd(2, "0")}`;
  return `${negative ? "-" : ""}${grouped}${decimals}`;
}

function identity(v: ParamValue): string {
  if (isFileValue(v)) return v.filename;
  if (typeof v === "number") return plainNumber(v) ?? String(v);
  return String(v);
}

/** Renders one param value through one filter. Throws ASSERT_FAILED when the value does not fit the filter. */
export function applyFilter(value: ParamValue, filter: TemplateFilter | null, name = "value"): string {
  if (filter === null) return identity(value);
  if (filter.startsWith("date:")) {
    const parts = typeof value === "string" ? parseIsoDate(value) : null;
    if (!parts) {
      throw new DockhandError(
        "ASSERT_FAILED",
        `param "${name}" must be an ISO date (YYYY-MM-DD) for ${filter}`,
      );
    }
    return formatDate(parts, filter.slice(5) as DateFormat);
  }
  const plain = isFileValue(value) ? null : plainNumber(value);
  if (plain === null)
    throw new DockhandError("ASSERT_FAILED", `param "${name}" must be a plain number for ${filter}`);
  return formatNumber(plain, filter.slice(7) as NumberLocale);
}

/** Replaces every placeholder. Missing params throw NEEDS_INPUT; values that do not fit a filter throw ASSERT_FAILED. */
export function renderTemplate(t: string, params: Record<string, ParamValue>): string {
  return renderWith(t, params, (s) => s);
}

/** Like renderTemplate, but URL-encodes each substituted value (for goto URLs and URL checks). */
export function renderUrlTemplate(t: string, params: Record<string, ParamValue>): string {
  return renderWith(t, params, encodeURIComponent);
}

/** Like renderTemplate, but regex-escapes each substituted value (for text patterns). */
export function renderRegexTemplate(t: string, params: Record<string, ParamValue>): string {
  return renderWith(t, params, escapeRegex);
}

function renderWith(t: string, params: Record<string, ParamValue>, encode: (s: string) => string): string {
  if (!t.includes("{{")) return t;
  return t.replace(PLACEHOLDER_RE, (whole) => {
    const [ref] = parseTemplate(whole);
    if (!ref) return whole;
    const value = params[ref.name];
    if (value === undefined || value === null) {
      throw new DockhandError("NEEDS_INPUT", `missing param "${ref.name}"`, { param: ref.name });
    }
    return encode(applyFilter(value, ref.filter, ref.name));
  });
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

// ---------- normalization ----------

/** Case-, accent- and whitespace-insensitive form. */
export function normalizeText(s: string): string {
  return s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function digitsOf(s: string): string {
  return s.replace(/\D/g, "");
}

const PHONE_CHARS_RE = /^\+?[\d\s().-]+$/;

export function isPhoneLike(s: string): boolean {
  return PHONE_CHARS_RE.test(s.trim()) && digitsOf(s).length >= 8;
}

/** Same digits, or one is a suffix of the other (country code added or dropped), at least 8 digits. */
function phoneDigitsMatch(a: string, b: string): boolean {
  const x = digitsOf(a);
  const y = digitsOf(b);
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 8 && long.endsWith(short);
}

export interface ParsedNumber {
  value: number;
  /** Which written style produced the value: null = plain digits with an optional "." decimal point. */
  style: NumberLocale | null;
}

const CURRENCY_RE = /^(?:r\$|us\$|\$|usd|brl|€|eur)\s*|\s*(?:usd|brl|eur)$/gi;

/** Every number a written value can mean ("120.000" is 120 or 120000). Empty when it is not a number. */
export function parseNumberCandidates(raw: string): ParsedNumber[] {
  const s = raw.trim().replace(CURRENCY_RE, "").replace(/\s/g, "");
  const out: ParsedNumber[] = [];
  const add = (text: string, style: NumberLocale | null) => {
    const value = Number(text);
    if (Number.isFinite(value) && !out.some((o) => o.value === value)) out.push({ value, style });
  };
  if (/^-?\d+(\.\d+)?$/.test(s)) add(s, null);
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s) || /^-?\d+,\d+$/.test(s)) {
    add(s.replace(/\./g, "").replace(",", "."), "pt-BR");
  }
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) add(s.replace(/,/g, ""), "en-US");
  return out;
}

/**
 * Read-back equality: the value on screen is what we meant to write, allowing formatting the page
 * may apply (case, accents, whitespace, number grouping, phone masks).
 */
export function valuesEquivalent(intended: string, actual: string): boolean {
  if (normalizeText(intended) === normalizeText(actual)) return true;
  const a = parseNumberCandidates(intended);
  const b = parseNumberCandidates(actual);
  if (a.length > 0 && b.length > 0 && a.some((x) => b.some((y) => x.value === y.value))) return true;
  return isPhoneLike(intended) && isPhoneLike(actual) && digitsOf(intended) === digitsOf(actual);
}

// ---------- value -> param matching ----------

export interface ValueBinding {
  param: string;
  filter: TemplateFilter | null;
  /** exact: the template renders the raw value; normalized: equal after folding case, accents, digits or locale. */
  match: "exact" | "normalized";
  template: string;
}

function isoDateOf(v: ParamValue): { y: number; m: number; d: number } | null {
  return typeof v === "string" ? parseIsoDate(v) : null;
}

function filtersFor(v: ParamValue): (TemplateFilter | null)[] {
  const out: (TemplateFilter | null)[] = [null];
  if (isoDateOf(v)) out.push("date:DD/MM/YYYY", "date:YYYY-MM-DD", "date:MM/DD/YYYY");
  if (plainNumber(v) !== null) out.push("number:pt-BR", "number:en-US");
  return out;
}

/** Date filters under which a loosely written date ("5/3/2027", "05.03.2027") equals the param date. */
function looseDateFilters(raw: string, date: { y: number; m: number; d: number }): TemplateFilter[] {
  const s = raw.trim();
  const same = (p: { y: number; m: number; d: number } | null) =>
    p !== null && p.y === date.y && p.m === date.m && p.d === date.d;
  const out: TemplateFilter[] = [];
  const xy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (xy) {
    const a = Number(xy[1]);
    const b = Number(xy[2]);
    const y = Number(xy[3]);
    if (same(realDate(y, b, a))) out.push("date:DD/MM/YYYY");
    if (same(realDate(y, a, b))) out.push("date:MM/DD/YYYY");
  }
  const ymd = /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/.exec(s);
  if (ymd && same(realDate(Number(ymd[1]), Number(ymd[2]), Number(ymd[3])))) out.push("date:YYYY-MM-DD");
  return out;
}

/**
 * Every {param, filter} that could have produced `raw` (a value seen on screen or typed).
 * Exact bindings render `raw` itself. Normalized ones mean the same thing (case/accent folding,
 * locale-aware numbers, phone digits, loosely written dates); a replay types the param's own value.
 */
export function matchValue(raw: string, params: Record<string, ParamValue>): ValueBinding[] {
  if (raw.trim() === "") return [];
  const out: ValueBinding[] = [];
  const rawNorm = normalizeText(raw);
  for (const [name, value] of Object.entries(params)) {
    if (!PARAM_NAME_RE.test(name) || value === null || value === undefined || isFileValue(value)) continue;
    const found: ValueBinding[] = [];
    const add = (filter: TemplateFilter | null, match: ValueBinding["match"]) => {
      if (found.some((f) => f.filter === filter)) return;
      found.push({ param: name, filter, match, template: toTemplate(name, filter) });
    };
    for (const filter of filtersFor(value)) {
      let rendered: string;
      try {
        rendered = applyFilter(value, filter, name);
      } catch {
        continue;
      }
      if (rendered === "") continue;
      if (rendered === raw) add(filter, "exact");
      else if (normalizeText(rendered) === rawNorm) add(filter, "normalized");
    }
    if (!found.some((f) => f.match === "exact")) {
      const plain = plainNumber(value);
      if (plain !== null) {
        const n = Number(plain);
        for (const c of parseNumberCandidates(raw)) {
          if (c.value === n) add(c.style ? `number:${c.style}` : null, "normalized");
        }
      }
      const date = isoDateOf(value);
      if (date) for (const f of looseDateFilters(raw, date)) add(f, "normalized");
      if (
        typeof value === "string" &&
        isPhoneLike(value) &&
        isPhoneLike(raw) &&
        phoneDigitsMatch(raw, value)
      ) {
        add(null, "normalized");
      }
    }
    found.sort((a, b) => rank(a) - rank(b));
    out.push(...found);
  }
  return out;
}

function rank(b: ValueBinding): number {
  return (b.match === "exact" ? 0 : 10) + (b.filter === null ? 0 : 1);
}

export interface TemplatedValue {
  /** The template a step stores: a single placeholder, or the literal raw value. */
  template: string;
  binding: ValueBinding | null;
  /** Bindings to other params that fit equally well (non-empty = ambiguous). */
  alternatives: ValueBinding[];
}

function tokens(s: string): Set<string> {
  return new Set(
    normalizeText(s)
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1),
  );
}

function overlap(param: string, label: string | undefined): number {
  if (!label) return 0;
  const a = tokens(param.replace(/_/g, " "));
  const b = tokens(label);
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

/** The date format a field's placeholder or hint asks for, if it names one. */
export function dateFormatHint(hint: string | undefined): DateFormat | null {
  if (!hint) return null;
  const h = hint.toUpperCase().replace(/\s/g, "");
  if (h.includes("DD/MM/YYYY") || h.includes("DD/MM/AAAA")) return "DD/MM/YYYY";
  if (h.includes("MM/DD/YYYY")) return "MM/DD/YYYY";
  if (h.includes("YYYY-MM-DD")) return "YYYY-MM-DD";
  return null;
}

/**
 * Picks the template for a value: exact beats normalized, a format named by the field's placeholder
 * wins for dates, then the param whose name best matches the field label, then the plain placeholder.
 */
export function templateValue(
  raw: string,
  params: Record<string, ParamValue>,
  opts: { label?: string; formatHint?: string } = {},
): TemplatedValue {
  const bindings = matchValue(raw, params);
  if (bindings.length === 0) return { template: raw, binding: null, alternatives: [] };
  const preferred = dateFormatHint(opts.formatHint);
  const order = Object.keys(params);
  const score = (b: ValueBinding) =>
    (b.match === "exact" ? 0 : 1000) +
    (preferred && b.filter?.startsWith("date:") ? (b.filter === `date:${preferred}` ? 0 : 100) : 0) -
    overlap(b.param, opts.label) * 10 +
    (b.filter === null ? 0 : 1) +
    order.indexOf(b.param) / 1000;
  const sorted = [...bindings].sort((a, b) => score(a) - score(b));
  const best = sorted[0] as ValueBinding;
  const alternatives: ValueBinding[] = [];
  for (const b of sorted) {
    if (b.param === best.param || b.match !== best.match) continue;
    if (!alternatives.some((a) => a.param === b.param)) alternatives.push(b);
  }
  return { template: best.template, binding: best, alternatives };
}

// ---------- URLs ----------

export interface UrlBinding {
  segment: string;
  binding: ValueBinding;
  alternatives: ValueBinding[];
}

/** Templates whole path segments and query values that exactly equal a param ("/t/acme/invite/ACME-7731"). */
export function templateUrl(
  url: string,
  params: Record<string, ParamValue>,
): { template: string; bindings: UrlBinding[] } {
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)?([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(url);
  if (!m) return { template: url, bindings: [] };
  const [, origin = "", path = "", search = "", hash = ""] = m;
  const bindings: UrlBinding[] = [];
  const templ = (encoded: string): string => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
    if (decoded.length < 2) return encoded;
    const exact = matchValue(decoded, params).filter((b) => b.match === "exact");
    if (exact.length === 0) return encoded;
    const chosen = templateValue(
      decoded,
      Object.fromEntries(exact.map((b) => [b.param, params[b.param] as ParamValue])),
    );
    if (!chosen.binding) return encoded;
    bindings.push({ segment: decoded, binding: chosen.binding, alternatives: chosen.alternatives });
    return chosen.template;
  };
  const newPath = path
    .split("/")
    .map((seg) => (seg === "" ? seg : templ(seg)))
    .join("/");
  const newSearch = search
    ? `?${search
        .slice(1)
        .split("&")
        .map((pair) => {
          const eq = pair.indexOf("=");
          return eq < 0 ? pair : `${pair.slice(0, eq)}=${templ(pair.slice(eq + 1))}`;
        })
        .join("&")}`
    : "";
  return { template: `${origin}${newPath}${newSearch}${hash}`, bindings };
}

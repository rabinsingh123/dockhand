// Canonical field catalogs, derived from the portal schemas (single source of truth), so eval
// generators and the skill compiler import them instead of duplicating field lists.

import type { Condition, FieldDef, FieldKind } from "./fields.ts";
import { createMutator } from "./mutations.ts";
import { partnerBaseSections, partnerSections } from "./partnerSchema.ts";
import { supplierBaseSections, supplierSections, type TenantSlug } from "./supplierSchema.ts";

export interface CanonicalField {
  /** Submission key (stable across versions, tenants and mutations). */
  key: string;
  /** Canonical (v1 / unmutated) label. */
  label: string;
  type: FieldKind;
  required: boolean;
  options?: readonly string[];
  /** Supplier: wizard step key. */
  step?: string;
  /** Shown (and validated) only when this holds, e.g. remit-to fields need remitSameAsAddress=false. */
  showWhen?: Condition;
  /** Supplier: tenants whose form has this field. Absent = all tenants. */
  tenants?: TenantSlug[];
  /** Regex source the trimmed value must match (on top of the type rules). */
  pattern?: string;
  min?: number;
  max?: number;
  /** Date fields: must be after the server date. */
  futureDate?: boolean;
  /** Checkbox default (remitSameAsAddress = true). */
  defaultValue?: string | boolean;
  /** Only present when this mutation operator inserts it. */
  insertedBy?: "insert_required_field" | "insert_optional_field";
}

function toCanonical(f: FieldDef, extra: Partial<CanonicalField> = {}): CanonicalField {
  return {
    key: f.key,
    label: f.label,
    type: f.kind,
    required: Boolean(f.required),
    ...(f.options ? { options: f.options } : {}),
    ...(f.showWhen ? { showWhen: f.showWhen } : {}),
    ...(f.pattern ? { pattern: f.pattern.source } : {}),
    ...(f.min !== undefined ? { min: f.min } : {}),
    ...(f.max !== undefined ? { max: f.max } : {}),
    ...(f.futureDate ? { futureDate: true } : {}),
    ...(f.defaultValue !== undefined ? { defaultValue: f.defaultValue } : {}),
    ...extra,
  };
}

/**
 * Partner form fields in v1 order. Value formats accepted by the form: dates DD/MM/YYYY (stored as
 * ISO in submissions), seats a whole number > 0, comboboxes one of `options`, consent true.
 */
export const PARTNER_FIELDS: readonly CanonicalField[] = partnerBaseSections("v1").flatMap((s) =>
  s.fields.map((f) => toCanonical(f)),
);

/** Fields that only appear under a mutation (partnerTier is the must-ask-a-human field). */
export const PARTNER_INSERTABLE_FIELDS: readonly CanonicalField[] = (() => {
  const base = new Set(PARTNER_FIELDS.map((f) => f.key));
  const out: CanonicalField[] = [];
  for (const op of ["insert_required_field", "insert_optional_field"] as const) {
    // Optional candidates are seed-dependent; collect them across a few seeds.
    for (let seed = 0; seed < 32; seed++) {
      const fields = partnerSections("v1", createMutator("partner", { seed, operators: [op] })).flatMap(
        (s) => s.fields,
      );
      for (const f of fields) {
        if (!base.has(f.key) && !out.some((o) => o.key === f.key))
          out.push(toCanonical(f, { insertedBy: op }));
      }
    }
  }
  return out;
})();

/** Supplier fields in acme order (all steps). dunsNumber exists on globex only. */
export const SUPPLIER_FIELDS: readonly CanonicalField[] = (() => {
  const acme = supplierBaseSections("acme").flatMap((s) => s.fields.map((f) => ({ f, step: s.step })));
  const globex = supplierBaseSections("globex").flatMap((s) => s.fields.map((f) => ({ f, step: s.step })));
  const acmeKeys = new Set(acme.map((x) => x.f.key));
  const out = acme.map(({ f, step }) => toCanonical(f, step ? { step } : {}));
  for (const { f, step } of globex) {
    if (!acmeKeys.has(f.key)) {
      const idx = out.findIndex((o) => o.step === step && o.key === "taxId");
      const entry = toCanonical(f, { ...(step ? { step } : {}), tenants: ["globex"] });
      out.splice(idx >= 0 ? idx + 1 : out.length, 0, entry);
    }
  }
  return out;
})();

export const SUPPLIER_INSERTABLE_FIELDS: readonly CanonicalField[] = (() => {
  const base = new Set(SUPPLIER_FIELDS.map((f) => f.key));
  const out: CanonicalField[] = [];
  for (const op of ["insert_required_field", "insert_optional_field"] as const) {
    for (let seed = 0; seed < 32; seed++) {
      const sections = supplierSections("acme", createMutator("supplier", { seed, operators: [op] }));
      for (const s of sections) {
        for (const f of s.fields) {
          if (!base.has(f.key) && !out.some((o) => o.key === f.key)) {
            // No step: where the field lands depends on the seed.
            out.push(toCanonical(f, { insertedBy: op }));
          }
        }
      }
    }
  }
  return out;
})();

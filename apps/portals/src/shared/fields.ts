// Declarative form schema shared by server validation and client rendering.

export type FieldKind =
  | "text"
  | "email"
  | "tel"
  | "url"
  | "integer"
  | "money"
  | "date"
  | "year"
  | "textarea"
  | "combobox"
  | "radio"
  | "checkbox"
  | "checkboxGroup"
  | "file";

export interface Condition {
  key: string;
  equals: string | boolean;
}

export interface FieldDef {
  /** Canonical key, stable across versions, tenants and mutations. */
  key: string;
  kind: FieldKind;
  label: string;
  required?: boolean;
  /** Base data-testid (before testid_churn). */
  testid: string;
  /** Base DOM id (before id_churn). */
  domId: string;
  placeholder?: string;
  hint?: string;
  options?: readonly string[];
  /** checkboxGroup: option that cannot be combined with the others ("None of these"). */
  exclusiveOption?: string;
  pattern?: { source: string; flags?: string; message: string };
  min?: number;
  max?: number;
  futureDate?: boolean;
  maxLength?: number;
  span?: 1 | 2;
  rows?: number;
  requiredMessage?: string;
  synonyms?: readonly string[];
  altPlaceholders?: readonly string[];
  showWhen?: Condition;
  defaultValue?: string | boolean;
  accept?: string;
  maxBytes?: number;
  inputMode?: "numeric" | "decimal" | "email" | "tel" | "url" | "text";
}

export interface SectionDef {
  key: string;
  title?: string;
  description?: string;
  /** Render as <fieldset><legend>. */
  fieldset?: boolean;
  columns: 1 | 2;
  /** May receive inserted fields (insert_* / move_field_to_step). Defaults to true. */
  insertable?: boolean;
  showWhen?: Condition;
  /** Supplier wizard step this section belongs to. */
  step?: string;
  fields: FieldDef[];
}

export interface FileMeta {
  name: string;
  size: number;
  type: string;
}

/** Raw (unvalidated) form values as the client holds them: strings, booleans, string lists. */
export type RawValue = string | boolean | string[];
export type FormValues = Record<string, RawValue>;

export function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function toBool(v: unknown): boolean {
  return v === true || v === "true" || v === "on" || v === "1";
}

export function conditionHolds(cond: Condition | undefined, values: Record<string, unknown>): boolean {
  if (!cond) return true;
  const v = values[cond.key];
  if (typeof cond.equals === "boolean") return toBool(v) === cond.equals;
  return v === cond.equals;
}

export function emptyValueFor(def: FieldDef): RawValue {
  if (def.defaultValue !== undefined) return def.defaultValue;
  if (def.kind === "checkbox") return false;
  if (def.kind === "checkboxGroup") return [];
  return "";
}

export function initialValues(sections: readonly SectionDef[]): FormValues {
  const out: FormValues = {};
  for (const s of sections) for (const f of s.fields) out[f.key] = emptyValueFor(f);
  return out;
}

export function allFields(sections: readonly SectionDef[]): FieldDef[] {
  return sections.flatMap((s) => s.fields);
}

/** Fields that are currently shown (section and field conditions hold), in display order. */
export function visibleFields(sections: readonly SectionDef[], values: Record<string, unknown>): FieldDef[] {
  const out: FieldDef[] = [];
  for (const s of sections) {
    if (!conditionHolds(s.showWhen, values)) continue;
    for (const f of s.fields) if (conditionHolds(f.showWhen, values)) out.push(f);
  }
  return out;
}

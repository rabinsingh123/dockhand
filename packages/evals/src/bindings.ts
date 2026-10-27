// Which canonical portal field each write step of a skill fills, read from the step targets' labels. This is
// how a case knows what a param must look like and what the ground-truth submission should hold, for any
// compiled skill (bootstrap or a real first run), whatever its param names.

import type { ElementDescriptor, ParamValue, Skill, Step } from "@dockhand/core";
import { type CanonicalField, parseDate } from "@dockhand/portals";
import { parseTemplate, renderTemplate } from "@dockhand/skills";
import { isFileParam } from "./files.ts";
import { bareLabel, type PortalDef } from "./portals.ts";

export interface FieldBinding {
  key: string;
  field: CanonicalField;
  stepId: string;
  /**
   * What the step writes: a value template ("{{seats}}", "{{close_date|date:DD/MM/YYYY}}" or a literal),
   * an option name (radio, checkbox group), "true"/"false" (checkbox), or "{{param}}" (file upload).
   */
  template: string;
  params: string[];
}

export interface Unmapped {
  stepId: string;
  label: string;
}

const norm = (s: string | undefined) => (s ? bareLabel(s).normalize("NFC").toLowerCase() : "");

function namesOf(fp: ElementDescriptor): string[] {
  return [fp.label, fp.name, fp.text].map(norm).filter(Boolean);
}

function byLabel(fields: readonly CanonicalField[], fp: ElementDescriptor, types?: string[]) {
  const names = namesOf(fp);
  return fields.find((f) => (!types || types.includes(f.type)) && names.includes(norm(f.label)));
}

/**
 * A radio or checkbox-group option: the field whose options hold the element's name (section breaks ties).
 * The label goes first: radio fingerprints can carry the group's first option as their accessible name.
 */
function byOption(fields: readonly CanonicalField[], fp: ElementDescriptor) {
  for (const name of namesOf(fp)) {
    const hits = fields.filter(
      (f) => (f.type === "radio" || f.type === "checkboxGroup") && f.options?.some((o) => norm(o) === name),
    );
    const field = hits.find((f) => norm(f.label) === norm(fp.section)) ?? hits[0];
    if (field) return { field, option: field.options?.find((o) => norm(o) === name) as string };
  }
  return undefined;
}

function binding(field: CanonicalField, step: Step, template: string): FieldBinding {
  return {
    key: field.key,
    field,
    stepId: step.id,
    template,
    params: parseTemplate(template).map((r) => r.name),
  };
}

/** Bindings in step order. `unmapped` lists write steps whose element matches no canonical field. */
export function fieldBindings(
  skill: Skill,
  def: PortalDef,
): { bindings: FieldBinding[]; unmapped: Unmapped[] } {
  const fields = [...def.fields, ...def.insertable];
  const bindings: FieldBinding[] = [];
  const unmapped: Unmapped[] = [];
  for (const step of skill.steps) {
    let hit: FieldBinding | undefined;
    let fp: ElementDescriptor | undefined;
    switch (step.op) {
      case "fill": {
        fp = step.target.fingerprint;
        const f = byLabel(fields, fp);
        if (f) hit = binding(f, step, step.value);
        break;
      }
      case "select": {
        fp = step.trigger.fingerprint;
        const f = byLabel(fields, fp, ["combobox", "radio"]);
        if (f) hit = binding(f, step, step.option);
        break;
      }
      case "check": {
        fp = step.target.fingerprint;
        const box = byLabel(fields, fp, ["checkbox"]);
        if (box) hit = binding(box, step, String(step.checked));
        else {
          const opt = byOption(fields, fp);
          if (opt && step.checked) hit = binding(opt.field, step, opt.option);
        }
        break;
      }
      case "upload": {
        fp = step.target.fingerprint;
        const f = byLabel(fields, fp, ["file"]);
        if (f) hit = binding(f, step, `{{${step.fileParam}}}`);
        break;
      }
      case "click": {
        // A click on a radio or checkbox is a write too (some traces compile option picks to clicks).
        const t = step.target.fingerprint;
        if (
          t.role === "radio" ||
          t.inputType === "radio" ||
          t.role === "checkbox" ||
          t.inputType === "checkbox"
        ) {
          fp = t;
          const box = byLabel(fields, t, ["checkbox"]);
          const opt = box ? undefined : byOption(fields, t);
          if (box) hit = binding(box, step, "true");
          else if (opt) hit = binding(opt.field, step, opt.option);
        }
        break;
      }
      default:
        break;
    }
    if (hit) bindings.push(hit);
    else if (fp) unmapped.push({ stepId: step.id, label: fp.label ?? fp.name ?? fp.text ?? fp.tag });
  }
  return { bindings, unmapped };
}

// ---------- canonical values ----------

const NUMERIC = new Set(["integer", "money", "year"]);

function matchOption(field: CanonicalField, s: string): string {
  const v = s.trim().toLowerCase();
  return field.options?.find((o) => o.toLowerCase() === v) ?? s.trim();
}

/** A form-typed value ("26/12/2026", "1,250", "brazil") in the portal's canonical submission form. */
export function canonicalFromText(text: string, field: CanonicalField): string {
  const s = text.normalize("NFC").trim();
  if (field.type === "date") return parseDate(s) ?? s;
  if (NUMERIC.has(field.type)) {
    const compact = s.replace(/^(usd|us\$|\$)\s*/i, "").replace(/[,\s]/g, "");
    return /^\d+(\.\d+)?$/.test(compact) ? String(Number(compact)) : s;
  }
  if (field.type === "combobox" || field.type === "radio") return matchOption(field, s);
  return s;
}

/** A param value (ISO dates, plain numbers) in canonical form; files are graded by filename. */
export function canonicalFromParam(value: ParamValue, field: CanonicalField): string {
  if (isFileParam(value)) return value.filename;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return String(value);
  return canonicalFromText(value, field);
}

/** A submitted FieldValue as a string: numbers plain, booleans "true"/"false", lists ", "-joined. */
export function canonicalActual(value: string | number | boolean | string[]): string {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "string") return value.normalize("NFC").trim();
  return String(value);
}

function holds(field: CanonicalField, expected: Record<string, string>): boolean {
  if (!field.showWhen) return true;
  const actual = expected[field.showWhen.key] ?? String(field.defaultValue ?? false);
  return actual === String(field.showWhen.equals);
}

/**
 * The submission the skill should produce with `params`: every bound field (a step whose optional param is
 * absent is skipped by the runner, so its field is absent), plus untouched checkboxes at their defaults
 * (the portal always submits booleans). Keys follow the catalog order.
 */
export function expectedFields(
  skill: Skill,
  def: PortalDef,
  params: Record<string, ParamValue>,
): Record<string, string> {
  const { bindings } = fieldBindings(skill, def);
  const values: Record<string, string> = {};
  const groups = new Map<string, Set<string>>();
  for (const b of bindings) {
    const f = b.field;
    if (b.params.some((p) => params[p] === undefined || params[p] === "")) continue;
    if (f.type === "checkboxGroup") {
      groups.set(f.key, (groups.get(f.key) ?? new Set()).add(b.template));
      continue;
    }
    const refs = parseTemplate(b.template);
    const single = refs.length === 1 && b.template.trim() === refs[0]?.raw;
    const name = refs[0]?.name;
    values[f.key] =
      single && name !== undefined
        ? canonicalFromParam(params[name] as ParamValue, f)
        : canonicalFromText(renderTemplate(b.template, params), f);
  }
  for (const [key, picked] of groups) {
    const f = def.fields.find((x) => x.key === key);
    values[key] = (f?.options ?? [...picked]).filter((o) => picked.has(o)).join(", ");
  }
  for (const f of def.fields) {
    if (f.type === "checkbox" && values[f.key] === undefined) values[f.key] = String(f.defaultValue === true);
  }
  const ordered: Record<string, string> = {};
  for (const f of [...def.fields, ...def.insertable]) {
    if (values[f.key] !== undefined && holds(f, values)) ordered[f.key] = values[f.key] as string;
  }
  return ordered;
}

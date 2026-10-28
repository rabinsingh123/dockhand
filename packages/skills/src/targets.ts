// Small helpers over steps and targets shared by the compiler, runner, repairers, diff and export.

import type { Candidate, ElementDescriptor, Step, Target } from "@dockhand/core";

/** Omit over each member of a union (plain Omit collapses a discriminated union). */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type StepDraft = DistributiveOmit<Step, "id">;

/** How a person interacts with an element. Repairs and heals never cross classes. */
export type InteractionClass = "text" | "select" | "check" | "file" | "click" | "none";

const TEXT_INPUT_TYPES = new Set([
  "text",
  "email",
  "tel",
  "url",
  "number",
  "password",
  "search",
  "date",
  "datetime-local",
  "month",
  "week",
  "time",
]);
const TEXT_ROLES = new Set(["textbox", "searchbox", "spinbutton"]);
const CLICK_ROLES = new Set([
  "button",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "treeitem",
]);
const CHECK_ROLES = new Set(["checkbox", "radio", "switch"]);

export function interactionClass(fp: ElementDescriptor): InteractionClass {
  const tag = fp.tag.toLowerCase();
  const role = fp.role?.toLowerCase();
  const type = fp.inputType?.toLowerCase();
  if (tag === "input" && type === "file") return "file";
  if ((role && CHECK_ROLES.has(role)) || (tag === "input" && (type === "checkbox" || type === "radio")))
    return "check";
  if (role === "combobox" || role === "listbox" || tag === "select") return "select";
  if (
    (role && TEXT_ROLES.has(role)) ||
    tag === "textarea" ||
    (tag === "input" && TEXT_INPUT_TYPES.has(type ?? "text"))
  ) {
    return "text";
  }
  if (
    (role && CLICK_ROLES.has(role)) ||
    role === "option" ||
    tag === "button" ||
    tag === "a" ||
    fp.formSubmit
  ) {
    return "click";
  }
  return "none";
}

/** Human name of an element, as a rep would call it. */
export function displayName(fp: ElementDescriptor | undefined): string {
  if (!fp) return "the page";
  const name = fp.label ?? fp.name ?? fp.placeholder ?? fp.text ?? fp.testId ?? fp.domId ?? fp.tag;
  return name.replace(/\s*[*:]+\s*$/, "").trim() || fp.tag;
}

export function stepTarget(step: Step | StepDraft): Target | undefined {
  switch (step.op) {
    case "click":
    case "fill":
    case "check":
    case "upload":
      return step.target;
    case "select":
      return step.trigger;
    case "press":
    case "waitFor":
      return step.target;
    default:
      return undefined;
  }
}

export function withStepTarget<S extends Step | StepDraft>(step: S, target: Target): S {
  if (step.op === "select") return { ...step, trigger: target };
  if (step.op === "goto" || step.op === "extract") return step;
  return { ...step, target };
}

/** A click or key press that submits. (The guard keeps non-commit clicks in the false branch.) */
export function isCommitStep<S extends Step | StepDraft>(
  step: S,
): step is Extract<S, { op: "click" | "press" }> & { commit: true } {
  return (step.op === "click" || step.op === "press") && step.commit === true;
}

export function candidateKey(c: Candidate): string {
  switch (c.by) {
    case "role":
      return `role:${c.role}:${c.name}:${c.exact}`;
    case "label":
    case "text":
      return `${c.by}:${c.value}:${c.exact}`;
    default:
      return `${c.by}:${c.value}`;
  }
}

/** Fresh candidates first, then the old ones that are not duplicates (old ones help if the UI flips back). */
export function mergeCandidates(fresh: Candidate[], old: Candidate[], max = 6): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const c of [...fresh, ...old]) {
    const k = candidateKey(c);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Strong candidates resolve on their own; text and positional CSS are heal evidence only, and a placeholder
 * counts only when the field has no label candidate (same rule as @dockhand/browser's resolveTarget).
 */
export function hasStrongCandidate(candidates: readonly Candidate[]): boolean {
  return candidates.some((c) => {
    if (c.by === "text") return false;
    if (c.by === "css") return !/:nth-(of-type|child)\(/.test(c.value);
    if (c.by === "placeholder") return !candidates.some((o) => o.by === "label");
    return true;
  });
}

/** Next free "sN" id. */
export function nextStepId(steps: readonly { id: string }[]): string {
  let max = 0;
  for (const s of steps) {
    const m = /^s(\d+)$/.exec(s.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `s${max + 1}`;
}

export function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    const i = url.search(/[?#]/);
    return i < 0 ? url : url.slice(0, i);
  }
}

export function quote(s: string): string {
  return `'${s}'`;
}

/** Default plain-language intent for a step, from its target. */
export function defaultIntent(step: StepDraft): string {
  switch (step.op) {
    case "goto":
      return `Open ${pathOf(step.url) || step.url}`;
    case "click":
      return `Click ${quote(displayName(step.target.fingerprint))}`;
    case "fill":
      return `Fill ${quote(displayName(step.target.fingerprint))}`;
    case "select":
      return `Select ${quote(displayName(step.trigger.fingerprint))}`;
    case "check":
      return `${step.checked ? "Check" : "Uncheck"} ${quote(displayName(step.target.fingerprint))}`;
    case "upload":
      return `Upload the file for ${quote(displayName(step.target.fingerprint))}`;
    case "press":
      return step.target
        ? `Press ${step.key} in ${quote(displayName(step.target.fingerprint))}`
        : `Press ${step.key}`;
    case "waitFor":
      return step.urlIncludes
        ? `Wait for ${step.urlIncludes}`
        : step.text
          ? `Wait for the text ${quote(step.text)}`
          : `Wait for ${quote(displayName(step.target?.fingerprint))}`;
    case "extract":
      return `Read ${step.name} from the page`;
  }
}

const TEMPLATE_PARAM = /\{\{\s*([a-z][a-z0-9_]*)/g;

/** Param names a target templates in its candidates or fingerprint (a radio picked by value: "{{product}}"). */
export function targetParams(t: Target | undefined): string[] {
  if (!t) return [];
  const text = JSON.stringify([t.candidates, t.fingerprint.name ?? "", t.fingerprint.label ?? ""]);
  return [...new Set([...text.matchAll(TEMPLATE_PARAM)].map((m) => m[1] as string))];
}

/**
 * The target of "check the option named {{param}}" in a radio group: the dropdown a select step used became
 * radio buttons. Unlike a check on one fixed option, it picks whatever value the next run brings.
 */
export function optionPickTarget(fresh: Target, param: string, groupLabel: string | undefined): Target {
  const name = `{{${param}}}`;
  const { text: _text, value: _value, ...fp } = fresh.fingerprint;
  return {
    candidates: [
      { by: "role", role: "radio", name, exact: true },
      { by: "label", value: name, exact: true },
    ],
    fingerprint: { ...fp, role: "radio", name, ...(groupLabel ? { label: groupLabel } : {}) },
  };
}

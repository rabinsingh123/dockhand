// Human-readable difference between two skill versions, for the WhatsApp patch message and changelogs.
// Labels, not selectors; and how each fix was found when the caller knows (heal notes from the run).

import type { HealRung, SkillBody, Step } from "@dockhand/core";
import { displayName, stepTarget } from "./targets.ts";

export type DiffableSkill = Pick<SkillBody, "title" | "params" | "steps" | "success">;

/** How a step of `b` came to be: the rung that healed, repaired or added it in the run that produced `b`. */
export interface StepNote {
  stepId: string;
  rung: HealRung;
}

const HOW: Record<HealRung, string> = {
  fallback: "healed: fallback selector",
  similarity: "healed: similarity match",
  open_weights: "healed: open-weights model",
  computer_use: "healed: computer use",
  ask_rep: "asked the rep",
};

const ADDED_BY: Record<HealRung, string> = {
  fallback: "added by a fallback selector",
  similarity: "added by a similarity match",
  open_weights: "added by the open-weights model",
  computer_use: "added by computer use",
  ask_rep: "asked the rep",
};

function q(s: string): string {
  return `'${s}'`;
}

function stepValue(s: Step): string | undefined {
  if (s.op === "fill") return s.value;
  if (s.op === "select") return s.option;
  if (s.op === "check") return String(s.checked);
  if (s.op === "goto") return s.url;
  if (s.op === "upload") return `{{${s.fileParam}}}`;
  if (s.op === "waitFor") return s.urlIncludes ?? s.text;
  if (s.op === "press") return s.key;
  return undefined;
}

function stepName(s: Step): string {
  const t = stepTarget(s);
  return t ? displayName(t.fingerprint) : s.intent;
}

/** Longest common subsequence of two id lists (ids present in both). */
function lcs(a: string[], b: string[]): Set<string> {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = dp[i] as number[];
      row[j] =
        a[i] === b[j]
          ? ((dp[i + 1] as number[])[j + 1] as number) + 1
          : Math.max((dp[i + 1] as number[])[j] as number, row[j + 1] as number);
    }
  }
  const keep = new Set<string>();
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      keep.add(a[i] as string);
      i++;
      j++;
    } else if (((dp[i + 1] as number[])[j] as number) >= ((dp[i] as number[])[j + 1] as number)) i++;
    else j++;
  }
  return keep;
}

function referencedBy(s: Step): string[] {
  const v = stepValue(s) ?? "";
  return [...v.matchAll(/\{\{([a-z][a-z0-9_]*)/g)].map((m) => m[1] as string);
}

/**
 * Lines such as "step 9: 'Submit registration' -> 'Register opportunity' (healed: computer use)",
 * "new param partner_tier (asked the rep)", "step 4 moved (was step 6)". Steps are matched by id;
 * numbers are 1-based positions (in `b`, or in `a` for removed steps).
 */
export function diffSkills(a: DiffableSkill, b: DiffableSkill, notes: readonly StepNote[] = []): string[] {
  const lines: string[] = [];
  const noteOf = new Map(notes.map((n) => [n.stepId, n.rung]));
  const how = (id: string) => {
    const rung = noteOf.get(id);
    return rung ? ` (${HOW[rung]})` : "";
  };

  if (a.title !== b.title) lines.push(`title: ${q(a.title)} → ${q(b.title)}`);

  for (const p of b.params) {
    const old = a.params.find((x) => x.name === p.name);
    if (!old) {
      const asked = b.steps.some((s) => noteOf.get(s.id) === "ask_rep" && referencedBy(s).includes(p.name));
      lines.push(`new param ${p.name}${asked ? " (asked the rep)" : ""}`);
    } else if (old.type !== p.type) {
      lines.push(`param ${p.name}: ${old.type} → ${p.type}`);
    }
  }
  for (const p of a.params)
    if (!b.params.some((x) => x.name === p.name)) lines.push(`param ${p.name} removed`);

  const aIds = a.steps.map((s) => s.id);
  const bIds = b.steps.map((s) => s.id);
  const inOrder = lcs(
    aIds.filter((id) => bIds.includes(id)),
    bIds.filter((id) => aIds.includes(id)),
  );

  b.steps.forEach((s, idx) => {
    const n = idx + 1;
    const old = a.steps.find((x) => x.id === s.id);
    if (!old) {
      const rung = noteOf.get(s.id);
      lines.push(`new step ${n}: ${q(s.intent)}${rung ? ` (${ADDED_BY[rung]})` : ""}`);
      return;
    }
    if (!inOrder.has(s.id)) lines.push(`step ${n} moved (was step ${aIds.indexOf(s.id) + 1})`);
    if (old.op !== s.op) {
      lines.push(`step ${n}: ${old.op} → ${s.op} ${q(stepName(s))}${how(s.id)}`);
      return;
    }
    const oldTarget = stepTarget(old);
    const newTarget = stepTarget(s);
    const oldName = stepName(old);
    const newName = stepName(s);
    if (oldName !== newName) {
      lines.push(`step ${n}: ${q(oldName)} → ${q(newName)}${how(s.id)}`);
    } else if (
      oldTarget &&
      newTarget &&
      JSON.stringify(oldTarget.candidates) !== JSON.stringify(newTarget.candidates)
    ) {
      lines.push(`step ${n}: new selectors for ${q(newName)}${how(s.id)}`);
    }
    const ov = stepValue(old);
    const nv = stepValue(s);
    if (ov !== nv) lines.push(`step ${n}: value ${q(ov ?? "")} → ${q(nv ?? "")}`);
    if (
      (old.op === "click" || old.op === "press") &&
      (s.op === "click" || s.op === "press") &&
      old.commit !== s.commit
    ) {
      lines.push(`step ${n}: ${s.commit ? "now the submit step" : "no longer the submit step"}`);
    }
  });

  a.steps.forEach((s, idx) => {
    if (!bIds.includes(s.id)) lines.push(`step ${idx + 1} removed: ${q(s.intent)}`);
  });

  const sa = a.success;
  const sb = b.success;
  if (sa.urlIncludes !== sb.urlIncludes)
    lines.push(`success URL: ${q(sa.urlIncludes ?? "")} → ${q(sb.urlIncludes ?? "")}`);
  if (sa.textPattern !== sb.textPattern) {
    lines.push(`success text: ${q(sa.textPattern ?? "")} → ${q(sb.textPattern ?? "")}`);
  }
  if (JSON.stringify(sa.extract) !== JSON.stringify(sb.extract)) {
    lines.push(
      `extracted values: ${sa.extract.map((e) => e.name).join(", ") || "none"} → ${sb.extract.map((e) => e.name).join(", ") || "none"}`,
    );
  }
  return lines;
}

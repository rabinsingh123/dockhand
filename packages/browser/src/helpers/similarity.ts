// Fingerprint similarity in the style of Similo: a weighted sum of per-attribute agreement.
// Thresholds are starting values (docs/ARCHITECTURE.md 2.5, rung 1); tune on dev seeds only.

import type { ElementDescriptor } from "@dockhand/core";

const WEIGHTS = {
  role: 3,
  label: 3,
  name: 3,
  testId: 2,
  nameAttr: 2,
  placeholder: 1.5,
  section: 1.5,
  domId: 1,
  text: 1,
  inputType: 1,
  tag: 0.5,
  bbox: 0.5,
} as const;

export type FingerprintField = keyof typeof WEIGHTS;

/** Accept a fast-path match only if its independent evidence scores at least this. */
export const FINGERPRINT_FLOOR = 0.5;
/** Similarity heal: best candidate must score at least this... */
export const SIMILARITY_ACCEPT = 0.7;
/** ...and beat the runner-up by at least this. */
export const SIMILARITY_MARGIN = 0.15;

function tokens(s: string): Set<string> {
  return new Set(
    s
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[*:()[\],]/g, " ")
      .split(/\s+/)
      .filter(Boolean),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

function fieldScore(f: FingerprintField, stored: ElementDescriptor, live: ElementDescriptor): number | null {
  if (f === "bbox") {
    const a = stored.bbox;
    const b = live.bbox;
    if (!a || (a.w === 0 && a.h === 0)) return null;
    const d = Math.hypot(a.x + a.w / 2 - (b.x + b.w / 2), a.y + a.h / 2 - (b.y + b.h / 2));
    return 1 - Math.min(d / 400, 1);
  }
  const x = stored[f];
  if (x === undefined || x === "") return null; // the stored side has no signal for this attribute
  const y = live[f] ?? "";
  if (x === y) return 1;
  if (f === "role" || f === "tag" || f === "inputType" || f === "testId" || f === "domId" || f === "nameAttr")
    return 0;
  return jaccard(tokens(x), tokens(y));
}

/** Weighted agreement of `live` with the `stored` fingerprint, 0..1. Attributes the stored side lacks are skipped. */
export function similarity(a: ElementDescriptor, b: ElementDescriptor): number {
  return similarityExcluding(a, b, new Set());
}

/** Same as similarity, ignoring attributes that were already used to find the element (they agree by construction). */
export function similarityExcluding(
  stored: ElementDescriptor,
  live: ElementDescriptor,
  exclude: ReadonlySet<FingerprintField>,
): number {
  let num = 0;
  let den = 0;
  for (const f of Object.keys(WEIGHTS) as FingerprintField[]) {
    if (exclude.has(f)) continue;
    const s = fieldScore(f, stored, live);
    if (s === null) continue;
    num += WEIGHTS[f] * s;
    den += WEIGHTS[f];
  }
  return den === 0 ? 0 : num / den;
}

export type InteractionClass = "text" | "select" | "check" | "file" | "click";

/** Hard filter for healing: a text field is never healed onto a button, a checkbox onto a combobox, and so on. */
export function interactionClass(d: ElementDescriptor): InteractionClass {
  if (d.tag === "input" && d.inputType === "file") return "file";
  switch (d.role) {
    case "textbox":
    case "searchbox":
    case "spinbutton":
      return "text";
    case "combobox":
    case "listbox":
      return "select";
    case "checkbox":
    case "radio":
    case "switch":
    case "menuitemcheckbox":
    case "menuitemradio":
      return "check";
    default:
      break;
  }
  if (d.tag === "textarea") return "text";
  if (d.tag === "select") return "select";
  if (d.tag === "input") {
    const t = d.inputType ?? "text";
    if (t === "checkbox" || t === "radio") return "check";
    if (["button", "submit", "reset", "image"].includes(t)) return "click";
    return "text";
  }
  return "click";
}

// Trace -> clean, parameterized program (computer-use review §3). Pure: the same trace and meta always
// give the same skill. It compiles outcomes, not keystrokes: each field's step carries the field's END
// value, so typos, select-all retypes, Tab hops and wrong-field detours collapse, and clicks survive only
// for their effect (navigation, commit, or a button press).

import type {
  CompileWarning,
  ParamSpec,
  ParamValue,
  Skill,
  SkillBody,
  Step,
  Target,
  Trace,
  TraceStep,
} from "@dockhand/core";
import {
  defaultIntent,
  displayName,
  hasStrongCandidate,
  interactionClass,
  pathOf,
  quote,
  type StepDraft,
} from "./targets.ts";
import {
  escapeRegex,
  isFileValue,
  isPhoneLike,
  normalizeText,
  parseIsoDate,
  templateParams,
  templateUrl,
  templateValue,
} from "./template.ts";

export interface CompileMeta {
  name: string;
  title: string;
  /** Specs from the draft or the plan. Specs the program never uses are dropped; missing ones are inferred. */
  params: ParamSpec[];
  createdFrom: Skill["createdFrom"];
}

export interface CompileResult {
  /** Version-less body; `changelog` is "" (a v1 has no parent). */
  skill: SkillBody;
  /** `stepIdx` indexes `skill.steps`, except DROPPED_ACTION where it is the trace step's `i`. */
  warnings: CompileWarning[];
}

/** Default name of the ID the success check extracts (annotate may rename it). */
export const DEFAULT_ID_NAME = "confirmation_id";

type FieldKind = "text" | "select" | "check";

interface FieldRec {
  key: string;
  kind: FieldKind;
  target: Target;
  start: string | undefined;
  /** Trace step indexes (array positions) that touched the field. */
  touches: number[];
  lastOption?: string;
  lastTouchWasOption: boolean;
  /** Text typed since the last clear; the end-value source of last resort. */
  typed: string;
}

type Item = { kind: "field"; key: string } | { kind: "step"; step: StepDraft };

interface PendingWarning {
  item: StepDraft | null;
  code: CompileWarning["code"];
  detail: string;
  traceIdx?: number;
}

const SKIPPED_ACTIONS = new Set(["scroll", "move", "wait", "screenshot"]);
const ENTER_KEYS = new Set(["enter", "return"]);
const KEY_NAMES: Record<string, string> = {
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  esc: "Escape",
  escape: "Escape",
  space: "Space",
  backspace: "Backspace",
  delete: "Delete",
  ctrl: "Control",
  control: "Control",
  cmd: "Meta",
  meta: "Meta",
  alt: "Alt",
  shift: "Shift",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
};

/** CU key names (["CTRL", "A"]) -> one Playwright chord ("Control+a"). */
export function playwrightKey(keys: readonly string[]): string {
  return keys
    .map((k) => {
      const named = KEY_NAMES[k.toLowerCase()];
      if (named) return named;
      return k.length === 1 ? k.toLowerCase() : k;
    })
    .join("+");
}

function labelKey(s: string): string {
  return normalizeText(s.replace(/\s*[*:]+\s*$/, ""));
}

function snapshotValue(snap: Record<string, string> | undefined, target: Target): string | undefined {
  if (!snap) return undefined;
  const fp = target.fingerprint;
  const entries = Object.entries(snap).map(([k, v]) => [labelKey(k), v] as const);
  for (const want of [fp.label, fp.name, fp.placeholder, fp.testId]) {
    if (!want) continue;
    const key = labelKey(want);
    const hit = entries.find(([k]) => k === key);
    if (hit) return hit[1];
  }
  return undefined;
}

function elementKey(t: TraceStep, target: Target): string {
  const f = target.fingerprint;
  const anchored = Boolean(f.label || f.domId || f.testId || f.nameAttr);
  return [
    pathOf(t.urlBefore),
    f.tag,
    f.inputType ?? "",
    f.role ?? "",
    f.domId ?? "",
    f.testId ?? "",
    f.nameAttr ?? "",
    f.label ?? "",
    anchored ? "" : (f.name ?? ""),
    anchored ? "" : (f.placeholder ?? ""),
  ].join("|");
}

function toBool(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  const s = v.trim().toLowerCase();
  if (["true", "checked", "on", "1", "yes", "sim"].includes(s)) return true;
  if (["false", "unchecked", "off", "0", "no", "nao", "não", ""].includes(s)) return false;
  return undefined;
}

function navigated(t: TraceStep): boolean {
  return pathOf(t.urlAfter) !== pathOf(t.urlBefore) || t.tags.includes("navigation");
}

function isEnter(keys: readonly string[]): boolean {
  return keys.length === 1 && ENTER_KEYS.has((keys[0] ?? "").toLowerCase());
}

function sameSnapshot(a: Record<string, string> | undefined, b: Record<string, string> | undefined): boolean {
  if (!a || !b) return true; // unknown: no evidence of an effect
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
}

/** A file slot ("W-9 form") as a param name ("w_9_form"). */
export function slotParamName(slot: string): string {
  const base = normalizeText(slot)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!base) return "file";
  return /^[a-z]/.test(base) ? base : `file_${base}`;
}

/** Keeps a path up to its first ID-like segment (records created during the run get new IDs). */
function stablePath(path: string): string {
  const segs = path.split("/");
  const out: string[] = [];
  for (const seg of segs) {
    if (seg && !seg.includes("{{") && seg.length >= 4 && /\d/.test(seg)) {
      out.push("");
      break;
    }
    out.push(seg);
  }
  return out.join("/");
}

const ID_TOKEN_RE = /[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?/g;

function looksLikeId(tok: string): boolean {
  if (tok.length < 6 || !/\d/.test(tok)) return false;
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(tok) || /^\d{1,2}-\d{1,2}-\d{2,4}$/.test(tok)) return false; // dates
  return true;
}

/** Letter runs and separators literal, digit runs as \d{n}: NW-REG-48213 -> NW-REG-\d{5}. */
export function generalizeId(token: string): string {
  return token.replace(/\d+|\D+/g, (run) => (/^\d/.test(run) ? `\\d{${run.length}}` : escapeRegex(run)));
}

/** The token that identifies the created record: on the final screen, never seen before the commit. */
function pickIdToken(trace: Trace): string | null {
  const before: string[] = [trace.startUrl];
  for (const s of trace.steps) {
    if (s.tags.includes("commit")) break;
    before.push(s.urlBefore);
    if (s.fieldValueAfter) before.push(s.fieldValueAfter);
    if (s.action.type === "type") before.push(s.action.text);
    for (const v of Object.values(s.formSnapshotBefore ?? {})) before.push(v);
  }
  for (const v of Object.values(trace.params)) {
    if (!isFileValue(v)) before.push(String(v));
  }
  const corpus = before.map((s) => s.toLowerCase());
  const seenBefore = (tok: string) => {
    const t = tok.toLowerCase();
    return corpus.some((c) => c.includes(t));
  };
  const finalPath = decodeURIComponent(pathOf(trace.final.url));
  const scored = new Map<string, number>();
  const consider = (tok: string, position: number) => {
    if (!looksLikeId(tok) || seenBefore(tok) || scored.has(tok)) return;
    const score =
      (finalPath.includes(tok) ? 4 : 0) +
      (/[A-Za-z]/.test(tok) ? 2 : 0) +
      (tok.includes("-") ? 1 : 0) -
      position / 1_000_000;
    scored.set(tok, score);
  };
  let position = 0;
  for (const seg of finalPath.split("/"))
    for (const m of seg.matchAll(ID_TOKEN_RE)) consider(m[0], position++);
  for (const m of trace.final.text.matchAll(ID_TOKEN_RE)) consider(m[0], position++);
  let best: string | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const [tok, score] of scored) {
    if (score > bestScore) {
      best = tok;
      bestScore = score;
    }
  }
  return best;
}

function inferSpec(name: string, value: ParamValue | undefined, isFile: boolean): ParamSpec {
  let type: ParamSpec["type"] = "string";
  if (isFile) type = "file";
  else if (value !== undefined) {
    if (isFileValue(value)) type = "file";
    else if (typeof value === "boolean") type = "boolean";
    else if (typeof value === "number") type = "number";
    else if (parseIsoDate(value)) type = "date";
    else if (/^[^\s@]+@[^\s@]+$/.test(value)) type = "email";
    else if (isPhoneLike(value)) type = "phone";
  }
  return { name, type, required: true, description: name.replace(/_/g, " ") };
}

function stepTemplates(s: StepDraft): string[] {
  switch (s.op) {
    case "goto":
      return [s.url];
    case "fill":
      return [s.value];
    case "select":
      return [s.option];
    case "upload":
      return [`{{${s.fileParam}}}`];
    case "waitFor":
      return [s.urlIncludes ?? "", s.text ?? ""];
    default:
      return [];
  }
}

export function compile(trace: Trace, meta: CompileMeta): CompileResult {
  if (!/^[a-z][a-z0-9_]*$/.test(meta.name)) {
    throw new Error(`compile: skill name "${meta.name}" must be snake_case`);
  }
  const params = trace.params;
  const steps = trace.steps;
  const fields = new Map<string, FieldRec>();
  const items: Item[] = [];
  const pending: PendingWarning[] = [];
  let openCombo: string | null = null;

  const dropped = (i: number, detail: string) =>
    pending.push({ item: null, code: "DROPPED_ACTION", detail, traceIdx: steps[i]?.i ?? i });
  const emit = (step: StepDraft) => {
    items.push({ kind: "step", step });
    return step;
  };
  const emitNavWait = (t: TraceStep) => {
    const path = stablePath(templateUrl(pathOf(t.urlAfter), params).template);
    if (path) emit({ op: "waitFor", intent: "", urlIncludes: path });
  };
  const isSkippable = (t: TraceStep) =>
    t.tags.includes("noise") ||
    t.tags.includes("blocked") ||
    SKIPPED_ACTIONS.has(t.action.type) ||
    (t.action.type === "fn" && !(t.tags.includes("upload") && t.upload));
  const nextMeaningful = (i: number): TraceStep | undefined => {
    for (let j = i + 1; j < steps.length; j++) {
      const s = steps[j];
      if (s && !isSkippable(s)) return s;
    }
    return undefined;
  };
  const nextSnapshot = (i: number): Record<string, string> | undefined => {
    for (let j = i + 1; j < steps.length; j++) {
      const snap = steps[j]?.formSnapshotBefore;
      if (snap) return snap;
    }
    return undefined;
  };

  const commitIdxs = steps.flatMap((s, i) =>
    s.tags.includes("commit") && !s.tags.includes("blocked") ? [i] : [],
  );
  const lastCommit = commitIdxs.at(-1);
  /** An earlier submit that left the page where it was failed (validation) and was retried. */
  const isFailedCommit = (i: number, t: TraceStep) => i !== lastCommit && !navigated(t);

  const touch = (i: number, t: TraceStep, target: Target, kind: FieldKind): FieldRec => {
    const key = elementKey(t, target);
    let f = fields.get(key);
    if (!f) {
      f = {
        key,
        kind,
        target,
        start: snapshotValue(t.formSnapshotBefore, target),
        touches: [],
        lastTouchWasOption: false,
        typed: "",
      };
      fields.set(key, f);
      items.push({ kind: "field", key });
    }
    f.touches.push(i);
    f.lastTouchWasOption = false;
    return f;
  };

  const emitUpload = (t: TraceStep) => {
    const up = t.upload;
    if (!up) return;
    const fileParam = slotParamName(up.slot);
    const prev = items.at(-1);
    if (prev?.kind === "step" && prev.step.op === "upload" && prev.step.fileParam === fileParam) return;
    emit({ op: "upload", intent: "", target: up.target, fileParam });
  };

  for (let i = 0; i < steps.length; i++) {
    const t = steps[i] as TraceStep;
    if (isSkippable(t)) continue;
    const a = t.action;
    if (a.type === "fn") {
      emitUpload(t);
      continue;
    }
    if (a.type === "drag") {
      dropped(i, "drag is not replayed");
      continue;
    }

    if (a.type === "click" || a.type === "double_click") {
      if (a.type === "click" && a.button && a.button !== "left") {
        dropped(i, `${a.button}-button click is not replayed`);
        continue;
      }
      if (t.tags.includes("upload")) {
        if (t.upload) emitUpload(t);
        openCombo = null;
        continue;
      }
      const target = t.target;
      if (t.tags.includes("commit")) {
        openCombo = null;
        if (isFailedCommit(i, t)) {
          dropped(i, "submit attempt that stayed on the page (a later submit went through)");
        } else if (!target) {
          dropped(i, "commit click without a target element");
        } else {
          emit({ op: "click", intent: "", target, commit: true });
        }
        continue;
      }
      if (!target) {
        dropped(i, `click at (${"x" in a ? a.x : "?"}, ${"y" in a ? a.y : "?"}) hit no element`);
        continue;
      }
      const cls = interactionClass(target.fingerprint);
      if (target.fingerprint.role === "option" || t.tags.includes("option")) {
        const combo = openCombo ? fields.get(openCombo) : undefined;
        if (!combo) {
          dropped(i, `option ${quote(displayName(target.fingerprint))} clicked with no open list`);
          continue;
        }
        combo.touches.push(i);
        combo.lastOption = target.fingerprint.name ?? target.fingerprint.text ?? "";
        combo.lastTouchWasOption = true;
        continue;
      }
      if (cls === "text" || cls === "select" || cls === "check") {
        touch(i, t, target, cls);
        openCombo = cls === "select" ? elementKey(t, target) : null;
        continue;
      }
      if (cls === "file") {
        openCombo = null;
        continue; // clicking a file input opens the chooser; the upload step carries the file
      }
      openCombo = null;
      const nav = navigated(t);
      const next = nextMeaningful(i);
      if (cls === "none" && !nav && sameSnapshot(t.formSnapshotBefore, next?.formSnapshotBefore)) {
        dropped(i, `click on ${quote(displayName(target.fingerprint))} changed nothing`);
        continue;
      }
      if (next?.tags.includes("upload") && !nav) continue; // the chooser trigger; replay sets the file directly
      emit({ op: "click", intent: "", target });
      if (nav) emitNavWait(t);
      continue;
    }

    if (a.type === "type") {
      const target = t.target;
      if (!target) {
        dropped(i, "typed text with no focused field");
        continue;
      }
      const cls = interactionClass(target.fingerprint);
      if (cls !== "text" && cls !== "select") {
        dropped(i, `typed into ${quote(displayName(target.fingerprint))}, which is not a field`);
        continue;
      }
      const f = touch(i, t, target, cls);
      if (cls === "select") openCombo = f.key;
      const text = a.text.replace(/\r?\n$/, "");
      f.typed = t.fieldValueAfter ?? f.typed + text;
      if (a.text.endsWith("\n")) {
        if (t.tags.includes("commit") && !isFailedCommit(i, t)) {
          emit({ op: "press", intent: "", key: "Enter", target, commit: true });
        } else if (navigated(t)) {
          emit({ op: "press", intent: "", key: "Enter", target });
          emitNavWait(t);
        }
      }
      continue;
    }

    if (a.type === "keypress") {
      const key = playwrightKey(a.keys);
      const target = t.target;
      if (t.tags.includes("commit") && isEnter(a.keys)) {
        if (isFailedCommit(i, t))
          dropped(i, "Enter submit that stayed on the page (a later submit went through)");
        else emit({ op: "press", intent: "", key, ...(target ? { target } : {}), commit: true });
        continue;
      }
      if (target) {
        const cls = interactionClass(target.fingerprint);
        if (cls === "text" || cls === "select" || cls === "check") {
          const f = touch(i, t, target, cls);
          if (/^(Control|Meta)\+a$/.test(key) || key === "Backspace" || key === "Delete") {
            if (t.fieldValueAfter === "") f.typed = "";
          }
        }
      }
      if (navigated(t)) {
        emit({ op: "press", intent: "", key, ...(target ? { target } : {}) });
        emitNavWait(t);
      }
      // Anything else (Tab hops, select-all, Escape, arrows) is absorbed into the field end states.
    }
  }

  // ---- resolve fields into steps (first-touch order) ----
  const out: StepDraft[] = [];
  for (const item of items) {
    if (item.kind === "step") {
      out.push(item.step);
      continue;
    }
    const f = fields.get(item.key) as FieldRec;
    const step = fieldStep(f);
    if (step) out.push(step);
  }

  function endValue(f: FieldRec): string | undefined {
    const last = f.touches.at(-1) as number;
    const lastStep = steps[last] as TraceStep;
    if (f.kind === "select" && f.lastTouchWasOption) {
      return snapshotValue(nextSnapshot(last), f.target) ?? f.lastOption;
    }
    const after = lastStep.fieldValueAfter ?? snapshotValue(nextSnapshot(last), f.target);
    if (after !== undefined) return after;
    if (f.kind === "check") return String(!(toBool(f.start) ?? false));
    if (f.kind === "select" && f.lastOption) return f.lastOption;
    return f.typed;
  }

  function fieldStep(f: FieldRec): StepDraft | null {
    const end = endValue(f) ?? "";
    const fp = f.target.fingerprint;
    if (f.kind === "check") {
      const checked = toBool(end) ?? true;
      if (toBool(f.start) === checked) return null;
      return { op: "check", intent: "", target: f.target, checked };
    }
    if (end === "" && (f.start ?? "") === "") return null;
    const tv = templateValue(end, params, { label: displayName(fp), formatHint: fp.placeholder });
    if (!tv.binding && end === (f.start ?? "")) return null; // touched but left as it was
    const step: StepDraft =
      f.kind === "select"
        ? { op: "select", intent: "", trigger: f.target, option: tv.template }
        : { op: "fill", intent: "", target: f.target, value: tv.template };
    const where = quote(displayName(fp));
    if (!tv.binding) {
      if (end !== "") {
        pending.push({ item: step, code: "LITERAL_VALUE", detail: `will always enter "${end}" in ${where}` });
      }
    } else {
      if (tv.alternatives.length > 0) {
        const names = [tv.binding.param, ...tv.alternatives.map((a) => a.param)].join(", ");
        pending.push({
          item: step,
          code: "AMBIGUOUS_PARAM",
          detail: `the value in ${where} matches params ${names}; using ${tv.binding.param}`,
        });
      }
      if (tv.binding.match === "normalized") {
        pending.push({
          item: step,
          code: "ROUNDTRIP_MISMATCH",
          detail: `the run entered "${end}" in ${where}; replays enter the value of ${tv.binding.param} as given`,
        });
      }
    }
    return step;
  }

  // ---- program ----
  const start = templateUrl(trace.startUrl, params);
  for (const b of start.bindings) {
    if (b.alternatives.length > 0) {
      pending.push({
        item: null,
        code: "AMBIGUOUS_PARAM",
        detail: `URL segment "${b.segment}" matches params ${[b.binding.param, ...b.alternatives.map((a) => a.param)].join(", ")}`,
        traceIdx: 0,
      });
    }
  }
  const drafts: StepDraft[] = [{ op: "goto", intent: "", url: start.template }, ...out];
  const program: Step[] = drafts.map(
    (d, idx) => ({ ...d, id: `s${idx + 1}`, intent: defaultIntent(d) }) as Step,
  );

  const warnings: CompileWarning[] = [];
  for (const w of pending) {
    if (w.code === "DROPPED_ACTION" || w.item === null) {
      warnings.push({ stepIdx: w.traceIdx ?? 0, code: w.code, detail: w.detail });
    } else {
      warnings.push({ stepIdx: drafts.indexOf(w.item), code: w.code, detail: w.detail });
    }
  }
  program.forEach((s, idx) => {
    const target = s.op === "select" ? s.trigger : "target" in s ? s.target : undefined;
    if (target && !hasStrongCandidate(target.candidates)) {
      warnings.push({
        stepIdx: idx,
        code: "NO_STABLE_SELECTOR",
        detail: `no strong selector for ${quote(displayName(target.fingerprint))}; replays rely on healing`,
      });
    }
  });

  // ---- params: the ones the program uses, in the meta's order, inferred when missing ----
  const used: string[] = [];
  for (const d of drafts) {
    for (const t of stepTemplates(d))
      for (const name of templateParams(t)) if (!used.includes(name)) used.push(name);
  }
  const fileParams = new Set(drafts.flatMap((d) => (d.op === "upload" ? [d.fileParam] : [])));
  const specs = meta.params.filter((p) => used.includes(p.name));
  for (const name of used) {
    if (!specs.some((p) => p.name === name)) specs.push(inferSpec(name, params[name], fileParams.has(name)));
  }

  return {
    skill: {
      name: meta.name,
      title: meta.title,
      portalId: trace.portalId,
      params: specs,
      steps: program,
      success: successCheck(
        trace,
        commitIdxs.length > 0 ? (steps[lastCommit as number] as TraceStep) : undefined,
      ),
      createdFrom: meta.createdFrom,
      changelog: "",
    },
    warnings,
  };
}

/**
 * generalizeId, plus: a letter run that equals one of the run's values (a tenant in "SG-ACME-482913") becomes
 * a letter class, so the check holds for every tenant instead of the one the first run used.
 */
export function generalizeIdFor(token: string, params: Record<string, ParamValue>): string {
  const values = new Set(
    Object.values(params)
      .filter((v): v is string => typeof v === "string" && /^[A-Za-z]{3,}$/.test(v))
      .map((v) => v.toLowerCase()),
  );
  return token.replace(/\d+|\D+/g, (run) => {
    if (/^\d/.test(run)) return `\\d{${run.length}}`;
    return run.replace(/[A-Za-z]+/g, (letters) => {
      if (!values.has(letters.toLowerCase())) return escapeRegex(letters);
      return letters === letters.toUpperCase()
        ? "[A-Z]+"
        : letters === letters.toLowerCase()
          ? "[a-z]+"
          : "[A-Za-z]+";
    });
  });
}

function successCheck(trace: Trace, commit: TraceStep | undefined): Skill["success"] {
  const token = pickIdToken(trace);
  const idRegex = token ? generalizeIdFor(token, trace.params) : undefined;
  const finalPath = pathOf(trace.final.url);
  const beforePath = pathOf(commit?.urlBefore ?? trace.startUrl);
  let urlIncludes: string | undefined;
  if (finalPath !== beforePath) {
    const decoded = decodeURIComponent(finalPath);
    const at = token ? decoded.indexOf(token) : -1;
    if (token && at >= 0) {
      // The path up to the ID, with run values templated ("/t/{{tenant}}/register/complete/"); the ID's own
      // letters only when no run value hides in them.
      const prefix = templateUrl(decoded.slice(0, at), trace.params).template;
      const literal = /^\D*/.exec(token)?.[0] ?? "";
      const literalIsFixed = generalizeIdFor(literal, trace.params) === escapeRegex(literal);
      urlIncludes = prefix + (literalIsFixed ? literal : "");
    } else {
      urlIncludes = stablePath(templateUrl(finalPath, trace.params).template) || undefined;
    }
  }
  return {
    ...(urlIncludes ? { urlIncludes } : {}),
    ...(idRegex ? { textPattern: idRegex } : {}),
    extract: idRegex ? [{ name: DEFAULT_ID_NAME, regex: idRegex }] : [],
  };
}

/** Points every absolute goto URL at another origin (a portal started on a different port, say). */
export function rebaseSkill<S extends { steps: Step[] }>(skill: S, origin: string): S {
  const base = origin.replace(/\/+$/, "");
  return {
    ...skill,
    steps: skill.steps.map((s) => {
      if (s.op !== "goto") return s;
      const m = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(.*)$/i.exec(s.url);
      return m ? { ...s, url: `${base}${m[1] ?? ""}` } : s;
    }),
  };
}

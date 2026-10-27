// Muse Spark "compile_annotate": one structured call writes the human parts of a compiled skill (step
// intents, param names, descriptions and types, the success check). The model proposes; code keeps only
// changes that preserve the bindings and check out against the run the skill was compiled from.

import {
  type CallCtx,
  type ModelGateway,
  type ParamSpec,
  ParamType,
  type ParamValue,
  type SkillBody,
  type SkillDraft,
  type Step,
  type Trace,
} from "@dockhand/core";
import { z } from "zod";
import { DEFAULT_ID_NAME } from "./compile.ts";
import { displayName, pathOf, stepTarget } from "./targets.ts";
import {
  isFileValue,
  isParamName,
  isPhoneLike,
  parseIsoDate,
  plainNumber,
  renameTemplateParams,
  templateParams,
} from "./template.ts";

export const ANNOTATE_MODEL = "muse-spark-1.3";

export const SkillAnnotation = z.object({
  title: z.string(),
  steps: z.array(z.object({ id: z.string(), intent: z.string() })),
  params: z.array(
    z.object({ name: z.string(), newName: z.string(), description: z.string(), type: ParamType }),
  ),
  success: z.object({
    description: z.string(),
    textPattern: z.string().nullable(),
    idRegex: z.string().nullable(),
    idName: z.string().nullable(),
  }),
});
export type SkillAnnotation = z.infer<typeof SkillAnnotation>;

export interface AnnotateReport {
  body: SkillBody;
  /** One line per accepted change. */
  applied: string[];
  /** One line per proposal that failed verification. */
  rejected: string[];
  /** Set when no model call was made or it failed (the body is returned unchanged). */
  skipped?: string;
  /** The model's description of the confirmation screen, for the skill card. */
  successDescription?: string;
}

const INSTRUCTIONS = `You annotate a browser automation that was compiled from one recorded run on a business web portal.
Return:
- title: a short name for the task (at most 8 words).
- steps: for EVERY step id given, an intent: one plain sentence saying what the step does in the user's terms, e.g. "Enter the end customer's company name" or "Submit the registration". Repairs use it to find the element if the page changes, so name the field or button as the page shows it.
- params: for EVERY param given: newName (a clear snake_case name; repeat the current name if it is already clear), a one-line description a sales rep understands, and the type.
- success: description (what the confirmation screen shows), textPattern (a JavaScript regex that matches text on the confirmation page, or null), idRegex (a JavaScript regex for the identifier of the created record as it appears on the confirmation page, or null), idName (snake_case name for that identifier, or null).
Never add or remove steps or params. Use null when unsure.`;

/** Annotates a compiled skill; returns it unchanged when no model is available or the call fails. */
export async function annotateSkill(
  body: SkillBody,
  trace: Trace,
  draft: SkillDraft | null,
  models: ModelGateway | null,
  ctx: Omit<CallCtx, "purpose">,
): Promise<SkillBody> {
  return (await annotateSkillDetailed(body, trace, draft, models, ctx)).body;
}

export async function annotateSkillDetailed(
  body: SkillBody,
  trace: Trace,
  draft: SkillDraft | null,
  models: ModelGateway | null,
  ctx: Omit<CallCtx, "purpose">,
): Promise<AnnotateReport> {
  if (!models) return { body, applied: [], rejected: [], skipped: "no model gateway" };
  let annotation: SkillAnnotation;
  try {
    annotation = await models.structured(
      {
        model: ANNOTATE_MODEL,
        instructions: INSTRUCTIONS,
        input: [{ type: "text", text: annotatePrompt(body, trace, draft) }],
        schemaName: "skill_annotation",
        schema: SkillAnnotation,
        effort: "low",
        maxOutputTokens: 4000,
      },
      { ...ctx, purpose: "compile_annotate" },
    );
  } catch (err) {
    return { body, applied: [], rejected: [], skipped: `model call failed: ${(err as Error).message}` };
  }
  return applyAnnotation(body, trace, annotation);
}

function valueText(v: ParamValue | undefined): string | undefined {
  if (v === undefined) return undefined;
  return isFileValue(v) ? v.filename : String(v);
}

export function annotatePrompt(body: SkillBody, trace: Trace, draft: SkillDraft | null): string {
  const steps = body.steps.map((s) => {
    const t = stepTarget(s);
    return {
      id: s.id,
      op: s.op,
      intent: s.intent,
      ...(t
        ? {
            element: displayName(t.fingerprint),
            role: t.fingerprint.role ?? t.fingerprint.tag,
            ...(t.fingerprint.section ? { section: t.fingerprint.section } : {}),
          }
        : {}),
      ...(s.op === "fill" ? { value: s.value } : {}),
      ...(s.op === "select" ? { option: s.option } : {}),
      ...(s.op === "check" ? { checked: s.checked } : {}),
      ...(s.op === "goto" ? { url: s.url } : {}),
      ...(s.op === "waitFor" && s.urlIncludes ? { urlIncludes: s.urlIncludes } : {}),
      ...((s.op === "click" || s.op === "press") && s.commit ? { commit: true } : {}),
    };
  });
  const payload = {
    portal: body.portalId,
    title: body.title,
    ...(draft
      ? {
          goal: draft.goal,
          taughtSteps: draft.steps,
          commitControl: draft.commitStep,
          taughtSuccess: draft.success,
        }
      : {}),
    params: body.params.map((p) => ({
      name: p.name,
      type: p.type,
      description: p.description,
      valueInThisRun: valueText(trace.params[p.name]),
    })),
    steps,
    success: body.success,
    confirmationPage: { path: pathOf(trace.final.url), text: trace.final.text.slice(0, 2500) },
  };
  return JSON.stringify(payload, null, 1);
}

function compileRegex(source: string): RegExp | null {
  if (source.length === 0 || source.length > 300) return null;
  try {
    return new RegExp(source);
  } catch {
    return null;
  }
}

function distinctMatches(re: RegExp, text: string): Set<string> {
  const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  return new Set([...text.matchAll(global)].map((m) => m[0]).filter((m) => m.length > 0));
}

function fitsType(type: ParamSpec["type"], value: ParamValue | undefined, isUpload: boolean): boolean {
  if (isUpload !== (type === "file")) return false;
  if (value === undefined || type === "file" || type === "string" || type === "enum") return true;
  if (isFileValue(value)) return false;
  switch (type) {
    case "number":
      return plainNumber(value) !== null;
    case "date":
      return typeof value === "string" && parseIsoDate(value) !== null;
    case "email":
      return typeof value === "string" && /^[^\s@]+@[^\s@]+$/.test(value);
    case "phone":
      return typeof value === "string" && isPhoneLike(value);
    case "boolean":
      return typeof value === "boolean" || value === "true" || value === "false";
  }
}

/** Every template string a step carries, with a setter for rewriting it. */
function mapStepTemplates(step: Step, fn: (t: string) => string): Step {
  switch (step.op) {
    case "goto":
      return { ...step, url: fn(step.url) };
    case "fill":
      return { ...step, value: fn(step.value) };
    case "select":
      return { ...step, option: fn(step.option) };
    case "waitFor":
      return {
        ...step,
        ...(step.urlIncludes !== undefined ? { urlIncludes: fn(step.urlIncludes) } : {}),
        ...(step.text !== undefined ? { text: fn(step.text) } : {}),
      };
    default:
      return step;
  }
}

/** Param names the skill references (templates and upload slots). Throws on a malformed template. */
export function referencedParams(body: Pick<SkillBody, "steps" | "success">): Set<string> {
  const out = new Set<string>();
  for (const s of body.steps) {
    if (s.op === "upload") out.add(s.fileParam);
    mapStepTemplates(s, (t) => {
      for (const n of templateParams(t)) out.add(n);
      return t;
    });
  }
  if (body.success.urlIncludes) for (const n of templateParams(body.success.urlIncludes)) out.add(n);
  return out;
}

/** Applies the verified parts of an annotation. Pure. */
export function applyAnnotation(body: SkillBody, trace: Trace, a: SkillAnnotation): AnnotateReport {
  const applied: string[] = [];
  const rejected: string[] = [];
  let next: SkillBody = { ...body, params: body.params.map((p) => ({ ...p })), steps: [...body.steps] };

  const title = a.title.trim();
  if (title && title.length <= 100 && title !== body.title) {
    next.title = title;
    applied.push(`title: ${title}`);
  }

  const byId = new Map(a.steps.map((s) => [s.id, s.intent.trim()]));
  next.steps = next.steps.map((s) => {
    const intent = byId.get(s.id);
    if (intent === undefined || intent === s.intent) return s;
    if (intent.length < 3 || intent.length > 200) {
      rejected.push(`intent for ${s.id}: length ${intent.length}`);
      return s;
    }
    applied.push(`intent ${s.id}: ${intent}`);
    return { ...s, intent };
  });
  for (const id of byId.keys())
    if (!body.steps.some((s) => s.id === id)) rejected.push(`intent for unknown step ${id}`);

  // Params: descriptions and types first, renames last (all or nothing).
  const uploads = new Set(body.steps.flatMap((s) => (s.op === "upload" ? [s.fileParam] : [])));
  const renames: Record<string, string> = {};
  for (const p of a.params) {
    const spec = next.params.find((x) => x.name === p.name);
    if (!spec) {
      rejected.push(`unknown param ${p.name}`);
      continue;
    }
    const description = p.description.trim();
    if (description && description.length <= 300 && description !== spec.description) {
      spec.description = description;
      applied.push(`description ${p.name}: ${description}`);
    }
    if (p.type !== spec.type) {
      if (fitsType(p.type, trace.params[p.name], uploads.has(p.name))) {
        applied.push(`type ${p.name}: ${spec.type} -> ${p.type}`);
        spec.type = p.type;
        if (p.type !== "enum") delete spec.enumValues;
      } else {
        rejected.push(`type ${p.name}: ${p.type} does not fit the run's value`);
      }
    }
    const newName = p.newName.trim();
    if (newName && newName !== p.name) {
      if (!isParamName(newName)) rejected.push(`rename ${p.name} -> ${newName}: not snake_case`);
      else renames[p.name] = newName;
    }
  }
  const renamed = applyRenames(next, renames);
  if (renamed.ok) {
    next = renamed.body;
    for (const [from, to] of Object.entries(renames)) applied.push(`rename ${from} -> ${to}`);
  } else if (Object.keys(renames).length > 0) {
    rejected.push(`renames: ${renamed.reason}`);
  }

  // Success check: only regexes that match the confirmation page the run actually reached.
  const page = `${decodeURIComponent(pathOf(trace.final.url))}\n${trace.final.text}`;
  const success = { ...next.success, extract: next.success.extract.map((e) => ({ ...e })) };
  const oldId = success.extract[0]?.regex;
  if (a.success.idRegex !== null) {
    const re = compileRegex(a.success.idRegex);
    const hits = re ? distinctMatches(re, page) : new Set<string>();
    if (re && hits.size === 1) {
      if (success.extract[0]) success.extract[0].regex = a.success.idRegex;
      else success.extract.push({ name: DEFAULT_ID_NAME, regex: a.success.idRegex });
      if (success.textPattern === undefined || success.textPattern === oldId)
        success.textPattern = a.success.idRegex;
      if (a.success.idRegex !== oldId) applied.push(`id regex: ${a.success.idRegex}`);
    } else {
      rejected.push(
        `id regex ${a.success.idRegex}: ${re ? `${hits.size} distinct matches on the page` : "invalid"}`,
      );
    }
  }
  if (a.success.idName !== null && success.extract[0] && a.success.idName !== success.extract[0].name) {
    if (isParamName(a.success.idName)) {
      applied.push(`id name: ${success.extract[0].name} -> ${a.success.idName}`);
      success.extract[0].name = a.success.idName;
    } else {
      rejected.push(`id name ${a.success.idName}: not snake_case`);
    }
  }
  if (a.success.textPattern !== null && a.success.textPattern !== success.textPattern) {
    const re = compileRegex(a.success.textPattern);
    if (re?.test(trace.final.text)) {
      // A model pattern is only an addition when the compiler found no ID to check.
      if (success.textPattern === undefined) {
        success.textPattern = a.success.textPattern;
        applied.push(`text pattern: ${a.success.textPattern}`);
      }
    } else {
      rejected.push(
        `text pattern ${a.success.textPattern}: ${re ? "does not match the confirmation page" : "invalid"}`,
      );
    }
  }
  next.success = success;

  const description = a.success.description.trim();
  return { body: next, applied, rejected, ...(description ? { successDescription: description } : {}) };
}

/** Renames params everywhere they are referenced; refuses if anything would dangle or collide. */
export function applyRenames(
  body: SkillBody,
  renames: Record<string, string>,
): { ok: true; body: SkillBody } | { ok: false; reason: string } {
  if (Object.keys(renames).length === 0) return { ok: true, body };
  const finalNames = body.params.map((p) => renames[p.name] ?? p.name);
  if (new Set(finalNames).size !== finalNames.length)
    return { ok: false, reason: "two params would share a name" };
  for (const from of Object.keys(renames)) {
    if (!body.params.some((p) => p.name === from)) return { ok: false, reason: `unknown param ${from}` };
  }
  const steps = body.steps.map((s) => {
    const moved = mapStepTemplates(s, (t) => renameTemplateParams(t, renames));
    return moved.op === "upload" && renames[moved.fileParam]
      ? { ...moved, fileParam: renames[moved.fileParam] as string }
      : moved;
  });
  const success = {
    ...body.success,
    ...(body.success.urlIncludes
      ? { urlIncludes: renameTemplateParams(body.success.urlIncludes, renames) }
      : {}),
  };
  const params = body.params.map((p) => (renames[p.name] ? { ...p, name: renames[p.name] as string } : p));
  const out: SkillBody = { ...body, params, steps, success };
  let refs: Set<string>;
  try {
    refs = referencedParams(out);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  const names = new Set(params.map((p) => p.name));
  for (const r of refs)
    if (!names.has(r)) return { ok: false, reason: `the skill would reference missing param ${r}` };
  return { ok: true, body: out };
}

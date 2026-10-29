// Paid rungs of the heal ladder. Both return replacement steps for the runner to splice in; the runner
// executes them (commit steps still go through read-back and approval), and code verifies what the models
// propose: the open-weights pick must be a unique element of the same kind; a computer-use repair may not
// change values, and a commit step is only ever proposed (propose_only), never clicked by the model.

import { describeLocator, listInteractive, toLocator } from "@dockhand/browser";
import type {
  ArtifactRef,
  ArtifactStore,
  Candidate,
  ComputerUseModel,
  CuRunInput,
  CuRunResult,
  InteractiveElement,
  Ledger,
  ModelGateway,
  Repairer,
  RepairResult,
  RunComputerUse,
  Step,
  Target,
  WriteGuardConfig,
} from "@dockhand/core";
import type { Locator, Page } from "playwright";
import { z } from "zod";
import { compile } from "./compile.ts";
import {
  displayName,
  interactionClass,
  isCommitStep,
  mergeCandidates,
  optionPickTarget,
  stepTarget,
  targetParams,
  withStepTarget,
} from "./targets.ts";
import { isFileValue, normalizeText, renderTemplate, templateParams } from "./template.ts";

export const ElementPick = z.object({
  index: z.number().int().nullable(),
  confidence: z.number(),
  reason: z.string(),
});
export type ElementPick = z.infer<typeof ElementPick>;

const OPEN_WEIGHTS_INSTRUCTIONS = `A web page changed and one step of a recorded browser automation can no longer find its element.
Pick the element on the current page that the step should use now, from the numbered list (all of the same kind).
Answer with its index, or null when none of them clearly does what the step needs. Never pick an element that only
looks similar but does something else (for example "Save draft" instead of "Submit", or a different field with a
similar label). confidence is between 0 and 1.`;

/** Elements in the prompt list, at most. */
const MAX_LIST = 60;
const MIN_CONFIDENCE = 0.5;

function costTracker(ledger: Ledger | undefined, runId: string) {
  const total = () => (ledger ? ledger.totals({ runId }).costUsd : 0);
  const start = total();
  return () => Math.max(0, total() - start);
}

function brief(d: InteractiveElement["descriptor"]) {
  const out: Record<string, string> = {};
  if (d.role) out.role = d.role;
  if (d.name) out.name = d.name;
  if (d.label && d.label !== d.name) out.label = d.label;
  if (d.placeholder) out.placeholder = d.placeholder;
  if (d.section) out.section = d.section;
  if (d.testId) out.testId = d.testId;
  if (d.text && d.text !== d.name) out.text = d.text;
  return out;
}

/** First stored candidate that resolves to exactly one element. */
async function uniqueLocator(
  page: Page,
  candidates: Candidate[],
  allowHidden: boolean,
): Promise<Locator | null> {
  for (const c of candidates) {
    const loc = toLocator(page, c, { allowHidden });
    if ((await loc.count().catch(() => 0)) === 1) return loc;
  }
  return null;
}

/**
 * Rung "open_weights": Muse Spark Open picks the element from a pruned, text-only accessibility list. The pick
 * must exist in the list, be the same kind of element as before, and resolve uniquely; the replacement step
 * carries the element's fresh candidates (old ones kept as fallbacks).
 */
export function createOpenWeightsRepairer(
  models: ModelGateway,
  opts: { model: string; ledger?: Ledger; maxElements?: number; minConfidence?: number },
): Repairer {
  const repair: Repairer = async (req, _hooks, ctx): Promise<RepairResult> => {
    const rung = "open_weights" as const;
    const step = req.skill.steps[req.stepIdx];
    const target = step ? stepTarget(step) : undefined;
    if (!step || !target) return { ok: false, rung, reason: "the step has no element to find", costUsd: 0 };
    if (!models.hasOpenWeights())
      return { ok: false, rung, reason: "no open-weights provider is configured", costUsd: 0 };

    const cls = interactionClass(target.fingerprint);
    const all = await listInteractive(req.page);
    const pruned = all
      .filter((e) => e.candidates.length > 0 && interactionClass(e.descriptor) === cls)
      .slice(0, opts.maxElements ?? MAX_LIST);
    if (pruned.length === 0) return { ok: false, rung, reason: `no ${cls} elements on the page`, costUsd: 0 };

    const prev = req.skill.steps[req.stepIdx - 1];
    const next = req.skill.steps[req.stepIdx + 1];
    const prompt = [
      `Step: ${step.intent}`,
      ...(prev ? [`Previous step: ${prev.intent}`] : []),
      ...(next ? [`Next step: ${next.intent}`] : []),
      `Element the step used before the change: ${JSON.stringify(brief(target.fingerprint))}`,
      "Elements of the same kind on the page now:",
      JSON.stringify(pruned.map((e) => ({ index: e.index, ...brief(e.descriptor) }))),
    ].join("\n");

    const cost = costTracker(opts.ledger, req.runId);
    let pick: ElementPick;
    try {
      pick = await models.structured(
        {
          model: opts.model,
          instructions: OPEN_WEIGHTS_INSTRUCTIONS,
          input: [{ type: "text", text: prompt }],
          schemaName: "element_pick",
          schema: ElementPick,
          effort: "low",
          maxOutputTokens: 400,
        },
        { ...ctx, purpose: "heal_match" },
      );
    } catch (err) {
      return { ok: false, rung, reason: `model call failed: ${(err as Error).message}`, costUsd: cost() };
    }
    const costUsd = cost();
    if (pick.index === null) return { ok: false, rung, reason: `no match: ${pick.reason}`, costUsd };
    if (pick.confidence < (opts.minConfidence ?? MIN_CONFIDENCE)) {
      return { ok: false, rung, reason: `low confidence ${pick.confidence}: ${pick.reason}`, costUsd };
    }
    const el = pruned.find((e) => e.index === pick.index);
    if (!el) return { ok: false, rung, reason: `index ${pick.index} is not in the list`, costUsd };
    const oldRole = target.fingerprint.role;
    if (oldRole && el.descriptor.role && el.descriptor.role !== oldRole) {
      return {
        ok: false,
        rung,
        reason: `picked a ${el.descriptor.role}, the step needs a ${oldRole}`,
        costUsd,
      };
    }
    const loc = await uniqueLocator(req.page, el.candidates, cls === "file");
    if (!loc) return { ok: false, rung, reason: "the picked element has no unique selector", costUsd };
    const fresh = await describeLocator(loc);
    const retargeted: Target = {
      candidates: mergeCandidates(fresh.candidates, target.candidates),
      fingerprint: fresh.fingerprint,
    };
    return {
      ok: true,
      rung,
      steps: [withStepTarget(step, retargeted)],
      costUsd,
      note: `now '${displayName(fresh.fingerprint)}' (${pick.reason})`,
    };
  };
  return Object.assign(repair, { rung: "open_weights" as const }); // the rung, for the demo HUD
}

/** The value a fill/select step enters with these params, for the repair goal. */
function stepValue(step: Step, params: Record<string, unknown>): string | null {
  const t = step.op === "fill" ? step.value : step.op === "select" ? step.option : null;
  if (t === null) return null;
  try {
    return renderTemplate(t, params as never);
  } catch {
    return null;
  }
}

function boundParams(steps: Step[]): Set<string> {
  const out = new Set<string>();
  for (const s of steps) {
    if (s.op === "fill") for (const n of templateParams(s.value)) out.add(n);
    if (s.op === "select") for (const n of templateParams(s.option)) out.add(n);
    if (s.op === "upload") out.add(s.fileParam);
    if (s.op === "check") for (const n of targetParams(s.target)) out.add(n);
  }
  return out;
}

/**
 * A repair that ticked the radio button named like the value a select or fill step writes (the dropdown became
 * radio buttons): kept as "check the option named {{param}}", so it holds for any value. Null otherwise.
 */
function asOptionPick(original: Step, replacement: Step[], params: Record<string, unknown>): Step[] | null {
  if (original.op !== "select" && original.op !== "fill") return null;
  const template = original.op === "select" ? original.option : original.value;
  const [param, ...more] = templateParams(template);
  if (!param || more.length > 0 || template.trim() !== `{{${param}}}`) return null;
  const value = stepValue(original, params);
  const writes = replacement.filter(
    (s) => s.op === "fill" || s.op === "select" || s.op === "check" || s.op === "click",
  );
  const pick = writes[0];
  if (writes.length !== 1 || !pick || (pick.op !== "check" && pick.op !== "click")) return null;
  const fp = pick.target.fingerprint;
  if (
    fp.role !== "radio" ||
    value === null ||
    normalizeText(fp.name ?? fp.label ?? "") !== normalizeText(value)
  )
    return null;
  const target = optionPickTarget(pick.target, param, displayName(stepTarget(original)?.fingerprint));
  return [{ id: original.id, intent: original.intent, op: "check", target, checked: true }];
}

/** Repairs may not change values: the replacement writes exactly the params the step wrote, and no literals. */
function keepsValues(original: Step, replacement: Step[]): string | null {
  const before = boundParams([original]);
  const after = boundParams(replacement);
  for (const n of after)
    if (!before.has(n)) return `the repair entered param ${n}, which this step does not write`;
  for (const n of before) if (!after.has(n)) return `the repair did not enter ${n}`;
  const literal = replacement.find(
    (s) =>
      (s.op === "fill" &&
        templateParams(s.value).length === 0 &&
        !(original.op === "fill" && original.value === s.value)) ||
      (s.op === "select" &&
        templateParams(s.option).length === 0 &&
        !(original.op === "select" && original.option === s.option)),
  );
  return literal
    ? `the repair entered a value that is not a param (${displayName(stepTarget(literal)?.fingerprint)})`
    : null;
}

export interface CuRepairerOptions {
  model: ComputerUseModel;
  runComputerUse: RunComputerUse;
  artifacts: ArtifactStore;
  writeGuard: WriteGuardConfig;
  /** When given, the repair's cost is read from the ledger (calls for this run made during the repair). */
  ledger?: Ledger;
  limits?: Partial<CuRunInput["limits"]>;
}

/**
 * Rung "computer_use": Muse computer use with a narrow goal (this one step, these values), at most 8 actions
 * and $0.50. A commit step runs in propose_only mode and becomes a click on the proposed element (the runner
 * then asks for approval); any other step's sub-trace is compiled into replacement steps.
 */
export function createCuRepairer(opts: CuRepairerOptions): Repairer {
  const repair: Repairer = async (req, hooks, ctx): Promise<RepairResult> => {
    const rung = "computer_use" as const;
    const step = req.skill.steps[req.stepIdx];
    if (!step) return { ok: false, rung, reason: `no step ${req.stepIdx}`, costUsd: 0 };
    const commit = isCommitStep(step);
    const value = stepValue(step, req.params);
    const oldName = displayName(stepTarget(step)?.fingerprint);
    const goal = commit
      ? `Find the control that does this step: ${step.intent} (it used to be labelled "${oldName}"). Do not click it; call propose_target with it.`
      : `Complete only this step: ${step.intent}.${value !== null ? ` Enter exactly "${value}".` : ""} Do not change any other field and do not submit the form.`;
    const commitHints = commit
      ? [oldName]
      : req.skill.steps.filter(isCommitStep).map((s) => displayName(stepTarget(s)?.fingerprint));
    const attachments: Record<string, ArtifactRef> = {};
    if (step.op === "upload") {
      const v = req.params[step.fileParam];
      if (v !== undefined && isFileValue(v)) attachments[step.fileParam] = v.file;
    }
    const cost = costTracker(opts.ledger, req.runId);
    let r: CuRunResult;
    try {
      r = await opts.runComputerUse(
        opts.model,
        {
          page: req.page,
          portalId: req.skill.portalId,
          runId: req.runId,
          goal,
          guidance: [step.intent],
          params: req.params,
          attachments,
          commitPolicy: commit ? "propose_only" : "gate",
          commitHints,
          writeGuard: opts.writeGuard,
          limits: {
            maxActions: 8,
            maxWallMs: 90_000,
            maxCostUsd: 0.5,
            rolloverAfterImages: 15,
            ...opts.limits,
          },
          costSoFar: cost,
          artifacts: opts.artifacts,
        },
        hooks,
        { ...ctx, purpose: "cu_repair" },
      );
    } catch (err) {
      return { ok: false, rung, reason: `computer use failed: ${(err as Error).message}`, costUsd: cost() };
    }
    const costUsd = cost();
    if (commit) {
      if (!r.proposed)
        return { ok: false, rung, reason: r.message ?? `no control proposed (${r.outcome})`, costUsd };
      const target = r.proposed;
      return {
        ok: true,
        rung,
        steps: [{ id: step.id, intent: step.intent, op: "click", target, commit: true }],
        costUsd,
        trace: r.trace,
        note: `proposed '${displayName(target.fingerprint)}'`,
      };
    }
    if (r.outcome !== "done")
      return { ok: false, rung, reason: r.message ?? `computer use ended: ${r.outcome}`, costUsd };
    const compiled = compile(r.trace, {
      partial: true,
      name: req.skill.name,
      title: req.skill.title,
      params: req.skill.params,
      createdFrom: req.skill.createdFrom,
    });
    // The sub-trace starts where the page already is: its goto is not part of the fix.
    const steps = compiled.skill.steps.filter((s) => s.op !== "goto");
    if (steps.length === 0) return { ok: false, rung, reason: "the repair did nothing replayable", costUsd };
    if (steps.some(isCommitStep))
      return { ok: false, rung, reason: "the repair submitted the form", costUsd };
    const kept = asOptionPick(step, steps, req.params) ?? steps;
    const changed = keepsValues(step, kept);
    if (changed) return { ok: false, rung, reason: changed, costUsd };
    return {
      ok: true,
      rung,
      steps: kept,
      costUsd,
      trace: r.trace,
      note: kept.map((s) => s.intent).join("; "),
    };
  };
  return Object.assign(repair, { rung: "computer_use" as const }); // the rung, for the demo HUD
}

import type { Page } from "playwright";
import { z } from "zod";
import type { ArtifactRef, ErrorCode, Id } from "./base.ts";
import type { CuHooks, ParamValue, Trace, WriteGuardConfig } from "./browser.ts";
import { Target } from "./browser.ts";
import type { CallCtx } from "./models.ts";

export const ParamType = z.enum(["string", "number", "date", "enum", "email", "phone", "boolean", "file"]);
export type ParamType = z.infer<typeof ParamType>;

export const ParamSpec = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  type: ParamType,
  required: z.boolean(),
  description: z.string(),
  example: z.string().optional(),
  enumValues: z.array(z.string()).optional(),
});
export type ParamSpec = z.infer<typeof ParamSpec>;

/**
 * A compiled skill's param (additive): a ParamSpec plus the value used when a request gives none (the rep's
 * answer to an ask-the-rep question). Never part of a model-facing schema: SkillDraft keeps plain ParamSpec.
 */
export const SkillParamSpec = ParamSpec.extend({ default: z.string().optional() });
export type SkillParamSpec = z.infer<typeof SkillParamSpec>;

/**
 * Templates: "{{name}}", "{{name|date:DD/MM/YYYY}}", "{{name|number:pt-BR}}". Nothing else.
 * Every step carries a plain-language `intent` (used by repair) and a stable `id`.
 */
const stepBase = { id: z.string(), intent: z.string() };
export const Step = z.discriminatedUnion("op", [
  z.object({ ...stepBase, op: z.literal("goto"), url: z.string() }),
  z.object({ ...stepBase, op: z.literal("click"), target: Target, commit: z.literal(true).optional() }),
  z.object({ ...stepBase, op: z.literal("fill"), target: Target, value: z.string() }),
  // ARIA combobox: open the trigger, pick the option by accessible name (option is a template)
  z.object({ ...stepBase, op: z.literal("select"), trigger: Target, option: z.string() }),
  z.object({ ...stepBase, op: z.literal("check"), target: Target, checked: z.boolean() }),
  z.object({ ...stepBase, op: z.literal("upload"), target: Target, fileParam: z.string() }),
  z.object({
    ...stepBase,
    op: z.literal("press"),
    key: z.string(),
    target: Target.optional(),
    commit: z.literal(true).optional(),
  }),
  z.object({
    ...stepBase,
    op: z.literal("waitFor"),
    urlIncludes: z.string().optional(),
    text: z.string().optional(),
    target: Target.optional(),
    timeoutMs: z.number().optional(),
  }),
  z.object({ ...stepBase, op: z.literal("extract"), name: z.string(), regex: z.string() }),
]);
export type Step = z.infer<typeof Step>;

export const SkillSuccess = z.object({
  urlIncludes: z.string().optional(),
  textPattern: z.string().optional(),
  extract: z.array(z.object({ name: z.string(), regex: z.string() })),
});

export const Skill = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  version: z.number().int().positive(),
  parentVersion: z.number().int().positive().nullable(),
  title: z.string(),
  portalId: z.string(),
  params: z.array(SkillParamSpec),
  steps: z.array(Step),
  success: SkillSuccess,
  createdFrom: z.object({
    kind: z.enum(["video", "goal"]),
    draftId: z.string().optional(),
    traceRunId: z.string(),
  }),
  changelog: z.string(), // human-readable diff vs parent; '' for v1
});
export type Skill = z.infer<typeof Skill>;
export type SkillBody = Omit<Skill, "version" | "parentVersion">;

/** Teach output (model). Guides the first run; never trusted as ground truth. Steps reference params by name. */
export const SkillDraft = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  title: z.string(),
  portalId: z.string(),
  startUrl: z.string(),
  goal: z.string(),
  steps: z.array(z.string()),
  params: z.array(ParamSpec),
  commitStep: z.string(), // accessible name of the control that submits, e.g. "Submit registration"
  success: z.string(), // what the confirmation looks like
  observedValues: z.record(z.string(), z.string()).optional(), // values seen in the video: shown to the rep, never sent to the run
});
export type SkillDraft = z.infer<typeof SkillDraft>;

export interface CompileWarning {
  stepIdx: number;
  code: "AMBIGUOUS_PARAM" | "LITERAL_VALUE" | "NO_STABLE_SELECTOR" | "DROPPED_ACTION" | "ROUNDTRIP_MISMATCH";
  detail: string;
}

/** Heal ladder rungs, cheapest first. 'fallback' and 'similarity' are free and deterministic. */
export type HealRung = "fallback" | "similarity" | "open_weights" | "computer_use" | "ask_rep";

export type StepStatus = "ok" | "healed" | "repaired" | "asked" | "failed" | "skipped";

export interface StepResult {
  idx: number;
  stepId: string;
  status: StepStatus;
  rung?: HealRung;
  candidateIdx?: number;
  ms: number;
  errorCode?: ErrorCode;
  error?: string;
  screenshot?: ArtifactRef;
}

/** Pre-commit read-back: every filled/selected/checked value compared with what the skill meant to write. */
export interface Verification {
  checked: number;
  matched: number;
  mismatches: { stepId: string; label: string; expected: string; actual: string }[];
}

export interface RunResult {
  runId: Id;
  skill: { name: string; version: number };
  outcome: "success" | "dry_run_ok" | "failed" | "rejected" | "expired" | "unknown" | "needs_input";
  steps: StepResult[];
  verification?: Verification;
  extracted: Record<string, string>;
  finalScreenshot?: ArtifactRef;
  patched?: SkillBody; // present if any step healed, was repaired, or a param was added (ask_rep)
  ms: number;
  execCostUsd: number;
  errorCode?: ErrorCode;
  error?: string;
}

export interface RepairRequest {
  page: Page;
  runId: Id;
  skill: Skill;
  stepIdx: number;
  params: Record<string, ParamValue>;
  error: { code: ErrorCode; message: string };
}

export type RepairResult =
  | { ok: true; rung: HealRung; steps: Step[]; costUsd: number; trace?: Trace; note: string }
  | { ok: false; rung: HealRung; reason: string; costUsd: number };

/** One rung of the ladder. A ladder is just an ordered list of these (cheapest first). */
export type Repairer = (r: RepairRequest, hooks: CuHooks, ctx: CallCtx) => Promise<RepairResult>;

export interface RunHooks extends CuHooks {
  /** Rungs 2-3 in order (open weights, computer use). Empty = pure replay with free heals only. */
  repairers?: Repairer[];
  /**
   * Rung 4: the page demands information the skill has no param for (e.g. a new required field).
   * Return the rep's answer, or null to stop safely.
   */
  askRep?(q: { label: string; options?: string[]; screenshot: ArtifactRef }): Promise<string | null>;
  onStep?(s: StepResult): void;
}

export interface RunOptions {
  runId: Id;
  stepTimeoutMs: number;
  screenshots: "all" | "fail_only" | "final_only";
  allowFallbackHeal: boolean;
  /** Canary mode: stop right before the first commit step; outcome 'dry_run_ok' when everything up to it resolved and read back. */
  dryRun?: boolean;
  writeGuard?: WriteGuardConfig;
}

export interface SkillStore {
  active(name: string): Skill | undefined;
  get(name: string, version: number): Skill | undefined;
  list(): { name: string; title: string; activeVersion: number; versions: number }[];
  /** One transaction: insert version, deactivate the old active row, activate the new one when asked. */
  saveVersion(
    s: SkillBody,
    parentVersion: number | null,
    activate: boolean,
    source: "compile" | "heal" | "repair" | "ask_rep",
    sourceRunId?: Id,
  ): Skill;
  activate(name: string, version: number): void; // rollback
  /** `videoArtifactId`: the teach recording the draft came from (shown by the flight recorder). */
  saveDraft(d: SkillDraft, jobId: Id, videoArtifactId?: Id): Id;
  getDraft(id: Id): SkillDraft | undefined;
  /** Draft for a portal that has not compiled yet, if any. */
  draftForPortal(portalId: string): { id: Id; draft: SkillDraft } | undefined;
}

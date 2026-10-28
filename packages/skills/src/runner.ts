// Deterministic replay of a compiled skill: zero model calls on the happy path. Free heals (another stored
// candidate, fingerprint similarity) are promoted into `patched`; steps that cannot be found go to the
// repairers in order; a read-back of every written value gates each commit; commits always ask for approval;
// a commit whose outcome cannot be confirmed is "unknown" and is never clicked again. Validation errors on a
// field no step fills are asked of the rep once; validation errors on fields we filled are data errors.

import {
  describeLocator,
  type Hud,
  hudOf,
  installWriteGuard,
  readFieldValue,
  resolveTarget,
  type WriteGuard,
} from "@dockhand/browser";
import {
  type ArtifactRef,
  type ArtifactStore,
  DockhandError,
  type ErrorCode,
  type HealRung,
  type ParamSpec,
  type ParamValue,
  type RepairResult,
  type RunHooks,
  type RunOptions,
  type RunResult,
  type Skill,
  type SkillBody,
  type Step,
  type StepResult,
  type StepStatus,
  type Target,
  type Verification,
} from "@dockhand/core";
import type { Locator, Page } from "playwright";
import { slotParamName } from "./compile.ts";
import { diffSkills, type StepNote } from "./diff.ts";
import {
  alertTexts,
  bodyText,
  claimElement,
  emptyRequiredFields,
  harvestOptions,
  invalidFields,
  issueCount,
  sameElement,
  selectOption,
  waitForOutcome,
} from "./page-actions.ts";
import {
  displayName,
  interactionClass,
  isCommitStep,
  mergeCandidates,
  nextStepId,
  optionPickTarget,
  stepTarget,
  targetParams,
  withStepTarget,
} from "./targets.ts";
import {
  hasTemplate,
  isFileValue,
  normalizeText,
  renderRegexTemplate,
  renderTemplate,
  renderUrlTemplate,
  templateParams,
  valuesEquivalent,
} from "./template.ts";

export interface RunEnv {
  /** Stores screenshots: approval cards, ask-rep questions, failures and the final page. */
  artifacts: ArtifactStore;
  /** Deadline for the post-commit success check. Default 15 s. */
  successTimeoutMs?: number;
}

export type RunSkillOptions = RunOptions & RunEnv;

const DEFAULT_SUCCESS_TIMEOUT_MS = 15_000;
/** Navigations (goto, waits for a new screen) get at least this long. */
const NAV_TIMEOUT_FLOOR_MS = 8_000;
const REPAIR_TIMEOUT_MS = 120_000;
/** At most this many questions to the rep per run. */
const MAX_ASKS = 3;

type Flow = { next: number } | { stop: true };

interface StepOutcome {
  status: StepStatus;
  rung?: HealRung;
  candidateIdx?: number;
  errorCode?: ErrorCode;
  error?: string;
}

type CommitStep = Extract<Step, { op: "click" | "press" }>;

type Resolved =
  | { ok: true; locator: Locator; outcome: StepOutcome }
  | { ok: false; code: ErrorCode; detail: string };

interface Written {
  locator: Locator;
  label: string;
  intended: string;
  /** Read right after writing; used when the field is no longer on the page at read-back. */
  observed: string | undefined;
  /** What the read-back shows once verified (the option a radio pick chose, instead of "true"). */
  display?: string;
}

function toBool(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  const s = v.trim().toLowerCase();
  if (s === "true" || s === "on" || s === "checked" || s === "1") return true;
  if (s === "false" || s === "off" || s === "unchecked" || s === "0" || s === "") return false;
  return undefined;
}

function errorCodeOf(err: unknown, fallback: ErrorCode): ErrorCode {
  return err instanceof DockhandError ? err.code : fallback;
}

function messageOf(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.split("\n")[0]?.slice(0, 500) ?? m;
}

function stepStrings(step: Step): string[] {
  switch (step.op) {
    case "goto":
      return [step.url];
    case "fill":
      return [step.value];
    case "select":
      return [step.option];
    case "upload":
      return [`{{${step.fileParam}}}`];
    case "waitFor":
      return [step.urlIncludes ?? "", step.text ?? ""];
    case "check":
    case "click":
      return targetParams(step.target).map((n) => `{{${n}}}`);
    default:
      return [];
  }
}

function isWriteStep(step: Step): boolean {
  return step.op === "fill" || step.op === "select" || step.op === "check" || step.op === "upload";
}

/** Replays `skill` on `page` with `params`. Never throws for run failures; they are in the result. */
export async function runSkill(
  page: Page,
  skill: Skill,
  params: Record<string, ParamValue>,
  hooks: RunHooks,
  opts: RunSkillOptions,
): Promise<RunResult> {
  return new SkillRun(page, skill, params, hooks, opts).run();
}

class SkillRun {
  private steps: Step[];
  private readonly params: ParamSpec[];
  private readonly values: Record<string, ParamValue>;
  private readonly results: StepResult[] = [];
  private readonly notes: StepNote[] = [];
  private readonly extracted: Record<string, string> = {};
  private readonly written = new Map<string, Written>();
  /** Steps added or replaced during this run (repair, ask-rep): their status and rung. */
  private readonly origin = new Map<string, { status: StepStatus; rung: HealRung }>();
  /** Replacement clicks a computer-use repair already performed in the browser. */
  private readonly preDone = new Set<string>();
  /** Failing steps already retried after asking the rep. */
  private readonly retried = new Set<string>();
  /** Time spent on bounced attempts, added to the step's final result. */
  private readonly carriedMs = new Map<string, number>();
  private readonly blockedWrites: { method: string; url: string }[] = [];
  private readonly started = performance.now();
  private changed = false;
  private cost = 0;
  private asks = 0;
  private commitWindow = false;
  private lastClick: { idx: number; baseline: number } | null = null;
  private readback: { label: string; value: string }[] = [];
  private verification: Verification | undefined;
  private guard: WriteGuard | undefined;
  private outcome: RunResult["outcome"] | undefined;
  private errorCode: ErrorCode | undefined;
  private error: string | undefined;
  private finalScreenshot: ArtifactRef | undefined;
  /** Demo overlay (DEMO_MODE only): draws the run for the camera; undefined otherwise. */
  private readonly hud: Hud | undefined;
  private readonly hooks: RunHooks;
  /** Time spent waiting for the rep (approvals, answers): not machine time, left out of every reported ms. */
  private readonly waits: { start: number; end: number }[] = [];

  constructor(
    private readonly page: Page,
    private readonly skill: Skill,
    values: Record<string, ParamValue>,
    hooks: RunHooks,
    private readonly opts: RunSkillOptions,
  ) {
    this.hud = hudOf(page);
    const timed = this.timed(hooks);
    this.hooks = this.hud?.wrapRunHooks(timed) ?? timed;
    this.steps = [...skill.steps];
    this.params = skill.params.map((p) => ({ ...p }));
    this.values = { ...values };
  }

  async run(): Promise<RunResult> {
    this.hud?.runStart({ skill: this.skill, dryRun: this.opts.dryRun === true });
    try {
      if (this.opts.writeGuard) {
        this.guard = await installWriteGuard(this.page, this.opts.writeGuard, async (req) => {
          if (this.commitWindow) {
            this.commitWindow = false;
            return "allow";
          }
          this.blockedWrites.push(req);
          return "block";
        });
      }
      let idx = 0;
      while (idx < this.steps.length) {
        const flow = await this.runStep(idx);
        if ("stop" in flow) break;
        idx = flow.next;
      }
      if (this.outcome === undefined) await this.finishWithoutCommit();
    } catch (err) {
      this.outcome = "failed";
      this.errorCode = errorCodeOf(err, "TOOL_ERROR");
      this.error = `runner error: ${messageOf(err)}`;
    } finally {
      await this.guard?.dispose().catch(() => {});
    }
    await this.captureFinal();
    await this.hud?.end({
      outcome: this.outcome ?? "failed",
      extracted: this.extracted,
      ...(this.error ? { error: this.error } : {}),
      ...(this.errorCode ? { errorCode: this.errorCode } : {}),
    });
    return this.result();
  }

  /** Machine milliseconds since `t0`: without waits for the rep and without demo HUD pacing. */
  private since(t0: number): number {
    let waited = 0;
    for (const w of this.waits) if (w.end > t0) waited += w.end - Math.max(w.start, t0);
    return performance.now() - t0 - waited - (this.hud?.pausedSince(t0) ?? 0);
  }

  /** The hooks that wait for a person, timed into `waits` (repairers get them too, so nested waits count). */
  private timed(h: RunHooks): RunHooks {
    const wait = async <T>(ask: () => Promise<T>): Promise<T> => {
      const start = performance.now();
      try {
        return await ask();
      } finally {
        this.waits.push({ start, end: performance.now() });
      }
    };
    const askRep = h.askRep;
    return {
      ...h,
      approveCommit: (r) => wait(() => h.approveCommit(r)),
      approveSafety: (r) => wait(() => h.approveSafety(r)),
      ...(askRep ? { askRep: (q: Parameters<typeof askRep>[0]) => wait(() => askRep(q)) } : {}),
    };
  }

  // ---------- steps ----------

  private async runStep(idx: number): Promise<Flow> {
    const step = this.steps[idx] as Step;
    const started = performance.now();
    this.hud?.step(idx, this.steps);
    const missing = this.missingParams(step);
    if (missing.required.length > 0) {
      return this.stop(
        idx,
        step,
        started,
        "needs_input",
        "NEEDS_INPUT",
        `missing param ${missing.required.join(", ")}`,
      );
    }
    if (missing.optional.length > 0) {
      await this.record(idx, step, started, { status: "skipped" });
      return { next: idx + 1 };
    }
    if (isCommitStep(step)) return this.runCommit(idx, step, started);
    if (this.preDone.has(step.id)) {
      await this.record(idx, step, started, { status: "ok" });
      return { next: idx + 1 };
    }
    const writesBefore = this.blockedWrites.length;
    try {
      let outcome: StepOutcome = { status: "ok" };
      if (step.op === "goto") await this.goto(step.url);
      else if (step.op === "waitFor") {
        const bounced = await this.waitFor(idx, step, started);
        if (bounced) return bounced;
      } else if (step.op === "extract") this.extractInto(step.name, step.regex, await bodyText(this.page));
      else if (step.op === "press" && !step.target) await this.page.keyboard.press(step.key);
      else {
        const res = await this.resolve(idx, step);
        if (!res.ok) return this.repair(idx, step, started, res);
        const resolved = this.steps[idx] as Step;
        await this.hud?.before(idx, resolved, res.locator, res.outcome, started);
        const bounced = await this.act(idx, resolved, res.locator, started);
        await this.hud?.after(idx, resolved, res.locator);
        if (bounced) return bounced;
        outcome = res.outcome;
      }
      if (this.blockedWrites.length > writesBefore) {
        const w = this.blockedWrites[writesBefore];
        return this.stop(
          idx,
          step,
          started,
          "failed",
          "WRITE_BLOCKED",
          `blocked ${w?.method} ${w?.url} outside a commit`,
        );
      }
      await this.record(idx, step, started, outcome);
      return { next: idx + 1 };
    } catch (err) {
      return this.stop(idx, step, started, "failed", errorCodeOf(err, "STEP_TIMEOUT"), messageOf(err));
    }
  }

  private async goto(template: string): Promise<void> {
    let url = renderUrlTemplate(template, this.values);
    if (url.startsWith("/")) {
      const current = this.page.url();
      if (/^https?:/i.test(current)) url = new URL(url, current).href;
    }
    await this.page.goto(url, {
      waitUntil: "load",
      timeout: Math.max(this.opts.stepTimeoutMs, NAV_TIMEOUT_FLOOR_MS),
    });
  }

  private async waitFor(
    idx: number,
    step: Extract<Step, { op: "waitFor" }>,
    started: number,
  ): Promise<Flow | null> {
    const timeout = step.timeoutMs ?? Math.max(this.opts.stepTimeoutMs, NAV_TIMEOUT_FLOOR_MS);
    try {
      if (step.urlIncludes) {
        const want = renderUrlTemplate(step.urlIncludes, this.values);
        await this.page.waitForURL((u) => u.href.includes(want), { timeout, waitUntil: "commit" });
      }
      if (step.text) {
        await this.page
          .getByText(renderTemplate(step.text, this.values))
          .first()
          .waitFor({ state: "visible", timeout });
      }
      if (step.target) {
        const r = await resolveTarget(this.page, this.renderTarget(step.target), {
          timeoutMs: timeout,
          allowSimilarity: false,
        });
        if (!r.ok) throw new DockhandError("STEP_TIMEOUT", r.detail);
      }
      return null;
    } catch (err) {
      // The click before this wait may have bounced on validation (a "Next" the page refused).
      const click = this.lastClick;
      if (click && click.idx === idx - 1 && (await issueCount(this.page)) > click.baseline) {
        return this.onValidation(click.idx, this.steps[click.idx] as Step, started);
      }
      throw new DockhandError("STEP_TIMEOUT", `waited ${timeout} ms: ${messageOf(err)}`);
    }
  }

  /** Performs a resolved step. Returns a flow when the step bounced on validation. */
  private async act(idx: number, step: Step, locator: Locator, started: number): Promise<Flow | null> {
    const timeout = this.opts.stepTimeoutMs;
    switch (step.op) {
      case "click": {
        const baseline = await issueCount(this.page);
        await locator.click({ timeout });
        if ((await issueCount(this.page)) > baseline) return this.onValidation(idx, step, started);
        this.lastClick = { idx, baseline };
        return null;
      }
      case "fill": {
        const value = renderTemplate(step.value, this.values);
        await locator.fill(value, { timeout });
        await this.typeIfRejected(locator, value, timeout);
        await this.remember(step, locator, value);
        return null;
      }
      case "select": {
        const option = renderTemplate(step.option, this.values);
        await selectOption(this.page, locator, option, timeout);
        await this.remember(step, locator, option);
        return null;
      }
      case "check":
        await locator.setChecked(step.checked, { timeout });
        await this.remember(step, locator, String(step.checked));
        return null;
      case "upload": {
        const value = this.values[step.fileParam];
        if (value === undefined || !isFileValue(value)) {
          throw new DockhandError("NEEDS_INPUT", `param ${step.fileParam} must be a file`);
        }
        const bytes = await this.opts.artifacts.read(value.file);
        await locator.setInputFiles(
          { name: value.filename, mimeType: value.file.mime, buffer: Buffer.from(bytes) },
          { timeout },
        );
        return null;
      }
      case "press":
        await locator.press(step.key, { timeout });
        return null;
      default:
        return null;
    }
  }

  /**
   * Some apps keep their own model of a field and only take keystrokes: EspoCRM's number inputs show a filled
   * value but drop it on blur, and the record is saved without it. After a fill, blur and read the field back;
   * if the value did not stick, clear it and type it key by key, once. Read-back still has the last word.
   */
  private async typeIfRejected(locator: Locator, value: string, timeout: number): Promise<void> {
    if (value === "") return;
    await locator.blur({ timeout }).catch(() => undefined);
    const after = await readFieldValue(locator).catch(() => undefined);
    if (after === undefined || valuesEquivalent(value, after)) return;
    await locator.fill("", { timeout });
    await locator.pressSequentially(value, { timeout });
    await locator.blur({ timeout }).catch(() => undefined);
  }

  private async remember(step: Step, locator: Locator, intended: string): Promise<void> {
    const target = stepTarget(step);
    const observed = await readFieldValue(locator).catch(() => undefined);
    const picked =
      step.op === "check" && targetParams(target).length > 0 ? target?.fingerprint.name : undefined;
    this.written.set(step.id, {
      locator,
      label: displayName(target?.fingerprint),
      intended,
      observed,
      ...(picked ? { display: renderTemplate(picked, this.values) } : {}),
    });
  }

  // ---------- resolution, free heals, repair ----------

  private renderTarget(t: Target): Target {
    if (!hasTemplate(JSON.stringify(t))) return t;
    const r = (s: string) => renderTemplate(s, this.values);
    const fp = t.fingerprint;
    return {
      candidates: t.candidates.map((c) =>
        c.by === "role" ? { ...c, name: r(c.name) } : c.by === "css" ? c : { ...c, value: r(c.value) },
      ),
      fingerprint: {
        ...fp,
        ...(fp.name ? { name: r(fp.name) } : {}),
        ...(fp.label ? { label: r(fp.label) } : {}),
      },
    };
  }

  private async resolve(idx: number, step: Step): Promise<Resolved> {
    const original = stepTarget(step) as Target;
    const r = await resolveTarget(this.page, this.renderTarget(original), {
      timeoutMs: this.opts.stepTimeoutMs,
      allowSimilarity: this.opts.allowFallbackHeal,
    });
    if (!r.ok) return r;
    if (isWriteStep(step)) {
      const prev = await claimElement(r.locator, step.id).catch(() => null);
      if (prev)
        return {
          ok: false,
          code: "STEP_AMBIGUOUS",
          detail: `the element was already written by step ${prev}`,
        };
    }
    const idxUsed = r.candidateIdx ?? undefined;
    const healed = r.via === "similarity" || (r.candidateIdx ?? 0) > 0;
    if (!healed)
      return {
        ok: true,
        locator: r.locator,
        outcome: { status: "ok", ...(idxUsed !== undefined ? { candidateIdx: idxUsed } : {}) },
      };
    const rung: HealRung = r.via === "similarity" ? "similarity" : "fallback";
    const fresh = await describeLocator(r.locator).catch(() => null);
    this.steps[idx] = withStepTarget(step, {
      candidates: mergeCandidates(fresh?.candidates ?? [], original.candidates),
      fingerprint: fresh?.fingerprint ?? r.descriptor,
    });
    this.changed = true;
    this.notes.push({ stepId: step.id, rung });
    return {
      ok: true,
      locator: r.locator,
      outcome: { status: "healed", rung, ...(idxUsed !== undefined ? { candidateIdx: idxUsed } : {}) },
    };
  }

  private current(): Skill {
    return { ...this.skill, params: this.params, steps: this.steps };
  }

  private async repair(
    idx: number,
    step: Step,
    started: number,
    failure: { code: ErrorCode; detail: string },
  ): Promise<Flow> {
    const reasons: string[] = [];
    if (this.origin.get(step.id)?.status === "repaired") {
      return this.stop(
        idx,
        step,
        started,
        "failed",
        failure.code,
        `${failure.detail}; a repaired step is not repaired twice`,
      );
    }
    // Free: a dropdown that became radio buttons (the option named like the value), before any paid rung.
    const swapped = await this.widgetSwap(step);
    if (swapped) {
      this.steps[idx] = swapped;
      this.changed = true;
      this.origin.set(step.id, { status: "healed", rung: "similarity" });
      this.notes.push({ stepId: step.id, rung: "similarity" });
      return { next: idx };
    }
    for (const repairer of this.hooks.repairers ?? []) {
      let res: RepairResult;
      try {
        res = await repairer(
          {
            page: this.page,
            runId: this.opts.runId,
            skill: this.current(),
            stepIdx: idx,
            params: { ...this.values },
            error: { code: failure.code, message: failure.detail },
          },
          this.hooks,
          { purpose: "heal_match", runId: this.opts.runId, stepIdx: idx, timeoutMs: REPAIR_TIMEOUT_MS },
        );
      } catch (err) {
        reasons.push(`repairer error: ${messageOf(err)}`);
        continue;
      }
      this.cost += res.costUsd;
      if (!res.ok) {
        reasons.push(`${res.rung}: ${res.reason}`);
        continue;
      }
      const replacement = this.adopt(step, res.steps);
      // A commit must stay behind the approval gate, and nothing else may become a commit.
      if (replacement.length === 0 || isCommitStep(step) !== replacement.some(isCommitStep)) {
        reasons.push(
          `${res.rung}: replacement ${replacement.length === 0 ? "is empty" : "changes which step submits"}`,
        );
        continue;
      }
      this.steps.splice(idx, 1, ...replacement);
      this.changed = true;
      for (const s of replacement) {
        this.origin.set(s.id, { status: "repaired", rung: res.rung });
        this.notes.push({ stepId: s.id, rung: res.rung });
        if (res.trace && !isCommitStep(s) && (s.op === "click" || s.op === "press")) this.preDone.add(s.id);
      }
      const first = replacement[0] as Step;
      this.carriedMs.set(first.id, (this.carriedMs.get(first.id) ?? 0) + this.since(started));
      return { next: idx };
    }
    return this.stop(idx, step, started, "failed", failure.code, [failure.detail, ...reasons].join("; "));
  }

  /**
   * Widget swap: the dropdown (or field) a step wrote is gone, and exactly one radio button is named like the
   * value it writes. The step becomes "check the option named {{param}}" in that group, which holds for any
   * value; the group must carry the old label, or the old label must be gone from the page. Read-back verifies
   * the pick before any submit.
   */
  private async widgetSwap(step: Step): Promise<Step | null> {
    if (step.op !== "select" && step.op !== "fill") return null;
    const template = step.op === "select" ? step.option : step.value;
    const [param, ...more] = templateParams(template);
    if (!param || more.length > 0 || template.trim() !== `{{${param}}}`) return null;
    let value: string;
    try {
      value = renderTemplate(template, this.values);
    } catch {
      return null;
    }
    if (!value.trim()) return null;
    const radio = this.page.getByRole("radio", { name: value, exact: true });
    if ((await radio.count().catch(() => 0)) !== 1) return null;
    const oldLabel = displayName(stepTarget(step)?.fingerprint);
    const group = await radio
      .evaluate((el) => {
        const g = el.closest('[role="radiogroup"], fieldset');
        if (!g) return null;
        const by = g.getAttribute("aria-labelledby");
        const raw = by
          ? by
              .split(/s+/)
              .map((id) => document.getElementById(id)?.textContent ?? "")
              .join(" ")
          : (g.getAttribute("aria-label") ?? g.querySelector("legend")?.textContent ?? "");
        return raw
          .replace(/s+/g, " ")
          .replace(/[s*:]+$/, "")
          .trim();
      })
      .catch(() => null);
    if (!group || normalizeText(group) !== normalizeText(oldLabel)) {
      const oldStillThere = await this.page
        .getByText(oldLabel, { exact: true })
        .count()
        .catch(() => 1);
      if (oldStillThere > 0) return null;
    }
    const fresh = await describeLocator(radio).catch(() => null);
    if (!fresh) return null;
    return {
      id: step.id,
      intent: step.intent,
      op: "check",
      target: optionPickTarget(fresh, param, group ?? oldLabel),
      checked: true,
    };
  }

  /** Replacement steps keep the failing step's id and intent first; extra steps get fresh ids. */
  private adopt(step: Step, steps: Step[]): Step[] {
    const out: Step[] = [];
    const taken = [...this.steps];
    steps.forEach((s, i) => {
      if (i === 0) out.push({ ...s, id: step.id, intent: step.intent } as Step);
      else {
        const id = nextStepId([...taken, ...out]);
        out.push({ ...s, id, intent: s.intent || step.intent } as Step);
      }
    });
    return out;
  }

  // ---------- commit ----------

  private isLastCommit(idx: number): boolean {
    return !this.steps.slice(idx + 1).some(isCommitStep);
  }

  private async runCommit(idx: number, step: CommitStep, started: number): Promise<Flow> {
    // A required field nothing in the skill fills (the portal added one): ask the rep before the approval card,
    // so the rep approves one complete form instead of a submit the portal would refuse.
    if (!this.retried.has(step.id)) {
      const empty = await this.notOurs(await emptyRequiredFields(this.page));
      if (empty.length > 0) {
        return this.askFor(empty, idx, step, started, "a required field is empty", "NEEDS_INPUT");
      }
    }
    const v = await this.readBack();
    this.verification = v;
    if (v.mismatches.length > 0) {
      const detail = v.mismatches
        .map((m) => `${m.label}: expected "${m.expected}", found "${m.actual}"`)
        .join("; ");
      return this.stop(idx, step, started, "failed", "READBACK_MISMATCH", detail);
    }
    if (this.opts.dryRun) {
      this.outcome = "dry_run_ok";
      return { stop: true };
    }

    let locator: Locator | null = null;
    let outcome: StepOutcome = { status: "ok" };
    if (step.op === "click" || step.target) {
      const res = await this.resolve(idx, step);
      if (!res.ok) return this.repair(idx, step, started, res);
      locator = res.locator;
      outcome = res.outcome;
    }
    const current = this.steps[idx] as CommitStep;

    const screenshot = await this.screenshot();
    if (!screenshot)
      return this.stop(
        idx,
        current,
        started,
        "failed",
        "TOOL_ERROR",
        "could not capture the approval screenshot",
      );
    const box = locator ? await locator.boundingBox().catch(() => null) : null;
    const decision = await this.hooks.approveCommit({
      summary: `${this.skill.title}: ${current.intent}`,
      screenshot,
      ...(box ? { highlight: { x: box.x, y: box.y, w: box.width, h: box.height } } : {}),
      readback: this.readback,
    });
    if (decision !== "approved") {
      const expired = decision === "expired";
      return this.stop(
        idx,
        current,
        started,
        expired ? "expired" : "rejected",
        expired ? "APPROVAL_EXPIRED" : "APPROVAL_REJECTED",
        decision === "edit" ? "the rep asked to edit before submitting" : `approval ${decision}`,
      );
    }

    const baseline = await issueCount(this.page);
    this.commitWindow = true;
    try {
      if (current.op === "press") {
        if (locator) await locator.press(current.key, { timeout: this.opts.stepTimeoutMs });
        else await this.page.keyboard.press(current.key);
      } else {
        await (locator as Locator).click({ timeout: this.opts.stepTimeoutMs });
      }
    } catch (err) {
      this.commitWindow = false;
      return this.stop(
        idx,
        current,
        started,
        "unknown",
        "UNKNOWN_OUTCOME",
        `the submit click did not complete: ${messageOf(err)}`,
      );
    }
    const last = this.isLastCommit(idx);
    const s = this.skill.success;
    const result = await waitForOutcome(
      this.page,
      {
        urlIncludes: last && s.urlIncludes ? renderUrlTemplate(s.urlIncludes, this.values) : null,
        textPattern: last && s.textPattern ? renderRegexTemplate(s.textPattern, this.values) : null,
        baseline,
      },
      this.opts.successTimeoutMs ?? DEFAULT_SUCCESS_TIMEOUT_MS,
    );
    this.commitWindow = false;
    if (result === "validation") return this.onValidation(idx, current, started);
    if (result === "timeout" && last) {
      const ms = this.opts.successTimeoutMs ?? DEFAULT_SUCCESS_TIMEOUT_MS;
      const why =
        s.urlIncludes || s.textPattern ? `no confirmation within ${ms} ms` : "the skill has no success check";
      return this.stop(idx, current, started, "unknown", "UNKNOWN_OUTCOME", `${why}; not submitting again`);
    }
    if (last) {
      const text = await bodyText(this.page);
      for (const e of s.extract) this.extractInto(e.name, e.regex, text, false);
      this.outcome = "success";
    }
    await this.record(idx, current, started, outcome);
    return { next: idx + 1 };
  }

  private async readBack(): Promise<Verification> {
    const mismatches: Verification["mismatches"] = [];
    const list: { label: string; value: string }[] = [];
    const shown: Parameters<Hud["verify"]>[0] = [];
    let checked = 0;
    let matched = 0;
    for (const step of this.steps) {
      const w = this.written.get(step.id);
      if (!w) continue;
      let actual: string | undefined;
      if ((await w.locator.count().catch(() => 0)) === 1) {
        actual = await readFieldValue(w.locator).catch(() => undefined);
      }
      actual ??= w.observed;
      checked++;
      const ok =
        actual !== undefined &&
        (step.op === "check" ? toBool(actual) === toBool(w.intended) : valuesEquivalent(w.intended, actual));
      if (ok) matched++;
      else mismatches.push({ stepId: step.id, label: w.label, expected: w.intended, actual: actual ?? "" });
      list.push({ label: w.label, value: ok && w.display ? w.display : (actual ?? "") });
      shown.push({
        stepId: step.id,
        locator: w.locator,
        ok,
        label: w.label,
        expected: w.intended,
        actual: actual ?? "",
      });
    }
    this.readback = list;
    await this.keepReadBack(shown, checked, matched);
    await this.hud?.verify(shown);
    return { checked, matched, mismatches };
  }

  /** Every read-back is kept as a run artifact (dry runs and canaries too), for the flight recorder. */
  private async keepReadBack(
    rows: { stepId: string; label: string; expected: string; actual: string; ok: boolean }[],
    checked: number,
    matched: number,
  ): Promise<void> {
    const doc = {
      runId: this.opts.runId,
      skill: { name: this.skill.name, version: this.skill.version },
      dryRun: this.opts.dryRun === true,
      at: Date.now(),
      checked,
      matched,
      rows: rows.map(({ stepId, label, expected, actual, ok }) => ({ stepId, label, expected, actual, ok })),
    };
    await this.opts.artifacts
      .put(new TextEncoder().encode(JSON.stringify(doc)), "application/json", {
        kind: "readback",
        runId: this.opts.runId,
      })
      .catch(() => undefined);
  }

  // ---------- validation and ask-rep ----------

  private async isOurs(field: Locator): Promise<boolean> {
    for (const w of this.written.values()) if (await sameElement(field, w.locator)) return true;
    return false;
  }

  private async notOurs(fields: Locator[]): Promise<Locator[]> {
    const out: Locator[] = [];
    for (const f of fields) if (!(await this.isOurs(f))) out.push(f);
    return out;
  }

  /** The page refused the step that was just performed (`step` at `idx`). */
  private async onValidation(idx: number, step: Step, started: number): Promise<Flow> {
    const fields = await invalidFields(this.page);
    const alerts = await alertTexts(this.page);
    const message = alerts.join(" | ") || "the page reported a validation error";
    const unknown = await this.notOurs(fields);
    const ours = fields.length - unknown.length;
    // Bad data is never repaired: a field we filled is invalid, or the error names no field.
    if (ours > 0 || unknown.length === 0) {
      return this.stop(idx, step, started, "failed", "PORTAL_VALIDATION", message);
    }
    return this.askFor(unknown, idx, step, started, message, "PORTAL_VALIDATION");
  }

  /**
   * Fields the skill has no value for: ask the rep once per field, add a param for each answer, insert the
   * steps before `step` and run from there. Never guesses: no answer stops the run safely.
   */
  private async askFor(
    unknown: Locator[],
    idx: number,
    step: Step,
    started: number,
    message: string,
    code: ErrorCode,
  ): Promise<Flow> {
    if (this.retried.has(step.id) || this.asks + unknown.length > MAX_ASKS) {
      return this.stop(idx, step, started, "failed", code, `still refused after asking the rep: ${message}`);
    }
    const inserted: Step[] = [];
    for (const field of unknown) {
      const target = await describeLocator(field);
      const label = displayName(target.fingerprint);
      const options = await harvestOptions(this.page, field, this.opts.stepTimeoutMs);
      const screenshot = await this.screenshot();
      if (!screenshot)
        return this.stop(
          idx,
          step,
          started,
          "failed",
          "TOOL_ERROR",
          "could not capture the question screenshot",
        );
      this.asks++;
      const answer = this.hooks.askRep
        ? await this.hooks.askRep({ label, ...(options ? { options } : {}), screenshot })
        : null;
      if (answer === null || answer === undefined) {
        return this.stop(
          idx,
          step,
          started,
          "needs_input",
          "NEEDS_INPUT",
          `the page now requires '${label}'`,
        );
      }
      const id = nextStepId([...this.steps, ...inserted]);
      const cls = interactionClass(target.fingerprint);
      let added: Step;
      if (cls === "check") {
        added = { id, op: "check", intent: `Check '${label}'`, target, checked: toBool(answer) ?? true };
      } else {
        const name = this.freshParamName(label);
        this.params.push({
          name,
          type: options ? "enum" : "string",
          required: true,
          description: label,
          ...(options ? { enumValues: options } : {}),
        });
        this.values[name] = answer;
        added =
          cls === "select"
            ? { id, op: "select", intent: `Select '${label}'`, trigger: target, option: `{{${name}}}` }
            : { id, op: "fill", intent: `Fill '${label}'`, target, value: `{{${name}}}` };
      }
      inserted.push(added);
      this.origin.set(id, { status: "asked", rung: "ask_rep" });
      this.notes.push({ stepId: id, rung: "ask_rep" });
    }
    this.steps.splice(idx, 0, ...inserted);
    this.changed = true;
    this.retried.add(step.id);
    this.carriedMs.set(step.id, (this.carriedMs.get(step.id) ?? 0) + this.since(started));
    return { next: idx };
  }

  private freshParamName(label: string): string {
    const base = slotParamName(label);
    const taken = new Set(this.params.map((p) => p.name));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
  }

  // ---------- params, extraction, results ----------

  private missingParams(step: Step): { required: string[]; optional: string[] } {
    const required: string[] = [];
    const optional: string[] = [];
    for (const t of stepStrings(step)) {
      for (const name of templateParams(t)) {
        const v = this.values[name];
        if (v !== undefined && v !== null && !(step.op === "select" && v === "")) continue;
        const spec = this.params.find((p) => p.name === name);
        (spec && !spec.required ? optional : required).push(name);
      }
    }
    return { required, optional };
  }

  private extractInto(name: string, regex: string, text: string, strict = true): void {
    const re = new RegExp(regex);
    const m = re.exec(text) ?? re.exec(this.page.url());
    if (!m) {
      if (strict)
        throw new DockhandError("ASSERT_FAILED", `nothing on the page matches /${regex}/ for ${name}`);
      return;
    }
    this.extracted[name] = m[1] ?? m[0];
  }

  private async finishWithoutCommit(): Promise<void> {
    const v = await this.readBack();
    if (v.checked > 0) this.verification = v;
    if (v.mismatches.length > 0) {
      this.outcome = "failed";
      this.errorCode = "READBACK_MISMATCH";
      this.error = v.mismatches
        .map((m) => `${m.label}: expected "${m.expected}", found "${m.actual}"`)
        .join("; ");
      return;
    }
    if (this.opts.dryRun) {
      this.outcome = "dry_run_ok";
      return;
    }
    const s = this.skill.success;
    if (s.urlIncludes || s.textPattern) {
      const r = await waitForOutcome(
        this.page,
        {
          urlIncludes: s.urlIncludes ? renderUrlTemplate(s.urlIncludes, this.values) : null,
          textPattern: s.textPattern ? renderRegexTemplate(s.textPattern, this.values) : null,
          baseline: Number.POSITIVE_INFINITY,
        },
        this.opts.successTimeoutMs ?? DEFAULT_SUCCESS_TIMEOUT_MS,
      );
      if (r !== "success") {
        this.outcome = "failed";
        this.errorCode = "ASSERT_FAILED";
        this.error = "the success check did not hold";
        return;
      }
      const text = await bodyText(this.page);
      for (const e of s.extract) this.extractInto(e.name, e.regex, text, false);
    }
    this.outcome = "success";
  }

  private async screenshot(): Promise<ArtifactRef | undefined> {
    try {
      const png = await this.page.screenshot({
        type: "png",
        scale: "css",
        animations: "disabled",
        timeout: 5000,
      });
      return await this.opts.artifacts.put(new Uint8Array(png), "image/png", {
        kind: "screenshot",
        runId: this.opts.runId,
      });
    } catch {
      return undefined;
    }
  }

  private async record(idx: number, step: Step, started: number, base: StepOutcome): Promise<void> {
    const origin = this.origin.get(step.id);
    const failed = base.status === "failed";
    const status: StepStatus =
      failed || base.status === "skipped" ? base.status : (origin?.status ?? base.status);
    const rung = origin?.rung ?? base.rung;
    const r: StepResult = {
      idx,
      stepId: step.id,
      status,
      ...(rung ? { rung } : {}),
      ...(base.candidateIdx !== undefined ? { candidateIdx: base.candidateIdx } : {}),
      ms: Math.round(this.since(started) + (this.carriedMs.get(step.id) ?? 0)),
      ...(base.errorCode ? { errorCode: base.errorCode } : {}),
      ...(base.error ? { error: base.error } : {}),
    };
    const policy = this.opts.screenshots;
    if (policy === "all" || (failed && policy === "fail_only")) {
      const shot = await this.screenshot();
      if (shot) {
        r.screenshot = shot;
        if (failed) this.finalScreenshot = shot;
      }
    }
    this.results.push(r);
    this.hooks.onStep?.(r);
  }

  private async stop(
    idx: number,
    step: Step,
    started: number,
    outcome: RunResult["outcome"],
    code: ErrorCode,
    error: string,
  ): Promise<Flow> {
    const notRun = outcome === "rejected" || outcome === "expired";
    await this.record(idx, step, started, { status: notRun ? "skipped" : "failed", errorCode: code, error });
    // A confirmed submission stays a success even if a later, read-only step fails.
    if (this.outcome !== "success") this.outcome = outcome;
    this.errorCode = code;
    this.error = `${step.id} (${step.intent}): ${error}`;
    return { stop: true };
  }

  private async captureFinal(): Promise<void> {
    const policy = this.opts.screenshots;
    const ok = this.outcome === "success" || this.outcome === "dry_run_ok";
    if (this.finalScreenshot) return;
    if (policy === "all" || policy === "final_only" || !ok) this.finalScreenshot = await this.screenshot();
  }

  private patchedBody(): SkillBody {
    const { version: _v, parentVersion: _p, ...base } = this.skill;
    const body: SkillBody = { ...base, params: this.params, steps: this.steps, changelog: "" };
    return { ...body, changelog: diffSkills(this.skill, body, this.notes).join("\n") };
  }

  private result(): RunResult {
    return {
      runId: this.opts.runId,
      skill: { name: this.skill.name, version: this.skill.version },
      outcome: this.outcome ?? "failed",
      steps: this.results,
      ...(this.verification ? { verification: this.verification } : {}),
      extracted: this.extracted,
      ...(this.finalScreenshot ? { finalScreenshot: this.finalScreenshot } : {}),
      ...(this.changed ? { patched: this.patchedBody() } : {}),
      ms: Math.round(this.since(this.started)),
      execCostUsd: this.cost,
      ...(this.errorCode ? { errorCode: this.errorCode } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }
}

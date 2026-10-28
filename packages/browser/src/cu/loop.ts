// The computer-use loop: model turns -> guarded actions on a real page -> one screenshot per batch -> trace.
// Design notes: docs/ARCHITECTURE.md 2.2, docs/reviews/computer-use-review.md 1.2-1.3 and 7, architect-review 2.1.

import {
  type ArtifactRef,
  type CallCtx,
  type Clock,
  type ComputerUseModel,
  type CuAction,
  type CuHooks,
  type CuReply,
  type CuRunInput,
  type CuRunResult,
  type CuSession,
  type CuTurn,
  type Decision,
  DockhandError,
  type FnName,
  type ParamValue,
  type SafetyCheck,
  systemClock,
  type Target,
  type Trace,
  type TraceStep,
  VIEWPORT,
} from "@dockhand/core";
import type { Dialog, FileChooser, Frame, Page, Request } from "playwright";
import {
  type ActiveCommit,
  type CommitInfo,
  ensureDh,
  type PageSignature,
  type ViewRect,
} from "../dom/script.ts";
import {
  type DescribedElement,
  describeActiveWithHandle,
  describeAt,
  describeAtWithHandle,
  describeHandle,
} from "../helpers/describe.ts";
import { formSnapshot } from "../helpers/forms.ts";
import { installWriteGuard, type WriteGuard } from "../helpers/writeGuard.ts";
import { pngSize } from "../png.ts";
import { isCommitTarget, keyCommitTarget } from "./commit.ts";
import { planKeys } from "./keys.ts";
import {
  AttachFileArgs,
  BLOCKED_PREFIX,
  computerUseFunctions,
  computerUseInstructions,
  ProposeTargetArgs,
  RequestCommitArgs,
  startTask,
} from "./prompt.ts";
import { describeStep, rolloverSummary } from "./summary.ts";

type Outcome = Trace["outcome"];
type ComputerCall = Extract<CuTurn, { kind: "computer_call" }>;
type FunctionCall = Extract<CuTurn, { kind: "function_call" }>;

const FINAL_TEXT_BYTES = 4096;
const TRACKED_REQUESTS = new Set(["document", "fetch", "xhr"]);
// Meta's computer tool sends scroll deltas in mouse-wheel notches, not pixels: asked to scroll "about half a
// screen", muse-spark-1.3 sent scroll_y 4, and runs that executed 4-8 px never moved the form. Small deltas
// are notches of Chromium's 100 px; large ones (the model also sent -800 to jump to the top) are pixels.
const WHEEL_NOTCH_PX = 100;
const MAX_NOTCHES = 50;
// Meta attaches this check to every computer_call that acts (seen live on every turn, even a scroll), so it
// carries no information about the action. Dockhand's own gates are the confirmation it asks for: the rep
// approved the plan, commit controls are blocked without an approval token and the write guard holds every
// write. These are acknowledged by that policy; any other check code goes to the human (approveSafety).
const POLICY_ACKNOWLEDGED_CHECKS = new Set(["computer_action_requires_confirmation"]);
/** How long the page may keep scrolling (keyboard and wheel scrolls are smooth) before a screenshot. */
const SCROLL_IDLE_MS = 800;

function wheelPixels(delta: number): number {
  return Math.abs(delta) < MAX_NOTCHES ? delta * WHEEL_NOTCH_PX : delta;
}
const FIELD_ROLES = new Set([
  "textbox",
  "searchbox",
  "spinbutton",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "slider",
]);
// 1x1 transparent PNG, only for a final screenshot when the page was gone before anything was captured.
const PLACEHOLDER_PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    "base64",
  ),
);

class StopRun extends Error {
  constructor(
    readonly outcome: Outcome,
    message: string,
  ) {
    super(message);
  }
}

export interface RunComputerUseOptions {
  clock?: Clock;
}

/** Runs a computer-use session against `input.page` until the model finishes, a gate stops it, or a limit hits. */
export function runComputerUse(
  model: ComputerUseModel,
  input: CuRunInput,
  hooks: CuHooks,
  ctx: CallCtx,
  opts: RunComputerUseOptions = {},
): Promise<CuRunResult> {
  return new ComputerUseRun(model, input, hooks, ctx, opts.clock ?? systemClock).run();
}

function clampPoint(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.min(VIEWPORT.w - 1, Math.max(0, Math.round(x))),
    y: Math.min(VIEWPORT.h - 1, Math.max(0, Math.round(y))),
  };
}

function pointOf(a: CuAction): { x: number; y: number } | null {
  switch (a.type) {
    case "click":
    case "double_click":
    case "move":
    case "scroll":
      return clampPoint(a.x, a.y);
    case "drag": {
      const first = a.path[0];
      return first ? clampPoint(first.x, first.y) : null;
    }
    default:
      return null;
  }
}

const isHistoryClick = (a: CuAction) => a.type === "click" && (a.button === "back" || a.button === "forward");

/** What the model saw at (x, y): the smallest mapped rect containing the point. */
function intendedUid(map: ViewRect[], x: number, y: number): number | null {
  let best: ViewRect | null = null;
  for (const r of map) {
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h && (!best || r.w * r.h < best.w * best.h))
      best = r;
  }
  return best?.uid ?? null;
}

function isField(t: Target | undefined): boolean {
  if (!t) return false;
  const fp = t.fingerprint;
  if (fp.tag === "input") return !["submit", "button", "reset", "image"].includes(fp.inputType ?? "");
  return fp.tag === "select" || fp.tag === "textarea" || FIELD_ROLES.has(fp.role ?? "");
}

/** Nothing a user could notice changed (scroll position and a blur to the body do not count). */
function sameState(a: PageSignature, b: PageSignature): boolean {
  return (
    a.url === b.url &&
    a.title === b.title &&
    a.dialogs.join(",") === b.dialogs.join(",") &&
    a.popups === b.popups &&
    a.expanded === b.expanded &&
    a.alerts === b.alerts &&
    a.values === b.values &&
    (b.focus === 0 || a.focus === b.focus)
  );
}

function truncateUtf8(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.byteLength <= maxBytes) return s;
  return buf.subarray(0, maxBytes).toString("utf8").replace(/�+$/, "");
}

function extensionFor(mime: string): string {
  return (
    (
      {
        "application/pdf": ".pdf",
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "text/plain": ".txt",
      } as Record<string, string>
    )[mime] ?? ""
  );
}

function filenameFor(slot: string, ref: ArtifactRef, params: Record<string, ParamValue>): string {
  for (const v of Object.values(params)) {
    if (typeof v === "object" && v.file.id === ref.id) return v.filename;
  }
  return `${slot}${extensionFor(ref.mime)}`;
}

interface EffectMark {
  nav: number;
  choosers: number;
  jsDialogs: number;
  popups: number;
  blockedWrites: number;
  released: number;
  requests: number;
  inflight: Set<Request>;
}

class ComputerUseRun {
  private readonly page: Page;
  private readonly steps: TraceStep[] = [];
  private batch: { step: TraceStep; described: DescribedElement | null }[] = [];
  private viewMap: ViewRect[] = [];
  private lastShot: { bytes: Uint8Array; ref: ArtifactRef } | null = null;
  private notes: string[] = [];
  private commitTokens = 0;
  private actions = 0;
  private humanMs = 0;
  private startedAt = 0;
  private outcome: Outcome = "failed";
  private message: string | undefined;
  private proposed: Target | undefined;
  private chooser: { chooser: FileChooser; target: Promise<Target | null> } | null = null;
  private readonly attachedSlots: string[] = [];
  private lastStale: { x: number; y: number; intended: number | null; actual: number | null } | null = null;
  private lastUrl = "";
  private guard: WriteGuard | null = null;
  // effect counters (event listeners bump them; actions compare before/after)
  private navCount = 0;
  private chooserCount = 0;
  private jsDialogCount = 0;
  private popupCount = 0;
  private blockedWriteCount = 0;
  private requestCount = 0;
  private readonly inflight = new Set<Request>();

  constructor(
    private readonly model: ComputerUseModel,
    private readonly input: CuRunInput,
    private readonly hooks: CuHooks,
    private readonly ctx: CallCtx,
    private readonly clock: Clock,
  ) {
    this.page = input.page;
  }

  // ---------- listeners ----------

  private readonly onFrameNavigated = (frame: Frame) => {
    if (frame === this.page.mainFrame()) this.navCount++;
  };
  private readonly onFileChooser = (chooser: FileChooser) => {
    this.chooserCount++;
    this.chooser = { chooser, target: describeHandle(this.page, chooser.element()).catch(() => null) };
  };
  private readonly onDialog = (dialog: Dialog) => {
    this.jsDialogCount++;
    this.note(`A browser ${dialog.type()} said "${dialog.message()}". It was dismissed.`);
    dialog.dismiss().catch(() => {});
  };
  private readonly onPopup = (popup: Page) => {
    this.popupCount++;
    this.note("A new tab opened and was closed. Stay in this tab.");
    popup.close().catch(() => {});
  };
  private readonly onRequest = (r: Request) => {
    if (!TRACKED_REQUESTS.has(r.resourceType())) return;
    this.requestCount++;
    this.inflight.add(r);
  };
  private readonly onRequestDone = (r: Request) => {
    this.inflight.delete(r);
  };

  private attach(): void {
    const p = this.page;
    p.on("framenavigated", this.onFrameNavigated);
    p.on("filechooser", this.onFileChooser);
    p.on("dialog", this.onDialog);
    p.on("popup", this.onPopup);
    p.on("request", this.onRequest);
    p.on("requestfinished", this.onRequestDone);
    p.on("requestfailed", this.onRequestDone);
  }

  private detach(): void {
    const p = this.page;
    p.off("framenavigated", this.onFrameNavigated);
    p.off("filechooser", this.onFileChooser);
    p.off("dialog", this.onDialog);
    p.off("popup", this.onPopup);
    p.off("request", this.onRequest);
    p.off("requestfinished", this.onRequestDone);
    p.off("requestfailed", this.onRequestDone);
  }

  private note(text: string): void {
    if (!this.notes.includes(text)) this.notes.push(text);
  }

  private takeNote(): string | undefined {
    const text = this.notes.join("\n");
    this.notes = [];
    return text || undefined;
  }

  // ---------- run ----------

  async run(): Promise<CuRunResult> {
    const { page, input } = this;
    this.startedAt = this.clock.now();
    const startUrl = page.url();
    this.lastUrl = startUrl;
    this.attach();
    try {
      this.guard = await installWriteGuard(page, input.writeGuard, async (req) => {
        this.blockedWriteCount++;
        this.note(
          `A ${req.method} to ${new URL(req.url).pathname} was blocked: nothing is saved or submitted without approval.` +
            (input.commitPolicy === "gate" ? " Call request_commit first." : ""),
        );
        return "block";
      });
      const size = page.viewportSize();
      if (!size || size.width !== VIEWPORT.w || size.height !== VIEWPORT.h) {
        throw new DockhandError(
          "TOOL_ERROR",
          `viewport is ${size?.width}x${size?.height}, expected 1280x800`,
        );
      }
      await ensureDh(page);
      const session = this.model.open({
        instructions: computerUseInstructions(input),
        functions: computerUseFunctions(input),
      });
      const first = await this.capture();
      let reply: CuReply = { kind: "start", task: startTask(input), screenshot: first.bytes };
      let incomplete = 0;
      for (;;) {
        this.checkLimits();
        const turns = await session.send(reply, this.ctx);
        this.checkCost();
        const call = turns.find(
          (t): t is ComputerCall | FunctionCall => t.kind === "computer_call" || t.kind === "function_call",
        );
        if (!call) {
          const final = turns.find((t) => t.kind === "final");
          if (!final && turns.some((t) => t.kind === "incomplete")) {
            if (++incomplete > 1)
              throw new StopRun("failed", "MODEL_INCOMPLETE: the response was cut off twice");
            continue; // resend the same reply once
          }
          this.finish(final?.kind === "final" ? final.text : "");
          break;
        }
        incomplete = 0;
        if (call.kind === "computer_call") reply = await this.onComputerCall(call, session);
        else {
          const next = await this.onFunctionCall(call);
          if (!next) break;
          reply = next;
        }
      }
    } catch (e) {
      if (e instanceof StopRun) {
        this.outcome = e.outcome;
        this.message = e.message;
      } else if (page.isClosed()) {
        this.outcome = "expired";
        this.message = "the browser page closed (lease expired or released)";
      } else {
        this.outcome = "failed";
        this.message =
          e instanceof DockhandError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
      }
    } finally {
      this.detach();
      await this.guard?.dispose();
    }
    const final = await this.finalState();
    for (const b of this.batch) await b.described?.handle.dispose().catch(() => {});
    this.batch = [];
    const trace: Trace = {
      runId: input.runId,
      portalId: input.portalId,
      startUrl,
      viewport: { w: VIEWPORT.w, h: VIEWPORT.h },
      params: input.params,
      steps: this.steps,
      final,
      outcome: this.outcome,
    };
    return {
      trace,
      outcome: this.outcome,
      ...(this.message !== undefined ? { message: this.message } : {}),
      ...(this.proposed ? { proposed: this.proposed } : {}),
    };
  }

  private finish(text: string): void {
    this.message = text;
    if (this.input.commitPolicy === "propose_only") {
      this.outcome = "failed";
      if (!text) this.message = "the model ended without proposing a target";
    } else {
      this.outcome = text.trim().toUpperCase().startsWith(BLOCKED_PREFIX) ? "failed" : "done";
    }
  }

  // ---------- limits ----------

  private checkLimits(): void {
    if (this.ctx.signal?.aborted) throw new StopRun("failed", "aborted");
    const elapsed = this.clock.now() - this.startedAt - this.humanMs;
    if (elapsed > this.input.limits.maxWallMs) {
      throw new StopRun(
        "budget_exceeded",
        `wall clock ${elapsed} ms over the ${this.input.limits.maxWallMs} ms budget`,
      );
    }
  }

  private checkCost(): void {
    const cost = this.input.costSoFar?.();
    if (cost !== undefined && cost > this.input.limits.maxCostUsd) {
      throw new StopRun(
        "budget_exceeded",
        `cost $${cost.toFixed(4)} over the $${this.input.limits.maxCostUsd} budget`,
      );
    }
  }

  /** Time spent waiting for a person does not count against the wall-clock budget. */
  private async human(ask: () => Promise<Decision>): Promise<Decision> {
    const t0 = this.clock.now();
    try {
      return await ask();
    } finally {
      this.humanMs += this.clock.now() - t0;
    }
  }

  // ---------- computer calls ----------

  private async onComputerCall(call: ComputerCall, session: CuSession): Promise<CuReply> {
    let acknowledged: SafetyCheck[] = [];
    if (call.safetyChecks.length > 0) {
      const forHuman = call.safetyChecks.filter((c) => !POLICY_ACKNOWLEDGED_CHECKS.has(c.code));
      if (forHuman.length > 0) {
        const shot = this.lastShot ?? (await this.capture());
        const decision = await this.human(() =>
          this.hooks.approveSafety({ checks: forHuman, screenshot: shot.ref }),
        );
        if (decision !== "approved") {
          const codes = forHuman.map((c) => c.code).join(", ");
          throw new StopRun(
            decision === "expired" ? "expired" : "rejected",
            `safety check ${decision}: ${codes}`,
          );
        }
      }
      acknowledged = call.safetyChecks;
    }
    for (const action of call.actions) {
      if (action.type !== "screenshot" && this.actions >= this.input.limits.maxActions) {
        throw new StopRun("budget_exceeded", `action budget of ${this.input.limits.maxActions} used up`);
      }
      this.checkLimits();
      const { stop } = await this.runAction(action);
      if (stop) break;
    }
    const shot = await this.capture();
    if (session.imagesInChain() >= this.input.limits.rolloverAfterImages && this.canRollover()) {
      return { kind: "rollover", summary: await this.summary(), screenshot: shot.bytes };
    }
    const note = this.takeNote();
    return {
      kind: "computer_output",
      callId: call.callId,
      screenshot: shot.bytes,
      acknowledged,
      ...(note ? { note } : {}),
    };
  }

  /** Never between an approval and its commit click, nor while a file picker waits for attach_file. */
  private canRollover(): boolean {
    return this.chooser === null && this.commitTokens === 0;
  }

  private async summary(): Promise<string> {
    const form = await formSnapshot(this.page).catch(() => ({}));
    const heading = await this.page.evaluate(() => window.__dh?.mainHeading() ?? "").catch(() => "");
    const note = this.takeNote();
    return rolloverSummary(this.input, this.steps, {
      url: this.page.url(),
      heading,
      form,
      commitApproved: this.commitTokens > 0,
      attachedSlots: this.attachedSlots,
      ...(note ? { note } : {}),
    });
  }

  private mark(): EffectMark {
    return {
      nav: this.navCount,
      choosers: this.chooserCount,
      jsDialogs: this.jsDialogCount,
      popups: this.popupCount,
      blockedWrites: this.blockedWriteCount,
      released: this.guard?.released() ?? 0,
      requests: this.requestCount,
      inflight: new Set(this.inflight),
    };
  }

  /** Lets the page react: load after a navigation, in-flight requests the action started, two frames. */
  private async settle(mark: EffectMark, maxRequestMs = 3000): Promise<void> {
    const page = this.page;
    // Two frames first: request events from the action's handlers reach Node slightly after the input returns.
    await this.frames();
    const t0 = Date.now();
    while ([...this.inflight].some((r) => !mark.inflight.has(r)) && Date.now() - t0 < maxRequestMs) {
      await new Promise((r) => setTimeout(r, 20));
    }
    if (this.navCount !== mark.nav)
      await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
    await this.frames(); // the app reacts to the responses (an SPA navigates after its POST resolves)
  }

  private async frames(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await ensureDh(this.page);
        await this.page.evaluate(() => window.__dh?.frames());
        return;
      } catch {
        if (this.page.isClosed()) return;
        await this.page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
      }
    }
  }

  /** Waits until the window (and the scroll containers at the viewport centre) stop moving. */
  private async scrollIdle(): Promise<void> {
    await this.page
      .evaluate(([x, y, ms]) => window.__dh?.waitScrollIdle(x, y, ms), [
        VIEWPORT.w / 2,
        VIEWPORT.h / 2,
        SCROLL_IDLE_MS,
      ] as const)
      .catch(() => {});
  }

  private async signature(): Promise<PageSignature | null> {
    try {
      await ensureDh(this.page);
      return (await this.page.evaluate(() => window.__dh?.signature() ?? null)) ?? null;
    } catch {
      return null;
    }
  }

  /** The commit control this action would activate, if any (click, double-click, Enter, Space, typed newline). */
  private async commitTarget(
    a: CuAction,
    pt: { x: number; y: number } | null,
  ): Promise<{ commit: CommitInfo | null; active: ActiveCommit | null }> {
    const page = this.page;
    const hints = this.input.commitHints;
    if (pt && ((a.type === "click" && (a.button ?? "left") === "left") || a.type === "double_click")) {
      const r = await page.evaluate(([x, y]) => window.__dh?.commitAt(x, y) ?? { info: null, filled: 0 }, [
        pt.x,
        pt.y,
      ] as const);
      return { commit: isCommitTarget(r.info, r.filled, hints) ? r.info : null, active: null };
    }
    const plan = a.type === "keypress" ? planKeys(a.keys) : null;
    const typedNewline = a.type === "type" && /\r|\n/.test(a.text);
    if (!(plan?.enter || plan?.space || typedNewline)) return { commit: null, active: null };
    const active: ActiveCommit = await page.evaluate(
      () => window.__dh?.commitActive() ?? ({ kind: "none", filled: 0 } as const),
    );
    const viaEnter = plan?.enter || typedNewline ? keyCommitTarget(active, "enter", hints) : null;
    const viaSpace = plan?.space ? keyCommitTarget(active, "space", hints) : null;
    return { commit: viaEnter ?? viaSpace, active };
  }

  private async runAction(a: CuAction): Promise<{ stop: boolean }> {
    const page = this.page;
    await ensureDh(page);
    const urlBefore = page.url();
    const step: TraceStep = {
      i: this.steps.length,
      ts: this.clock.now(),
      action: a,
      urlBefore,
      urlAfter: urlBefore,
      tags: [],
    };
    const pt = pointOf(a);

    // 1) Stale coordinates: the element under the point must be the one the model saw there.
    if (pt && !isHistoryClick(a) && (a.type === "click" || a.type === "double_click" || a.type === "drag")) {
      const intended = intendedUid(this.viewMap, pt.x, pt.y);
      const now = await page.evaluate(
        ([x, y]) => window.__dh?.hitUid(x, y) ?? { uid: null, interactive: false },
        [pt.x, pt.y] as const,
      );
      const actual = now.interactive ? now.uid : null;
      const repeat =
        this.lastStale !== null &&
        Math.abs(this.lastStale.x - pt.x) <= 4 &&
        Math.abs(this.lastStale.y - pt.y) <= 4 &&
        this.lastStale.intended === intended &&
        this.lastStale.actual === actual;
      if (intended !== actual && !repeat) {
        // A repeat of the same mismatch after a fresh screenshot means the map, not the page, is off: go ahead.
        this.lastStale = { x: pt.x, y: pt.y, intended, actual };
        this.note(
          `Stopped before the ${a.type.replace("_", " ")} at (${pt.x}, ${pt.y}): the page changed after your last screenshot. Look at the new screenshot before acting.`,
        );
        return { stop: true };
      }
    }

    // 2) Commit guard (harness-enforced): a commit control without an approval token is not activated.
    const { commit, active } = await this.commitTarget(a, pt);

    // 3) Capture before acting: target, form values.
    let described: DescribedElement | null = null;
    if (pt && !isHistoryClick(a) && (a.type === "click" || a.type === "double_click" || a.type === "drag")) {
      described = await describeAtWithHandle(page, pt.x, pt.y).catch(() => null);
    } else if (a.type === "type" || a.type === "keypress") {
      described = await describeActiveWithHandle(page).catch(() => null);
    }
    if (described) step.target = described.target;
    step.formSnapshotBefore = await formSnapshot(page).catch(() => ({}));

    if (commit && this.commitTokens === 0) {
      step.tags.push("blocked");
      this.steps.push(step);
      this.batch.push({ step, described: null });
      await described?.handle.dispose().catch(() => {});
      this.note(
        this.input.commitPolicy === "propose_only"
          ? `Blocked: "${commit.name}" submits. Do not click it in this run; call propose_target with its coordinates.`
          : `Blocked: "${commit.name}" submits the form. Call request_commit first, then click it once the result says approved.`,
      );
      return { stop: true };
    }

    const before = await this.signature();
    const mark = this.mark();
    try {
      await this.execute(a, pt);
    } catch (e) {
      if (page.isClosed()) throw e;
      step.urlAfter = page.url();
      this.steps.push(step);
      this.batch.push({ step, described });
      this.note(`The ${a.type} action failed: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
      return { stop: true };
    }
    await this.settle(mark);
    step.urlAfter = page.url();
    this.lastUrl = step.urlAfter;
    const after = await this.signature();

    const navigated = this.navCount !== mark.nav || step.urlAfter !== urlBefore;
    const choosers = this.chooserCount - mark.choosers;
    const jsDialogs = this.jsDialogCount - mark.jsDialogs;
    const popups = this.popupCount - mark.popups;
    const blockedWrites = this.blockedWriteCount - mark.blockedWrites;
    const released = (this.guard?.released() ?? 0) - mark.released;
    const requests = this.requestCount - mark.requests;

    if (commit) this.commitTokens--;
    if (commit || released > 0) step.tags.push("commit");
    if (navigated) step.tags.push("navigation");
    const enterInListbox = active?.kind === "listbox" && a.type === "keypress" && planKeys(a.keys).enter;
    if (step.target?.fingerprint.role === "option" || enterInListbox) step.tags.push("option");
    if (choosers > 0) step.tags.push("upload");
    if (blockedWrites > 0) step.tags.push("blocked");
    const quiet = !navigated && choosers + jsDialogs + popups + blockedWrites + requests === 0;
    if (quiet && before && after && sameState(before, after)) step.tags.push("noise");

    this.steps.push(step);
    this.batch.push({ step, described });
    if (a.type !== "screenshot") {
      this.actions++;
      if (this.actions % 5 === 0) this.reportProgress(step);
    }

    if (choosers > 0) {
      const slots = Object.keys(this.input.attachments);
      this.note(
        slots.length > 0
          ? `A file picker is open. Call attach_file with one of: ${slots.map((s) => `"${s}"`).join(", ")}.`
          : "A file picker opened, but this run has no files to attach.",
      );
    }
    let scrolled = false;
    let newDialog = false;
    if (before && after) {
      scrolled = before.scrollY !== after.scrollY || before.scrollX !== after.scrollX;
      newDialog = after.dialogs.some((d) => !before.dialogs.includes(d));
    }
    return { stop: navigated || scrolled || newDialog || choosers + jsDialogs + popups + blockedWrites > 0 };
  }

  private async execute(a: CuAction, pt: { x: number; y: number } | null): Promise<void> {
    const { mouse, keyboard } = this.page;
    switch (a.type) {
      case "click":
        if (a.button === "back")
          await this.page.goBack({ waitUntil: "commit", timeout: 5000 }).catch(() => null);
        else if (a.button === "forward")
          await this.page.goForward({ waitUntil: "commit", timeout: 5000 }).catch(() => null);
        else if (pt) {
          const button = a.button === "right" ? "right" : a.button === "wheel" ? "middle" : "left";
          await mouse.click(pt.x, pt.y, { button });
        }
        return;
      case "double_click":
        if (pt) await mouse.dblclick(pt.x, pt.y);
        return;
      case "move":
        if (pt) await mouse.move(pt.x, pt.y);
        return;
      case "drag": {
        const path = a.path.map((p) => clampPoint(p.x, p.y));
        const [first, ...rest] = path;
        if (!first) return;
        await mouse.move(first.x, first.y);
        await mouse.down();
        for (const p of rest) await mouse.move(p.x, p.y, { steps: 4 });
        await mouse.up();
        return;
      }
      case "scroll":
        if (!pt) return;
        await mouse.move(pt.x, pt.y);
        await mouse.wheel(wheelPixels(a.scroll_x), wheelPixels(a.scroll_y));
        // mouse.wheel returns before the scroll is applied; wait until the offsets stop changing.
        await this.page
          .evaluate(([x, y]) => window.__dh?.waitScrollIdle(x, y, 500), [pt.x, pt.y] as const)
          .catch(() => {});
        return;
      case "type": {
        const parts = a.text.split(/\r?\n/);
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i] ?? "";
          if (part) await keyboard.type(part);
          if (i < parts.length - 1) await keyboard.press("Enter");
        }
        return;
      }
      case "keypress":
        for (const chord of planKeys(a.keys).chords) await keyboard.press(chord);
        // PageDown, Space, arrows, Home and End scroll smoothly: let the page come to rest first.
        await this.scrollIdle();
        return;
      case "wait": {
        const mark = this.mark();
        await Promise.all([
          new Promise((r) => setTimeout(r, 300)),
          this.settle({ ...mark, inflight: new Set() }, 1000),
        ]);
        return;
      }
      case "screenshot":
        return;
    }
  }

  private reportProgress(step: TraceStep): void {
    try {
      const what = describeStep(step) ?? step.action.type;
      this.hooks.progress?.({ action: this.actions, note: `${what} (${new URL(this.page.url()).pathname})` });
    } catch {
      // progress is best effort
    }
  }

  /** Screenshot (asserted 1280x800), stored; fresh element map; closes the batch (screenshot, final field values). */
  private async capture(): Promise<{ bytes: Uint8Array; ref: ArtifactRef }> {
    const page = this.page;
    await this.frames();
    // A screenshot taken mid smooth-scroll shows the page where it no longer is: live, the model then
    // clicked labels and section gaps for whole turns after a PageDown.
    await this.scrollIdle();
    const png = await page.screenshot({
      type: "png",
      scale: "css",
      animations: "disabled",
      caret: "hide",
      timeout: 15_000,
    });
    const bytes = new Uint8Array(png);
    const { width, height } = pngSize(bytes);
    if (width !== VIEWPORT.w || height !== VIEWPORT.h) {
      throw new DockhandError(
        "TOOL_ERROR",
        `screenshot is ${width}x${height}, expected ${VIEWPORT.w}x${VIEWPORT.h}`,
      );
    }
    const ref = await this.input.artifacts.put(bytes, "image/png", {
      kind: "screenshot",
      runId: this.input.runId,
    });
    this.viewMap = await page.evaluate(() => window.__dh?.viewMap() ?? []).catch(() => []);
    for (const { step, described } of this.batch) {
      step.screenshot = ref;
      if (!described) continue;
      if (isField(step.target)) {
        const value = await described.handle
          .evaluate((el) => window.__dh?.fieldValueIfConnected(el as Element) ?? null)
          .catch(() => null);
        if (value !== null) {
          step.fieldValueAfter = value;
          if (step.target) step.target.fingerprint.value = value;
        }
      }
      await described.handle.dispose().catch(() => {});
    }
    this.batch = [];
    this.lastShot = { bytes, ref };
    this.lastUrl = page.url();
    return this.lastShot;
  }

  // ---------- function calls ----------

  private fnStep(name: FnName, args: unknown): TraceStep {
    const url = this.page.url();
    return {
      i: this.steps.length,
      ts: this.clock.now(),
      action: { type: "fn", name, args },
      urlBefore: url,
      urlAfter: url,
      tags: [],
    };
  }

  private output(call: FunctionCall, output: string, screenshot?: Uint8Array): CuReply {
    return { kind: "function_output", callId: call.callId, output, ...(screenshot ? { screenshot } : {}) };
  }

  /** Returns the reply to send, or null when the call ends the run. */
  private async onFunctionCall(call: FunctionCall): Promise<CuReply | null> {
    let args: unknown;
    try {
      args = JSON.parse(call.argsJson || "{}");
    } catch {
      return this.output(call, `error: the arguments of ${call.name} are not valid JSON`);
    }
    switch (call.name) {
      case "request_commit":
        return this.requestCommit(call, args);
      case "attach_file":
        return this.attachFile(call, args);
      case "propose_target":
        return this.proposeTarget(call, args);
      default:
        return this.output(call, `error: unknown function "${call.name}"`);
    }
  }

  private async commitButton(): Promise<CommitInfo | null> {
    const buttons = await this.page.evaluate(() => window.__dh?.commitButtons() ?? []).catch(() => []);
    return buttons.find((b) => isCommitTarget(b, 1, this.input.commitHints)) ?? null;
  }

  private async requestCommit(call: FunctionCall, args: unknown): Promise<CuReply | null> {
    const parsed = RequestCommitArgs.safeParse(args);
    if (!parsed.success) return this.output(call, 'error: request_commit needs { "summary": string }');
    const step = this.fnStep("request_commit", parsed.data);
    if (this.input.commitPolicy === "propose_only") {
      this.steps.push(step);
      return this.output(
        call,
        "not available in this run: do not submit. Call propose_target with the submit control's coordinates.",
      );
    }
    await ensureDh(this.page);
    const missing = await this.page.evaluate(() => window.__dh?.requiredEmpty() ?? []);
    step.formSnapshotBefore = await formSnapshot(this.page);
    if (missing.length > 0) {
      this.steps.push(step);
      const list = missing.map((m) => `"${m}"`).join(", ");
      return this.output(
        call,
        `not_ready: ${list} ${missing.length === 1 ? "is" : "are"} empty. Fill ${missing.length === 1 ? "it" : "them"}, then call request_commit again.`,
      );
    }
    const shot = await this.capture();
    step.screenshot = shot.ref;
    const button = await this.commitButton();
    const readback = Object.entries(step.formSnapshotBefore).map(([label, value]) => ({ label, value }));
    const decision = await this.human(() =>
      this.hooks.approveCommit({
        summary: parsed.data.summary,
        screenshot: shot.ref,
        readback,
        ...(button
          ? { highlight: { x: button.box.x, y: button.box.y, w: button.box.w, h: button.box.h } }
          : {}),
      }),
    );
    this.steps.push(step);
    if (decision === "approved") {
      this.commitTokens++;
      this.guard?.grant(1);
      return this.output(call, `approved: click "${button?.name ?? "the submit control"}" now.`);
    }
    if (decision === "expired") throw new StopRun("expired", "the commit approval expired");
    throw new StopRun(
      "rejected",
      decision === "edit" ? "the rep asked for changes before submitting" : "the rep rejected the submission",
    );
  }

  private async attachFile(call: FunctionCall, args: unknown): Promise<CuReply> {
    const parsed = AttachFileArgs.safeParse(args);
    const slots = Object.keys(this.input.attachments);
    if (!parsed.success) return this.output(call, 'error: attach_file needs { "slot": string }');
    const { slot } = parsed.data;
    const ref = this.input.attachments[slot];
    if (!ref)
      return this.output(call, `error: unknown slot "${slot}". Available: ${slots.join(", ") || "none"}.`);
    if (!this.chooser) {
      return this.output(
        call,
        "error: no file picker is open. Click the upload control first, then call attach_file.",
      );
    }
    const { chooser, target } = this.chooser;
    this.chooser = null;
    const step = this.fnStep("attach_file", parsed.data);
    const filename = filenameFor(slot, ref, this.input.params);
    const bytes = await this.input.artifacts.read(ref);
    const mark = this.mark();
    await chooser.setFiles({ name: filename, mimeType: ref.mime, buffer: Buffer.from(bytes) });
    await this.settle(mark);
    const described = await target;
    step.tags.push("upload");
    if (described) {
      step.target = described;
      step.upload = { slot, target: described };
    }
    step.fieldValueAfter = filename;
    step.urlAfter = this.page.url();
    this.attachedSlots.push(slot);
    this.steps.push(step);
    this.batch.push({ step, described: null });
    const shot = await this.capture();
    const label = described?.fingerprint.label;
    return this.output(call, `attached ${filename}${label ? ` to "${label}"` : ""}`, shot.bytes);
  }

  private async proposeTarget(call: FunctionCall, args: unknown): Promise<CuReply | null> {
    const parsed = ProposeTargetArgs.safeParse(args);
    if (!parsed.success)
      return this.output(call, 'error: propose_target needs { "x": number, "y": number, "why": string }');
    if (this.input.commitPolicy !== "propose_only") {
      return this.output(call, "propose_target is only for propose-only runs; click the control yourself.");
    }
    const { x, y } = clampPoint(parsed.data.x, parsed.data.y);
    const target = await describeAt(this.page, x, y);
    if (target.candidates.length === 0) {
      return this.output(
        call,
        `There is no control at (${x}, ${y}). Look at the screenshot and call propose_target again.`,
      );
    }
    const step = this.fnStep("propose_target", { x, y, why: parsed.data.why });
    step.target = target;
    this.steps.push(step);
    this.proposed = target;
    this.outcome = "done";
    this.message = parsed.data.why;
    return null;
  }

  // ---------- end of run ----------

  private async finalState(): Promise<Trace["final"]> {
    const page = this.page;
    if (!page.isClosed()) {
      try {
        const shot = await this.capture();
        const text = await page.evaluate(() => window.__dh?.pageText() ?? "");
        return { url: page.url(), text: truncateUtf8(text, FINAL_TEXT_BYTES), screenshot: shot.ref };
      } catch {
        // fall through to whatever was captured last
      }
    }
    const screenshot =
      this.lastShot?.ref ??
      (await this.input.artifacts.put(PLACEHOLDER_PNG, "image/png", {
        kind: "screenshot",
        runId: this.input.runId,
      }));
    return { url: page.isClosed() ? this.lastUrl : page.url(), text: "", screenshot };
  }
}

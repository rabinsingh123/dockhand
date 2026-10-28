// Scripted computer-use model (CI only): a semantic script becomes real computer_calls with pixel coordinates
// read from live element boxes, run through the same loop as the real model. Says nothing about model quality.

import type {
  CallCtx,
  ComputerUseModel,
  CuAction,
  CuReply,
  CuSession,
  CuTurn,
  FnName,
  FunctionTool,
  Ledger,
  ScriptStep,
  SemanticTarget,
} from "@dockhand/core";
import type { Locator, Page } from "playwright";
import { decoratedNameRegex } from "./helpers/locators.ts";

type AriaRole = Parameters<Page["getByRole"]>[0];

export interface ScriptedModelOptions {
  /** Writes one ledger row per turn (provider "scripted"; never part of reported numbers). */
  ledger?: Ledger;
  /** Cost booked per turn, for budget tests. Default 0. */
  costPerTurnUsd?: number;
  model?: string;
  /** How long to wait for a script target to appear. Default 5000 ms. */
  targetTimeoutMs?: number;
}

export interface ScriptedModel extends ComputerUseModel {
  /** Every reply the loop sent, in order (tests inspect rollovers and notes). */
  readonly replies: CuReply[];
  /** Instructions and function tools of every opened session. */
  readonly sessions: { instructions: string; functions: FunctionTool[] }[];
}

/** Locator for a script target: testid, then role (+name), then label, then text. Names ignore decoration. */
export function semanticLocator(page: Page, t: SemanticTarget): Locator {
  if (t.testId) return page.getByTestId(t.testId).filter({ visible: true });
  if (t.role) {
    return page.getByRole(t.role as AriaRole, t.name ? { name: decoratedNameRegex(t.name) } : {});
  }
  if (t.label) return page.getByLabel(decoratedNameRegex(t.label)).filter({ visible: true });
  if (t.text) return page.getByText(t.text, { exact: true }).filter({ visible: true });
  throw new Error(`script target has nothing to find it by: ${JSON.stringify(t)}`);
}

type Plan = { kind: "point"; x: number; y: number } | { kind: "scroll"; action: CuAction };

const VIEW_H = 800;

/** Centre of the target in viewport pixels, or a scroll that brings it into view first (like a real model). */
async function aim(page: Page, t: SemanticTarget, timeoutMs: number): Promise<Plan> {
  const loc = semanticLocator(page, t);
  await loc.first().waitFor({ state: "visible", timeout: timeoutMs });
  const n = await loc.count();
  if (n !== 1) throw new Error(`script target matches ${n} elements: ${JSON.stringify(t)}`);
  const box = await loc.boundingBox();
  if (!box) throw new Error(`script target has no box: ${JSON.stringify(t)}`);
  if (box.y < 0 || box.y + box.height > VIEW_H) {
    const dy = Math.round(box.y + box.height / 2 - VIEW_H / 2);
    return { kind: "scroll", action: { type: "scroll", x: 640, y: 400, scroll_x: 0, scroll_y: dy } };
  }
  return { kind: "point", x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

async function currentValue(page: Page, t: SemanticTarget): Promise<string | null> {
  try {
    return await semanticLocator(page, t).inputValue({ timeout: 1000 });
  } catch {
    return null;
  }
}

/**
 * A ComputerUseModel that plays `script` against `page`. Each send() reads the live page (right after the
 * harness took its screenshot) and answers with the next turn. fill = [click, ctrl+a, type]; select = [click
 * trigger, type option] then [click option]; typo = [click, type wrong] then [ctrl+a, type right]; misclick =
 * a click at fixed pixels; call = a function call (propose_target accepts `target` instead of x/y).
 * fill and select are re-planned (at most twice) when the field does not show the value afterwards, the way a
 * real model reacts to a batch the harness stopped early.
 */
export function createScriptedModel(
  script: ScriptStep[],
  page: Page,
  opts: ScriptedModelOptions = {},
): ScriptedModel {
  const replies: CuReply[] = [];
  const sessions: { instructions: string; functions: FunctionTool[] }[] = [];
  const timeoutMs = opts.targetTimeoutMs ?? 5000;
  const modelName = opts.model ?? "scripted";
  // Script position survives rollovers: a rollover opens no new session, it only restarts the image count.
  let idx = 0;
  let phase: "start" | "verify" | "pick" | "fix" = "start";
  let retries = 0;
  let calls = 0;

  const callId = () => `scripted_${++calls}`;
  const computer = (actions: CuAction[]): CuTurn[] => [
    { kind: "computer_call", callId: callId(), actions, safetyChecks: [] },
  ];
  const advance = () => {
    idx++;
    phase = "start";
    retries = 0;
  };

  async function nextTurn(): Promise<CuTurn[]> {
    for (;;) {
      const step = script[idx];
      if (!step) return [{ kind: "final", text: "Done." }];
      switch (step.do) {
        case "click": {
          if (harnessSubmitted) {
            // The harness already clicked the approved submit control: a model would not click it again.
            harnessSubmitted = false;
            advance();
            continue;
          }
          const plan = await aim(page, step.target, timeoutMs);
          if (plan.kind === "scroll") return computer([plan.action]);
          advance();
          return computer([{ type: "click", x: plan.x, y: plan.y, button: "left" }]);
        }
        case "fill": {
          if (phase === "verify") {
            if ((await currentValue(page, step.target)) === step.text || retries >= 2) {
              advance();
              continue;
            }
            retries++;
          }
          const plan = await aim(page, step.target, timeoutMs);
          if (plan.kind === "scroll") return computer([plan.action]);
          phase = "verify";
          return computer([
            { type: "click", x: plan.x, y: plan.y, button: "left" },
            { type: "keypress", keys: ["ctrl", "a"] },
            { type: "type", text: step.text },
          ]);
        }
        case "select": {
          if (phase === "verify") {
            if ((await currentValue(page, step.trigger)) === step.option || retries >= 2) {
              advance();
              continue;
            }
            retries++;
            phase = "start";
          }
          if (phase === "pick") {
            const plan = await aim(page, { role: "option", name: step.option }, timeoutMs);
            if (plan.kind === "scroll") return computer([plan.action]);
            phase = "verify";
            return computer([{ type: "click", x: plan.x, y: plan.y, button: "left" }]);
          }
          const plan = await aim(page, step.trigger, timeoutMs);
          if (plan.kind === "scroll") return computer([plan.action]);
          phase = "pick";
          return computer([
            { type: "click", x: plan.x, y: plan.y, button: "left" },
            { type: "type", text: step.option },
          ]);
        }
        case "check": {
          const loc = semanticLocator(page, step.target);
          if (await loc.isChecked({ timeout: timeoutMs }).catch(() => false)) {
            advance();
            continue;
          }
          const plan = await aim(page, step.target, timeoutMs);
          if (plan.kind === "scroll") return computer([plan.action]);
          advance();
          return computer([{ type: "click", x: plan.x, y: plan.y, button: "left" }]);
        }
        case "press":
          advance();
          return computer([{ type: "keypress", keys: step.keys }]);
        case "scroll":
          advance();
          return computer([{ type: "scroll", x: 640, y: 400, scroll_x: 0, scroll_y: step.dy }]);
        case "misclick":
          advance();
          return computer([{ type: "click", x: step.x, y: step.y, button: "left" }]);
        case "typo": {
          if (phase === "fix") {
            advance();
            return computer([
              { type: "keypress", keys: ["ctrl", "a"] },
              { type: "type", text: step.right },
            ]);
          }
          const plan = await aim(page, step.target, timeoutMs);
          if (plan.kind === "scroll") return computer([plan.action]);
          phase = "fix";
          return computer([
            { type: "click", x: plan.x, y: plan.y, button: "left" },
            { type: "type", text: step.wrong },
          ]);
        }
        case "call": {
          const args = await callArgs(step.name, step.args);
          advance();
          return [
            { kind: "function_call", callId: callId(), name: step.name, argsJson: JSON.stringify(args) },
          ];
        }
        case "done":
          advance();
          return [{ kind: "final", text: step.text }];
      }
    }
  }

  /** Set when request_commit came back "approved and submitted": the script's next click is the submit. */
  let harnessSubmitted = false;

  async function callArgs(name: FnName, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (name !== "propose_target" || !args.target) return args;
    const plan = await aim(page, args.target as SemanticTarget, timeoutMs);
    if (plan.kind === "scroll") throw new Error("propose_target target is outside the viewport");
    const { target: _target, ...rest } = args;
    return { why: "scripted", ...rest, x: plan.x, y: plan.y };
  }

  return {
    provider: "scripted",
    model: modelName,
    replies,
    sessions,
    open({ instructions, functions }): CuSession {
      sessions.push({ instructions, functions });
      let images = 0;
      return {
        imagesInChain: () => images,
        async send(reply: CuReply, ctx: CallCtx): Promise<CuTurn[]> {
          const t0 = Date.now();
          replies.push(reply);
          if (reply.kind === "start" || reply.kind === "rollover") images = 1;
          else if (reply.kind === "computer_output" || (reply.kind === "function_output" && reply.screenshot))
            images++;
          let turns: CuTurn[];
          if (reply.kind === "function_output" && /^approved and submitted/.test(reply.output))
            harnessSubmitted = true;
          if (reply.kind === "function_output" && /^rejected/.test(reply.output)) {
            turns = [{ kind: "final", text: "Stopped: the submission was rejected." }];
          } else {
            try {
              turns = await nextTurn();
            } catch (e) {
              turns = [
                {
                  kind: "final",
                  text: `BLOCKED: script error: ${e instanceof Error ? e.message.split("\n")[0] : e}`,
                },
              ];
            }
          }
          opts.ledger?.record({
            purpose: ctx.purpose,
            provider: "scripted",
            model: modelName,
            ...(ctx.jobId ? { jobId: ctx.jobId } : {}),
            ...(ctx.runId ? { runId: ctx.runId } : {}),
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            images: reply.kind === "function_output" && !reply.screenshot ? 0 : 1,
            latencyMs: Date.now() - t0,
            costUsd: opts.costPerTurnUsd ?? 0,
            status: "ok",
          });
          return turns;
        },
      };
    },
  };
}

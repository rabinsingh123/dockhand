import {
  type ComputerUseModel,
  type CuReply,
  type CuSession,
  DockhandError,
  type Effort,
  type FunctionTool,
  type ModelId,
} from "@dockhand/core";
import { openScope, recordCall } from "./call.ts";
import { cassetteKey, type Tape } from "./cassette.ts";
import { MAX_IMAGES_PER_REQUEST } from "./config.ts";
import { responsesUsage, tokenCostUsd } from "./cost.ts";
import type { GatewayEnv } from "./env.ts";
import { providerErrorDetail, type RequestScope } from "./http.ts";
import { screenshotMime, toDataUrl } from "./media.ts";
import { incompleteReason, parseCuTurns, parseResponseBody } from "./responses.ts";
import { effortFor } from "./structured.ts";

export interface CuModelOptions {
  model: ModelId;
  effort?: Effort;
}

/** Function names: ^[a-zA-Z0-9_.-]+$ with at most one dot (https://dev.meta.ai/docs/tool-calling). */
const FUNCTION_NAME = /^[a-zA-Z0-9_.-]+$/;
/** A computer_call_output screenshot must decode to 25 MiB or less. */
const MAX_SCREENSHOT_BYTES = 25 * 1024 * 1024;
/** Persistence can briefly lag a completed response; the docs say to retry a chained request once or twice. */
const CHAIN_LAG_RETRY_MS = 1_000;

/**
 * Meta's native computer tool over the Responses API (https://dev.meta.ai/docs/computer-use). Each session
 * owns its previous_response_id chain with store: true. instructions, tools and reasoning are re-sent on
 * every turn because previous_response_id does not carry them.
 */
export function createMetaComputerUseModel(env: GatewayEnv, opts: CuModelOptions): ComputerUseModel {
  return {
    provider: env.cassettes.mode === "replay" ? "cassette" : "meta",
    model: opts.model,
    open({ instructions, functions }) {
      for (const f of functions) assertFunctionName(f.name);
      return openSession(env, opts, instructions, functions);
    },
  };
}

function openSession(
  env: GatewayEnv,
  opts: CuModelOptions,
  instructions: string,
  functions: FunctionTool[],
): CuSession {
  const tools = [{ type: "computer" }, ...functions.map(toFunctionTool)];
  const effort = effortFor(opts.model, opts.effort);
  let previousResponseId: string | undefined;
  let images = 0;
  let tape: Tape | undefined;

  return {
    imagesInChain: () => images,
    async send(reply, ctx) {
      const newChain = reply.kind === "start" || reply.kind === "rollover";
      if (!newChain && previousResponseId === undefined) {
        throw new DockhandError(
          "MODEL_ERROR",
          "computer-use session: the first reply must be start (or rollover)",
        );
      }
      const screenshot = reply.screenshot;
      const shots = screenshot ? 1 : 0;
      const chainImages = (newChain ? 0 : images) + shots;
      if (chainImages > MAX_IMAGES_PER_REQUEST) {
        throw new DockhandError(
          "TOO_MANY_IMAGES",
          `computer-use chain would hold ${chainImages} images (max ${MAX_IMAGES_PER_REQUEST}): roll over first`,
        );
      }
      const imageUrl = screenshot ? screenshotUrl(screenshot) : undefined;
      // Recording is per session, turn by turn: the key comes from what is stable across runs (not pixels).
      tape ??= env.cassettes.tape(
        ctx.purpose,
        cassetteKey(ctx.purpose, { model: opts.model, instructions, functions, first: firstText(reply) }),
      );
      const sessionTape = tape;
      const chainFrom = newChain ? undefined : previousResponseId;
      const scope = openScope(ctx);
      try {
        return await recordCall(
          env,
          {
            ctx,
            provider: sessionTape.replaying ? "cassette" : "meta",
            model: opts.model,
            normalize: scope.normalize,
            price: (rec) => tokenCostUsd(opts.model, rec.usage),
          },
          async (rec) => {
            rec.images = shots;
            const body = {
              model: opts.model,
              instructions,
              tools,
              input: replyInput(reply, imageUrl),
              ...(effort !== undefined ? { reasoning: { effort } } : {}),
              ...(env.disableParallelToolCalls ? { parallel_tool_calls: false } : {}),
              store: true,
              ...(chainFrom !== undefined ? { previous_response_id: chainFrom } : {}),
            };
            const raw = await sessionTape.next(
              () => post(env, body, chainFrom !== undefined, scope),
              reply.kind,
            );
            const resp = parseResponseBody(raw);
            rec.usage = responsesUsage(resp.usage);
            rec.responseId = resp.id;
            const turns = parseCuTurns(resp);
            if (incompleteReason(resp) !== undefined) {
              // The chain is not advanced, so resending the same reply continues from the same state.
              rec.status = "incomplete";
              rec.errorCode = "MODEL_INCOMPLETE";
              return turns;
            }
            previousResponseId = resp.id;
            images = chainImages;
            return turns;
          },
        );
      } finally {
        await sessionTape.save();
      }
    },
  };
}

/** Input items for one reply, in the shapes of the computer-use and tool-calling pages. */
function replyInput(reply: CuReply, imageUrl: string | undefined): Record<string, unknown>[] {
  const image = () => ({ type: "input_image", image_url: imageUrl });
  switch (reply.kind) {
    case "start":
      return [{ role: "user", content: [{ type: "input_text", text: reply.task }, image()] }];
    case "rollover":
      return [{ role: "user", content: [{ type: "input_text", text: reply.summary }, image()] }];
    case "computer_output":
      return [
        {
          type: "computer_call_output",
          call_id: reply.callId,
          acknowledged_safety_checks: reply.acknowledged.map((c) => ({
            id: c.id,
            code: c.code,
            message: c.message,
          })),
          output: { type: "computer_screenshot", image_url: imageUrl },
        },
        // A harness note (e.g. the commit gate) follows the output as a user message in the same request.
        ...(reply.note ? [{ role: "user", content: [{ type: "input_text", text: reply.note }] }] : []),
      ];
    case "function_output":
      return [
        { type: "function_call_output", call_id: reply.callId, output: reply.output },
        // Images count only in user messages, so a screenshot after a function call travels as one.
        ...(imageUrl ? [{ role: "user", content: [image()] }] : []),
      ];
  }
}

async function post(env: GatewayEnv, body: Record<string, unknown>, chained: boolean, scope: RequestScope) {
  try {
    return await env.meta.postJson("/responses", body, scope);
  } catch (err) {
    const d = providerErrorDetail(err);
    const chainLag =
      chained &&
      d?.status === 400 &&
      (d.param === "previous_response_id" || /previous_response_id/i.test(d.message));
    if (!chainLag) throw err;
    env.log.warn("previous response not found yet; retrying once", { retryInMs: CHAIN_LAG_RETRY_MS });
    await env.sleep(CHAIN_LAG_RETRY_MS, scope.signal);
    return env.meta.postJson("/responses", body, scope);
  }
}

function screenshotUrl(bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_SCREENSHOT_BYTES) {
    throw new DockhandError("MEDIA_UNSUPPORTED", `screenshot is ${bytes.byteLength} bytes (max 25 MiB)`);
  }
  return toDataUrl(screenshotMime(bytes), bytes);
}

function firstText(reply: CuReply): string {
  if (reply.kind === "start") return reply.task;
  if (reply.kind === "rollover") return reply.summary;
  return "";
}

function toFunctionTool(f: FunctionTool): Record<string, unknown> {
  // strict: false explicitly: the docs disagree on the default, and true would 400 on non-strict schemas.
  return {
    type: "function",
    name: f.name,
    description: f.description,
    parameters: f.parameters,
    strict: false,
  };
}

function assertFunctionName(name: string): void {
  if (!FUNCTION_NAME.test(name) || name.split(".").length > 2) {
    throw new DockhandError(
      "MODEL_ERROR",
      `function tool name "${name}" is not allowed (^[a-zA-Z0-9_.-]+$, one dot at most)`,
    );
  }
}

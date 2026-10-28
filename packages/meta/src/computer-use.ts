import {
  type CallCtx,
  type ComputerUseModel,
  type CuReply,
  type CuSession,
  type CuTurn,
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
import { effortFor } from "./policy.ts";
import { incompleteReason, parseCuTurns, parseResponseBody } from "./responses.ts";

/**
 * How a session keeps its conversation.
 * - stateless (default): store:false, and every request replays the session's history (the computer-use
 *   page's "stateless replay"). Measured live on muse-spark-1.3: 2.4-3.2 s per turn.
 * - chained: store:true + previous_response_id (the page's simplest form). Measured live: 9-11 s per turn
 *   for the same turn, so it is kept only as a fallback.
 */
export type CuState = "stateless" | "chained";

export interface CuModelOptions {
  model: ModelId;
  /** Default: the purpose's effort from policy.ts (the API itself defaults to "high"). */
  effort?: Effort;
  /** Default: the gateway's `computerUseState` (stateless). */
  state?: CuState;
}

/**
 * Stateless history window. The docs cap direct replay at 29 call/output pairs (and 50 images per request);
 * a session replays at most this many answered turns after its opening message...
 */
export const CU_HISTORY_MAX_TURNS = 12;
/** ...and when the window is full it drops whole old turns down to this many, so the cached prefix lasts. */
export const CU_HISTORY_KEEP_TURNS = 6;

type Item = Record<string, unknown>;

/** Function names: ^[a-zA-Z0-9_.-]+$ with at most one dot (https://dev.meta.ai/docs/tool-calling). */
const FUNCTION_NAME = /^[a-zA-Z0-9_.-]+$/;
/** A computer_call_output screenshot must decode to 25 MiB or less. */
const MAX_SCREENSHOT_BYTES = 25 * 1024 * 1024;
/** Appended to a function output whose screenshot cannot be sent. */
export const SCREEN_CHANGED = "The screen has changed: take a screenshot before your next action.";
/** Persistence can briefly lag a completed response; the docs say to retry a chained request once or twice. */
const CHAIN_LAG_RETRY_MS = 1_000;

/**
 * The model that takes over when the API refuses the computer tool for the requested one. Live on
 * 2026-10-28, muse-wonder-1.0 answered every computer-tool request with HTTP 400 "Unsupported tool type:
 * 'computer'" (the computer-use page says it runs on Wonder); muse-spark-1.3 accepts it.
 */
export const CU_FALLBACK_MODEL = "muse-spark-1.3";

/** The model in use; it changes once if the API refuses the computer tool for the requested model. */
interface ModelSlot {
  current: ModelId;
}

/**
 * Meta's native computer tool over the Responses API (https://dev.meta.ai/docs/computer-use). Each session
 * owns its conversation: replayed history (stateless) or a previous_response_id chain (chained).
 * instructions, tools and reasoning are sent on every turn either way (previous_response_id does not carry
 * them). If the API refuses the computer tool for the requested model, the model switches to
 * CU_FALLBACK_MODEL for this and every later session (logged; ledger rows carry the model actually used).
 */
export function createMetaComputerUseModel(env: GatewayEnv, opts: CuModelOptions): ComputerUseModel {
  const slot: ModelSlot = { current: opts.model };
  return {
    provider: env.cassettes.mode === "replay" ? "cassette" : "meta",
    get model() {
      return slot.current;
    },
    open({ instructions, functions }) {
      for (const f of functions) assertFunctionName(f.name);
      return openSession(env, opts, slot, instructions, functions);
    },
  };
}

function computerToolRefused(err: unknown): boolean {
  const d = providerErrorDetail(err);
  return d?.status === 400 && /unsupported tool type: 'computer'/i.test(d.message);
}

interface Turn {
  items: Item[];
  images: number;
}

function openSession(
  env: GatewayEnv,
  opts: CuModelOptions,
  slot: ModelSlot,
  instructions: string,
  functions: FunctionTool[],
): CuSession {
  const tools = [{ type: "computer" }, ...functions.map(toFunctionTool)];
  const stateless = (opts.state ?? env.computerUseState) === "stateless";
  // chained
  let previousResponseId: string | undefined;
  let chainImages = 0;
  // stateless: the opening user message, answered turns (the model's items + our reply), and the last
  // response's replayable items waiting for our reply
  let opening: Item[] = [];
  let openingImages = 0;
  let turns: Turn[] = [];
  let pending: Item[] | undefined;
  let tape: Tape | undefined;

  const replayedImages = () => openingImages + turns.reduce((n, t) => n + t.images, 0);

  const sendOnce = async (reply: CuReply, ctx: CallCtx): Promise<CuTurn[]> => {
    const model = slot.current;
    const newChain = reply.kind === "start" || reply.kind === "rollover";
    const started = stateless ? pending !== undefined : previousResponseId !== undefined;
    if (!newChain && !started) {
      throw new DockhandError(
        "MODEL_ERROR",
        "computer-use session: the first reply must be start (or rollover)",
      );
    }
    const screenshot = reply.screenshot;
    // Only start, rollover and computer_output carry an image (see replyInput for function outputs).
    const sendsImage = screenshot !== undefined && reply.kind !== "function_output";
    const shots = sendsImage ? 1 : 0;
    const imageUrl = sendsImage ? screenshotUrl(screenshot) : undefined;
    const replyItems = replyInput(reply, imageUrl);

    // What this request carries, and the state to keep if it completes.
    let nextOpening = opening;
    let nextOpeningImages = openingImages;
    let nextTurns = turns;
    let input: Item[];
    let requestImages: number;
    if (!stateless) {
      input = replyItems;
      requestImages = (newChain ? 0 : chainImages) + shots;
    } else {
      if (newChain) {
        nextOpening = replyItems;
        nextOpeningImages = shots;
        nextTurns = [];
      } else {
        const answered = { items: [...answeredItems(pending ?? [], reply), ...replyItems], images: shots };
        nextTurns = [...turns, answered];
        if (nextTurns.length > CU_HISTORY_MAX_TURNS) nextTurns = nextTurns.slice(-CU_HISTORY_KEEP_TURNS);
      }
      input = [...nextOpening, ...nextTurns.flatMap((t) => t.items)];
      requestImages = nextOpeningImages + nextTurns.reduce((n, t) => n + t.images, 0);
    }
    if (requestImages > MAX_IMAGES_PER_REQUEST) {
      throw new DockhandError(
        "TOO_MANY_IMAGES",
        `computer-use request would hold ${requestImages} images (max ${MAX_IMAGES_PER_REQUEST}): roll over first`,
      );
    }

    // Recording is per session, turn by turn: the key comes from what is stable across runs (not pixels).
    tape ??= env.cassettes.tape(
      ctx.purpose,
      cassetteKey(ctx.purpose, { model: opts.model, instructions, functions, first: firstText(reply) }),
    );
    const sessionTape = tape;
    const chainFrom = !stateless && !newChain ? previousResponseId : undefined;
    const effort = effortFor(model, opts.effort, ctx.purpose);
    const scope = openScope(ctx);
    try {
      return await recordCall(
        env,
        {
          ctx,
          provider: sessionTape.replaying ? "cassette" : "meta",
          model,
          normalize: scope.normalize,
          price: (rec) => tokenCostUsd(model, rec.usage),
        },
        async (rec) => {
          rec.images = shots;
          const body = {
            model,
            instructions,
            tools,
            input,
            ...(effort !== undefined ? { reasoning: { effort } } : {}),
            ...(env.disableParallelToolCalls ? { parallel_tool_calls: false } : {}),
            store: !stateless,
            ...(chainFrom !== undefined ? { previous_response_id: chainFrom } : {}),
          };
          const raw = await sessionTape.next(
            () => post(env, body, chainFrom !== undefined, scope),
            reply.kind,
          );
          const resp = parseResponseBody(raw);
          rec.usage = responsesUsage(resp.usage);
          rec.responseId = resp.id;
          const parsed = parseCuTurns(resp);
          if (incompleteReason(resp) !== undefined) {
            // Nothing is advanced, so resending the same reply continues from the same state.
            rec.status = "incomplete";
            rec.errorCode = "MODEL_INCOMPLETE";
            return parsed;
          }
          if (stateless) {
            opening = nextOpening;
            openingImages = nextOpeningImages;
            turns = nextTurns;
            pending = resp.output.filter(isRecord).filter((item) => item.type !== "reasoning");
          } else {
            previousResponseId = resp.id;
            chainImages = requestImages;
          }
          return parsed;
        },
      );
    } finally {
      await sessionTape.save();
    }
  };

  return {
    imagesInChain: () => (stateless ? replayedImages() : chainImages),
    async send(reply, ctx) {
      try {
        return await sendOnce(reply, ctx);
      } catch (err) {
        if (slot.current === CU_FALLBACK_MODEL || !computerToolRefused(err)) throw err;
        env.log.warn("the API refused the computer tool for this model; switching computer use", {
          requested: slot.current,
          using: CU_FALLBACK_MODEL,
        });
        slot.current = CU_FALLBACK_MODEL;
        return sendOnce(reply, ctx);
      }
    },
  };
}

/**
 * The previous response's items to replay with our reply: its messages (phase kept, as the API reference
 * asks) and the one call this reply answers. Reasoning items are not replayed, and neither are other calls
 * of a parallel batch: the loop answers one call per turn, and an unanswered call in the input is an error.
 */
function answeredItems(output: Item[], reply: CuReply): Item[] {
  const callId = reply.kind === "computer_output" || reply.kind === "function_output" ? reply.callId : "";
  return output.filter((item) =>
    item.type === "computer_call" || item.type === "function_call"
      ? item.call_id === callId
      : item.type === "message",
  );
}

/** Input items for one reply, in the shapes of the computer-use and tool-calling pages. */
function replyInput(reply: CuReply, imageUrl: string | undefined): Item[] {
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
      // Live, a user input_image after the first turn is refused (HTTP 400 "native computer input images are
      // supported only in the initial request"), so a screenshot that follows a function call is not sent:
      // the output tells the model the screen changed, and its next screenshot action returns the image.
      return [
        {
          type: "function_call_output",
          call_id: reply.callId,
          output: reply.screenshot
            ? `${reply.output}
${SCREEN_CHANGED}`
            : reply.output,
        },
      ];
  }
}

async function post(env: GatewayEnv, body: Item, chained: boolean, scope: RequestScope) {
  try {
    return await withSlowRetry(env, scope, (s) => env.meta.postJson("/responses", body, s));
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

/**
 * Live, one computer-use turn in ~190 took 108 s (the p99 was ~21 s), and on the supplier wizard the same
 * request hung twice until the 90 s deadline. A turn request is idempotent (stateless replay, or a new response
 * off the same previous_response_id), so one that outlives env.computerUseSlowMs is abandoned and sent once
 * more; if that one is slow too, the turn fails fast with MODEL_TIMEOUT (the loop then starts a fresh
 * conversation) instead of waiting out the whole deadline.
 */
async function withSlowRetry<T>(
  env: GatewayEnv,
  scope: RequestScope,
  send: (s: RequestScope) => Promise<T>,
): Promise<T> {
  const slowMs = env.computerUseSlowMs;
  if (!(slowMs > 0) || scope.deadlineAt - Date.now() < slowMs * 2) return send(scope);
  for (let attempt = 1; ; attempt++) {
    const slow = AbortSignal.timeout(slowMs);
    try {
      return await send({
        signal: AbortSignal.any([scope.signal, slow]),
        deadlineAt: Math.min(scope.deadlineAt, Date.now() + slowMs),
      });
    } catch (err) {
      if (!slow.aborted || scope.signal.aborted) throw err;
      if (attempt >= 2) {
        throw new DockhandError("MODEL_TIMEOUT", `computer-use turn took over ${slowMs} ms twice`);
      }
      env.log.warn("computer-use turn is slow; sending it once more", { afterMs: slowMs });
    }
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

function toFunctionTool(f: FunctionTool): Item {
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

function isRecord(v: unknown): v is Item {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

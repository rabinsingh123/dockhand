import { type CallCtx, DockhandError, type Effort, type StructuredRequest } from "@dockhand/core";
import { type ZodType, z } from "zod";
import { openScope, recordCall } from "./call.ts";
import { cassetteKey } from "./cassette.ts";
import { chatUsage, openWeightsPrices, responsesUsage, type TokenUsage, tokenCostUsd } from "./cost.ts";
import type { GatewayEnv } from "./env.ts";
import type { RequestScope } from "./http.ts";
import {
  assertInputParts,
  buildChatUserContent,
  buildResponsesUserMessage,
  countImages,
  type Route,
  structuredKeyMaterial,
} from "./inputs.ts";
import { incompleteReason, outputText, parseResponseBody } from "./responses.ts";
import type { WireSchema } from "./schema.ts";

/** Baseten's default, stated explicitly: reasoning shares this budget. */
const DEFAULT_OPEN_WEIGHTS_MAX_TOKENS = 4096;
const MAX_ECHOED_REPLY_CHARS = 20_000;
const MAX_ERROR_CHARS = 2_000;

interface Attempt {
  text: string;
  refusal?: string;
  usage: TokenUsage;
  responseId?: string;
  incomplete?: string;
}

interface Previous {
  text: string;
  error: string;
}

interface StructuredRoute {
  provider: Route;
  send(previous: Previous | undefined): Promise<unknown>;
  read(raw: unknown): Attempt;
  price(usage: TokenUsage): number;
}

type Checked<T> = { ok: true; value: T } | { ok: false; text: string; error: string };

/**
 * One structured call: Meta's Responses API with text.format json_schema, or Baseten chat completions when
 * the model is the configured open-weights tag. Output is JSON-parsed and zod-validated; an invalid reply
 * gets one retry with the validation error appended, then MODEL_INVALID_OUTPUT. Every attempt is a ledger row.
 */
export async function runStructured<T>(env: GatewayEnv, req: StructuredRequest<T>, ctx: CallCtx): Promise<T> {
  const route: Route = req.model === env.config.openWeights.model ? "baseten" : "meta";
  assertInputParts(req.input, route);
  if (route === "baseten" && env.cassettes.mode !== "replay" && !env.config.openWeights.apiKey) {
    throw new DockhandError(
      "MODEL_ERROR",
      `${req.model} is the open-weights model but BASETEN_API_KEY is not set`,
    );
  }
  const wire = env.wireSchema(req.schema as ZodType);
  const tape = env.cassettes.tape(ctx.purpose, cassetteKey(ctx.purpose, structuredKeyMaterial(req)));
  const scope = openScope(ctx);
  const target = route === "meta" ? metaRoute(env, req, wire, scope) : basetenRoute(env, req, wire, scope);
  const images = countImages(req.input);

  let previous: Previous | undefined;
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const outcome = await recordCall(
        env,
        {
          ctx,
          provider: tape.replaying ? "cassette" : target.provider,
          model: req.model,
          normalize: scope.normalize,
          price: (rec) => target.price(rec.usage),
        },
        async (rec): Promise<Checked<T>> => {
          rec.images = images;
          const sent = previous;
          const reply = target.read(await tape.next(() => target.send(sent)));
          rec.usage = reply.usage;
          if (reply.responseId) rec.responseId = reply.responseId;
          if (reply.incomplete !== undefined) {
            throw new DockhandError(
              "MODEL_INCOMPLETE",
              `${req.schemaName}: output stopped early (${reply.incomplete})`,
            );
          }
          const checked = checkOutput(reply, wire, req.schema);
          if (!checked.ok) {
            rec.status = "error";
            rec.errorCode = "MODEL_INVALID_OUTPUT";
          }
          return checked;
        },
      );
      if (outcome.ok) return outcome.value;
      env.log.warn("structured output invalid", {
        purpose: ctx.purpose,
        model: req.model,
        schema: req.schemaName,
        attempt,
        error: outcome.error.slice(0, 500),
      });
      previous = { text: outcome.text, error: outcome.error };
    }
  } finally {
    await tape.save();
  }
  throw new DockhandError(
    "MODEL_INVALID_OUTPUT",
    `${req.schemaName}: output failed validation twice: ${previous?.error.slice(0, 1000) ?? ""}`,
    { schemaName: req.schemaName, model: req.model },
  );
}

function metaRoute<T>(
  env: GatewayEnv,
  req: StructuredRequest<T>,
  wire: WireSchema,
  scope: RequestScope,
): StructuredRoute {
  let userMessage: Promise<Record<string, unknown>> | undefined;
  const effort = effortFor(req.model, req.effort);
  return {
    provider: "meta",
    async send(previous) {
      userMessage ??= buildResponsesUserMessage(req.input, env, scope);
      return env.meta.postJson(
        "/responses",
        {
          model: req.model,
          instructions: req.instructions,
          input: [await userMessage, ...responsesCorrection(previous)],
          text: {
            format: {
              type: "json_schema",
              name: formatName(req.schemaName),
              schema: wire.schema,
              strict: false,
            },
          },
          ...(effort !== undefined ? { reasoning: { effort } } : {}),
          ...(req.maxOutputTokens !== undefined
            ? { max_output_tokens: Math.max(16, req.maxOutputTokens) }
            : {}),
          // Single-shot: nothing chains from it, and store=true can 413 on large inline media.
          store: false,
        },
        scope,
      );
    },
    read(raw) {
      const resp = parseResponseBody(raw);
      const { text, refusal } = outputText(resp);
      const incomplete = incompleteReason(resp);
      return {
        text,
        ...(refusal !== undefined ? { refusal } : {}),
        usage: responsesUsage(resp.usage),
        responseId: resp.id,
        ...(incomplete !== undefined ? { incomplete } : {}),
      };
    },
    price: (usage) => tokenCostUsd(req.model, usage),
  };
}

const ChatResponse = z.looseObject({
  id: z.string().optional(),
  choices: z
    .array(
      z.looseObject({
        message: z.looseObject({ content: z.string().nullish() }).optional(),
        finish_reason: z.string().nullish(),
      }),
    )
    .min(1),
  usage: z.unknown().optional(),
});

/**
 * Muse Spark Open on Baseten accepts json_schema but does not enforce it
 * (https://docs.baseten.co/inference/structured-outputs), so the schema also goes in the prompt and our
 * zod validation is the real check.
 */
function basetenRoute<T>(
  env: GatewayEnv,
  req: StructuredRequest<T>,
  wire: WireSchema,
  scope: RequestScope,
): StructuredRoute {
  let userContent: Promise<string | Record<string, unknown>[]> | undefined;
  const prices = openWeightsPrices(env.config.openWeights);
  return {
    provider: "baseten",
    async send(previous) {
      userContent ??= buildChatUserContent(req.input, env.artifacts);
      return env.baseten.postJson(
        "/chat/completions",
        {
          model: req.model,
          messages: [
            {
              role: "system",
              content: `${req.instructions}\n\nReply with only a JSON object (no prose, no code fences) that matches this JSON Schema:\n${JSON.stringify(wire.schema)}`,
            },
            { role: "user", content: await userContent },
            ...chatCorrection(previous),
          ],
          response_format: {
            type: "json_schema",
            json_schema: { name: formatName(req.schemaName), schema: wire.schema },
          },
          reasoning_effort: openWeightsEffort(req.effort),
          max_tokens: req.maxOutputTokens ?? DEFAULT_OPEN_WEIGHTS_MAX_TOKENS,
        },
        scope,
      );
    },
    read(raw) {
      const parsed = ChatResponse.safeParse(raw);
      if (!parsed.success)
        throw new DockhandError("MODEL_ERROR", "Baseten returned an unexpected chat completion body");
      const choice = parsed.data.choices[0];
      return {
        text: choice?.message?.content ?? "",
        usage: chatUsage(parsed.data.usage),
        ...(parsed.data.id !== undefined ? { responseId: parsed.data.id } : {}),
        ...(choice?.finish_reason === "length" ? { incomplete: "max_tokens" } : {}),
      };
    },
    price: (usage) => (prices ? tokenCostUsd(req.model, usage, prices) : 0),
  };
}

function checkOutput<T>(reply: Attempt, wire: WireSchema, schema: ZodType<T>): Checked<T> {
  if (reply.text.trim() === "") {
    return {
      ok: false,
      text: "",
      error: reply.refusal ? `the model refused: ${reply.refusal}` : "the reply was empty",
    };
  }
  let data: unknown;
  try {
    data = parseJsonReply(reply.text);
  } catch (err) {
    return { ok: false, text: reply.text, error: `the reply is not valid JSON (${(err as Error).message})` };
  }
  const result = schema.safeParse(wire.restoreOptional(data));
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, text: reply.text, error: z.prettifyError(result.error).slice(0, MAX_ERROR_CHARS) };
}

/** JSON.parse that tolerates a code fence or prose around one object (Baseten does not constrain output). */
export function parseJsonReply(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const body = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(body);
  } catch (err) {
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(body.slice(start, end + 1));
    throw err;
  }
}

function correctionText(error: string): string {
  return `Your previous reply did not satisfy the required JSON schema:\n${error.slice(0, MAX_ERROR_CHARS)}\nReply again with only the corrected JSON object.`;
}

function responsesCorrection(previous: Previous | undefined): Record<string, unknown>[] {
  if (!previous) return [];
  return [
    ...(previous.text
      ? [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: previous.text.slice(0, MAX_ECHOED_REPLY_CHARS) }],
          },
        ]
      : []),
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: correctionText(previous.error) }],
    },
  ];
}

function chatCorrection(previous: Previous | undefined): Record<string, unknown>[] {
  if (!previous) return [];
  return [
    ...(previous.text
      ? [{ role: "assistant", content: previous.text.slice(0, MAX_ECHOED_REPLY_CHARS) }]
      : []),
    { role: "user", content: correctionText(previous.error) },
  ];
}

/** text.format.name allows a-z, A-Z, 0-9, underscores and dashes, up to 64 characters. */
export function formatName(schemaName: string): string {
  return schemaName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "output";
}

/** Contributor mode has no "max" effort (https://dev.meta.ai/docs/reasoning). */
export function effortFor(model: string, effort: Effort | undefined): Effort | undefined {
  return effort === "max" && model.endsWith("-contributor") ? "xhigh" : effort;
}

/** Muse Spark Open takes low/medium/high/xhigh only; rung 2 defaults to low. */
export function openWeightsEffort(effort: Effort | undefined): "low" | "medium" | "high" | "xhigh" {
  if (effort === "medium" || effort === "high" || effort === "xhigh") return effort;
  return effort === "max" ? "xhigh" : "low";
}

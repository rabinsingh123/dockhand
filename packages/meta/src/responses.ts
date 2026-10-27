import { type CuAction, type CuTurn, DockhandError, type SafetyCheck } from "@dockhand/core";
import { z } from "zod";

/** The Response fields we read (https://dev.meta.ai/docs/api-reference/responses/schemas). */
const ResponseShape = z.looseObject({
  id: z.string(),
  status: z.string().optional(),
  output: z.array(z.unknown()).default([]),
  incomplete_details: z.looseObject({ reason: z.string().optional() }).nullish(),
  error: z.looseObject({ message: z.string().optional(), code: z.string().nullish() }).nullish(),
  usage: z.unknown().optional(),
});
export type ResponseBody = z.infer<typeof ResponseShape>;

export function parseResponseBody(raw: unknown): ResponseBody {
  const parsed = ResponseShape.safeParse(raw);
  if (!parsed.success)
    throw new DockhandError("MODEL_ERROR", "Responses API returned an unexpected body (no id/output)");
  if (parsed.data.status === "failed") {
    throw new DockhandError(
      "MODEL_ERROR",
      `response failed: ${parsed.data.error?.message ?? "no error message"}`,
      {
        code: parsed.data.error?.code ?? undefined,
      },
    );
  }
  return parsed.data;
}

export function incompleteReason(resp: ResponseBody): string | undefined {
  return resp.status === "incomplete" ? (resp.incomplete_details?.reason ?? "unknown") : undefined;
}

/**
 * Text of the assistant's answer: output_text parts of assistant messages, in order. Reasoning items (and
 * anything else that is not a message) are skipped, as are messages tagged phase "commentary".
 */
export function outputText(resp: ResponseBody): { text: string; refusal?: string } {
  const texts: string[] = [];
  const refusals: string[] = [];
  for (const item of resp.output) {
    const answer = answerOf(item);
    if (!answer) continue;
    if (answer.text) texts.push(answer.text);
    if (answer.refusal) refusals.push(answer.refusal);
  }
  return { text: texts.join("\n"), ...(refusals.length > 0 ? { refusal: refusals.join("\n") } : {}) };
}

function answerOf(item: unknown): { text: string; refusal?: string } | undefined {
  if (!isRecord(item) || item.type !== "message") return undefined;
  if (item.role !== undefined && item.role !== "assistant") return undefined;
  if (item.phase === "commentary") return undefined;
  const parts = Array.isArray(item.content) ? item.content : [];
  let text = "";
  let refusal: string | undefined;
  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (part.type === "output_text" && typeof part.text === "string") text += part.text;
    if (part.type === "refusal" && typeof part.refusal === "string") refusal = part.refusal;
  }
  return refusal === undefined ? { text } : { text, refusal };
}

// ---- computer use -----------------------------------------------------------------------------------

const Coord = z.number();
const ComputerAction = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("click"),
    x: Coord,
    y: Coord,
    button: z.enum(["left", "right", "wheel", "back", "forward"]).optional(),
  }),
  z.object({ type: z.literal("double_click"), x: Coord, y: Coord }),
  z.object({ type: z.literal("drag"), path: z.array(z.object({ x: Coord, y: Coord })) }),
  // The schema says an array of keys; a bare string is accepted and wrapped.
  z.object({
    type: z.literal("keypress"),
    keys: z.union([z.array(z.string()), z.string().transform((k) => [k])]),
  }),
  z.object({ type: z.literal("move"), x: Coord, y: Coord }),
  z.object({
    type: z.literal("scroll"),
    x: Coord,
    y: Coord,
    scroll_x: z.number().default(0),
    scroll_y: z.number().default(0),
  }),
  z.object({ type: z.literal("type"), text: z.string() }),
  z.object({ type: z.literal("screenshot") }),
  z.object({ type: z.literal("wait") }),
]);

/**
 * Output items in order: computer_call (a singular `action` becomes `actions`), function_call, and the
 * assistant's answer as `final`. Reasoning and commentary are skipped. An incomplete response yields only
 * `incomplete`: its partial items are not safe to act on and the caller resends its last reply. A completed
 * response with nothing actionable ends the loop like Meta's reference loop does (no computer_call = done).
 */
export function parseCuTurns(resp: ResponseBody): CuTurn[] {
  const reason = incompleteReason(resp);
  if (reason !== undefined) return [{ kind: "incomplete", reason }];
  const turns: CuTurn[] = [];
  for (const item of resp.output) {
    if (!isRecord(item)) continue;
    if (item.type === "computer_call") turns.push(computerCall(item));
    else if (item.type === "function_call") turns.push(functionCall(item));
    else {
      const answer = answerOf(item);
      if (answer) turns.push({ kind: "final", text: answer.text || answer.refusal || "" });
    }
  }
  return turns.length > 0 ? turns : [{ kind: "final", text: "" }];
}

function computerCall(item: Record<string, unknown>): CuTurn {
  const callId = requireCallId(item);
  const rawActions =
    Array.isArray(item.actions) && item.actions.length > 0 ? item.actions : item.action ? [item.action] : [];
  const actions = rawActions.map((a, i) => {
    const parsed = ComputerAction.safeParse(a);
    if (!parsed.success) {
      const type = isRecord(a) ? String(a.type) : typeof a;
      throw new DockhandError(
        "MODEL_INVALID_OUTPUT",
        `computer_call ${callId} action #${i + 1} (${type}) is not a known action`,
        {
          issues: z.prettifyError(parsed.error),
        },
      );
    }
    return parsed.data as CuAction;
  });
  const checks = Array.isArray(item.pending_safety_checks) ? item.pending_safety_checks : [];
  const safetyChecks: SafetyCheck[] = checks.filter(isRecord).map((c) => ({
    id: String(c.id ?? ""),
    code: typeof c.code === "string" ? c.code : "",
    message: typeof c.message === "string" ? c.message : "",
  }));
  return { kind: "computer_call", callId, actions, safetyChecks };
}

function functionCall(item: Record<string, unknown>): CuTurn {
  const name = item.name;
  if (typeof name !== "string" || name.length === 0) {
    throw new DockhandError("MODEL_INVALID_OUTPUT", "function_call without a name");
  }
  const args = item.arguments;
  return {
    kind: "function_call",
    callId: requireCallId(item),
    name,
    argsJson: typeof args === "string" ? args : JSON.stringify(args ?? {}),
  };
}

function requireCallId(item: Record<string, unknown>): string {
  if (typeof item.call_id !== "string" || item.call_id.length === 0) {
    throw new DockhandError("MODEL_INVALID_OUTPUT", `${String(item.type)} without a call_id`);
  }
  return item.call_id;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

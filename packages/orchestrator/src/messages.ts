// What the rep reads when something did not go to plan, and the small helpers that keep every card short:
// plain sentences, no step ids, no stack traces, no raw errors. Pure functions.

import type { ErrorCode, HealRung, Step, StepResult } from "@dockhand/core";
import { displayName, stepTarget } from "@dockhand/skills";

/** WhatsApp caps interactive bodies at 1024 characters; cards stay well under it. */
export const CARD_BODY_MAX = 1024;
const ITEM_MAX = 110;

/** Clip by code points (an emoji counts once), with an ellipsis. */
export function clipText(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max
    ? s
    : `${chars
        .slice(0, max - 1)
        .join("")
        .trimEnd()}…`;
}

/**
 * A card body: head lines, bullet items, tail lines. Items are clipped one by one, then dropped from the end
 * ("…and 3 more") until the body fits, so the instructions at the end are never cut off.
 */
export function cardBody(head: string[], items: string[], tail: string[], max = CARD_BODY_MAX): string {
  const clipped = items.map((i) => clipText(i, ITEM_MAX));
  const build = (n: number) =>
    [
      ...head,
      ...clipped.slice(0, n),
      ...(n < clipped.length ? [`• …and ${clipped.length - n} more`] : []),
      ...tail,
    ].join("\n");
  for (let n = clipped.length; n >= 0; n--) {
    const body = build(n);
    if ([...body].length <= max) return body;
  }
  return clipText(build(0), max);
}

/** A rep can stop a pending request by typing one of these on their own. */
const CANCEL_WORDS = /^(cancel|cancelar|cancela|cancele|stop|parar|pare|para|não|nao|no|nope)[.!]*$/i;

export function isCancelText(text: string | undefined): boolean {
  return CANCEL_WORDS.test((text ?? "").trim());
}

/** At a question card, these skip the question (stop safely); "no" stays a possible answer there. */
const SKIP_WORDS = /^(skip|pular|pula|cancel|cancelar|cancela|stop|parar)[.!]*$/i;

export function isSkipText(text: string | undefined): boolean {
  return SKIP_WORDS.test((text ?? "").trim());
}

/** The intake failed (download, transcription, reading a document, understanding). */
export function intakeFailure(code: ErrorCode | undefined): string {
  const why =
    code === "MEDIA_UNSUPPORTED"
      ? "I couldn't open that file"
      : code === "MODEL_TIMEOUT"
        ? "reading it took too long"
        : code === "MODEL_ERROR" || code === "MODEL_INVALID_OUTPUT" || code === "MODEL_INCOMPLETE"
          ? "I couldn't make sense of it"
          : "something on my side failed";
  return `Sorry, ${why}. Nothing was written. Try sending it again.`;
}

/** A run stopped before submitting. `error` is the runner's "s7 (Fill 'City'): detail" text. */
export function stopReason(
  portal: string,
  code: ErrorCode | string | undefined,
  error: string | undefined,
): string {
  const m = /^s\d+ \((.*?)\): (.*)$/s.exec(error ?? "");
  const step = m?.[1];
  const detail = m?.[2] ?? error ?? "";
  const quoted = step ? ` ("${step}")` : "";
  switch (code) {
    case "PORTAL_VALIDATION": {
      const said = detail.replace(/^still refused after asking the rep: /, "");
      return said && said !== "the page reported a validation error"
        ? `${portal} refused the form: "${clipText(said, 160)}"`
        : `${portal} refused the form`;
    }
    case "READBACK_MISMATCH":
      return `a field didn't keep the value I entered (${clipText(detail, 160)})`;
    case "NEEDS_INPUT": {
      const label = /requires '([^']+)'/.exec(detail)?.[1];
      return label
        ? `${portal} now needs "${label}" and I have no answer for it`
        : `${portal} needs information I don't have`;
    }
    case "STEP_NOT_FOUND":
    case "STEP_AMBIGUOUS":
    case "STEP_TIMEOUT":
    case "ASSERT_FAILED":
      return `${portal} changed and I couldn't repair a step${quoted}`;
    case "WRITE_BLOCKED":
      return `the page tried to save before the submit step, so I blocked it`;
    case "BUDGET_EXCEEDED":
      return "it took more actions than one run is allowed";
    case "MODEL_TIMEOUT":
      return "the model didn't answer in time";
    case "MODEL_ERROR":
    case "MODEL_INCOMPLETE":
    case "MODEL_INVALID_OUTPUT":
      return "the model call failed";
    default:
      return `something on my side failed${quoted}`;
  }
}

/** A first run ended without submitting; `message` is the loop's or the model's reason. */
export function firstRunStop(message: string | undefined, budget: boolean): string {
  if (budget) return "it took more actions than one run is allowed";
  const said = (message ?? "").replace(/^BLOCKED:\s*/i, "").trim();
  if (!said || /script error|^unknown$/i.test(said)) return "it ended without submitting";
  return clipText(said.charAt(0).toLowerCase() + said.slice(1), 200).replace(/[.\s]+$/, "");
}

const RUNG_GROUP: Record<HealRung, string> = {
  fallback: "found again for free",
  similarity: "matched for free",
  open_weights: "by Muse Spark Open",
  computer_use: "by Muse computer use",
  ask_rep: "from your answer",
};
const RUNG_ORDER: HealRung[] = ["fallback", "similarity", "open_weights", "computer_use", "ask_rep"];

/**
 * Repairs grouped by rung, cheapest first, with what changed for the rungs that found something new:
 * "12 steps repaired: 10 found again for free, 2 by Muse Spark Open ('Product' → 'Solution', …)".
 * Null when nothing was repaired.
 */
export function repairSummary(results: StepResult[], before: Step[], after: Step[]): string | null {
  const healed = results.filter((s) => s.rung);
  if (healed.length === 0) return null;
  const nameOf = (steps: Step[], id: string): string | undefined => {
    const step = steps.find((s) => s.id === id);
    const target = step ? stepTarget(step) : undefined;
    return target ? displayName(target.fingerprint) : undefined;
  };
  const parts = RUNG_ORDER.flatMap((rung) => {
    const group = healed.filter((s) => s.rung === rung);
    if (group.length === 0) return [];
    const changes =
      rung === "fallback"
        ? []
        : group.flatMap((s) => {
            const was = nameOf(before, s.stepId);
            const now = nameOf(after, s.stepId);
            if (was && now && was !== now) return [`'${was}' → '${now}'`];
            return !was && now ? [`'${now}'`] : [];
          });
    return [`${group.length} ${RUNG_GROUP[rung]}${changes.length ? ` (${changes.join(", ")})` : ""}`];
  });
  return `${healed.length} step${healed.length === 1 ? "" : "s"} repaired: ${parts.join(", ")}`;
}

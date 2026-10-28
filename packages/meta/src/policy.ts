import type { Effort, Purpose } from "@dockhand/core";

/**
 * Reasoning effort per purpose when the caller sets none. Without a `reasoning` field the API runs at
 * "high" and, for structured calls, can spend the whole output budget on reasoning. Measured live
 * (docs/research/meta-api-notes.md, "Verified live"):
 * - extract / understand: low got every graded field right on the fixtures (minimal did too, at roughly half
 *   the latency, but low keeps headroom for handwriting and date arithmetic). ~1k reasoning tokens, 3-6 s.
 * - teach: medium on Muse Wonder graded clean on the Caravela recording (1k reasoning, 20 s).
 * - compile_annotate: low (a text-only labelling job; the code verifies everything the model proposes).
 * - cu_first_run / cu_repair: low. Per-turn reasoning stays under ~300 tokens; turn latency is dominated by
 *   the request, not by reasoning, and higher effort did not fix any failure seen live.
 * - heal_match: low (Muse Spark Open's own default for rung 2).
 */
export const DEFAULT_EFFORT: Readonly<Record<Purpose, Effort>> = Object.freeze({
  transcribe: "low", // not sent: Voice Transcribe has no reasoning
  extract: "low",
  understand: "low",
  teach: "medium",
  compile_annotate: "low",
  cu_first_run: "low",
  heal_match: "low",
  cu_repair: "low",
});

/**
 * Reasoning and the answer share max_output_tokens, so a budget sized for the answer alone ends in
 * status "incomplete" with every token spent on reasoning (seen live: 300 tokens at low effort, 298 of
 * them reasoning). The budget actually sent is never below this floor for the effort in use.
 */
export const MIN_OUTPUT_TOKENS: Readonly<Record<Effort, number>> = Object.freeze({
  minimal: 2_048,
  low: 4_096,
  medium: 8_192,
  high: 16_384,
  xhigh: 32_768,
  max: 32_768,
});

/** The one retry after "incomplete: max_output_tokens" doubles the budget, up to this. */
export const MAX_OUTPUT_TOKENS_CAP = 32_768;

/** Effort to send: the caller's, else the purpose default; contributor models have no "max". */
export function effortFor(model: string, effort: Effort | undefined, purpose?: Purpose): Effort | undefined {
  const chosen = effort ?? (purpose ? DEFAULT_EFFORT[purpose] : undefined);
  return chosen === "max" && model.endsWith("-contributor") ? "xhigh" : chosen;
}

/** max_output_tokens to send: the caller's budget (or none), lifted to the reasoning floor of the effort. */
export function outputBudget(requested: number | undefined, effort: Effort | undefined): number | undefined {
  if (effort === undefined) return requested === undefined ? undefined : Math.max(16, requested);
  return Math.max(requested ?? 0, MIN_OUTPUT_TOKENS[effort]);
}

/** The budget for the single retry after an incomplete response. */
export function grownBudget(sent: number | undefined, effort: Effort | undefined): number {
  const base = sent ?? MIN_OUTPUT_TOKENS[effort ?? "medium"];
  return Math.min(MAX_OUTPUT_TOKENS_CAP, Math.max(base * 2, base + 2_048));
}

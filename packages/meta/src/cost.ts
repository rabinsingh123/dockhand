import { costOf, PRICES, type PriceTable } from "@dockhand/core";
import type { MetaConfig } from "./config.ts";

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  /** Includes reasoning tokens (both APIs count them inside output). */
  outputTokens: number;
  reasoningTokens?: number;
}

export const ZERO_USAGE: Readonly<TokenUsage> = Object.freeze({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
});

/** Reported costs use Standard list price, so a Contributor-mode call is priced as its Standard model. */
export function standardPriceModel(model: string): string {
  const suffix = "-contributor";
  return model.endsWith(suffix) ? model.slice(0, -suffix.length) : model;
}

export function tokenCostUsd(model: string, usage: TokenUsage, prices: PriceTable = PRICES): number {
  return costOf(standardPriceModel(model), usage, prices);
}

/** Voice Transcribe bills the audio processed, rounded down to whole seconds (dev.meta.ai/docs/speech-to-text). */
export function audioCostUsd(model: string, audioMs: number, prices: PriceTable = PRICES): number {
  const billedMs = Math.floor(audioMs / 1000) * 1000;
  return costOf(model, { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, audioMs: billedMs }, prices);
}

/**
 * Price table for the open-weights model from OPEN_WEIGHTS_PRICE_IN/OUT, or undefined while either is unset.
 * The env carries no cached-input price, so cached tokens are charged at the input price (never under-reports).
 */
export function openWeightsPrices(ow: MetaConfig["openWeights"]): PriceTable | undefined {
  if (ow.priceInPerM === undefined || ow.priceOutPerM === undefined) return undefined;
  return { [ow.model]: { inPerM: ow.priceInPerM, outPerM: ow.priceOutPerM, cachedPerM: ow.priceInPerM } };
}

/** Responses API usage: input_tokens, input_tokens_details.cached_tokens, output_tokens(_details.reasoning_tokens). */
export function responsesUsage(raw: unknown): TokenUsage {
  const u = asRecord(raw);
  if (!u) return { ...ZERO_USAGE };
  const reasoning = num(asRecord(u.output_tokens_details)?.reasoning_tokens);
  return {
    inputTokens: num(u.input_tokens) ?? 0,
    cachedInputTokens: num(asRecord(u.input_tokens_details)?.cached_tokens) ?? 0,
    outputTokens: num(u.output_tokens) ?? 0,
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
  };
}

/** Chat Completions usage (Baseten): prompt_tokens(_details.cached_tokens), completion_tokens(_details.reasoning_tokens). */
export function chatUsage(raw: unknown): TokenUsage {
  const u = asRecord(raw);
  if (!u) return { ...ZERO_USAGE };
  const reasoning = num(asRecord(u.completion_tokens_details)?.reasoning_tokens);
  return {
    inputTokens: num(u.prompt_tokens) ?? 0,
    cachedInputTokens: num(asRecord(u.prompt_tokens_details)?.cached_tokens) ?? 0,
    outputTokens: num(u.completion_tokens) ?? 0,
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
  };
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

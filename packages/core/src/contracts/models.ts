import type { ZodType } from "zod";
import type { ArtifactRef, ErrorCode, Id } from "./base.ts";

export type ModelId =
  | "muse-spark-1.3"
  | "muse-spark-1.3-contributor"
  | "muse-wonder-1.0"
  | "muse-voice-transcribe-1.0"
  | (string & {}); // e.g. the open-weights tag "meta-models/muse-spark-open-1026"

export type Effort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type Purpose =
  | "transcribe"
  | "extract" // vision over photos and PDFs
  | "understand" // message -> Understanding
  | "teach" // video -> SkillDraft
  | "compile_annotate" // Spark writes param names, step intents and the success check for a compiled skill
  | "cu_first_run"
  | "heal_match" // rung 2: open weights picks the element from a pruned accessibility list
  | "cu_repair"; // rung 3

export type Provider = "meta" | "baseten" | "fake" | "cassette" | "scripted";

export interface CallCtx {
  purpose: Purpose;
  jobId?: Id;
  runId?: Id;
  stepIdx?: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export type InputPart =
  | { type: "text"; text: string }
  | { type: "image"; image: ArtifactRef }
  | { type: "pdf"; file: ArtifactRef }
  | { type: "video"; video: ArtifactRef; fps?: number }; // mp4 only; uploaded via the Files API

export interface StructuredRequest<T> {
  /** A Meta model id, or the configured open-weights model tag (routed to Baseten). */
  model: ModelId;
  instructions: string;
  input: InputPart[];
  schemaName: string;
  schema: ZodType<T>; // converted with z.toJSONSchema; must be non-recursive and flat where possible
  effort?: Effort;
  maxOutputTokens?: number;
}

export interface Transcript {
  text: string;
  turns: { startMs: number; endMs: number; text: string }[];
  audioMs: number;
}

/** JSON-schema function tool offered next to the computer tool. */
export interface FunctionTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelGateway {
  /** Output is zod-validated; one retry on invalid output, then MODEL_INVALID_OUTPUT. */
  structured<T>(req: StructuredRequest<T>, ctx: CallCtx): Promise<T>;
  transcribe(
    wav: ArtifactRef,
    opts: { languageBias?: string[]; keywords?: string[] },
    ctx: CallCtx,
  ): Promise<Transcript>;
  computerUse(opts: { model: ModelId; effort?: Effort }): ComputerUseModel;
  /** True when an open-weights provider is configured (rung 2 is skipped otherwise). */
  hasOpenWeights(): boolean;
}

// ---- Computer-use wire contract (implemented by meta: live/cassette; by browser: scripted) ----

export type CuAction =
  | { type: "click"; x: number; y: number; button?: "left" | "right" | "wheel" | "back" | "forward" }
  | { type: "double_click"; x: number; y: number }
  | { type: "drag"; path: { x: number; y: number }[] }
  | { type: "keypress"; keys: string[] }
  | { type: "move"; x: number; y: number }
  | { type: "scroll"; x: number; y: number; scroll_x: number; scroll_y: number }
  | { type: "type"; text: string }
  | { type: "screenshot" }
  | { type: "wait" };

export interface SafetyCheck {
  id: string;
  code: string;
  message: string;
}

/** One response can hold several output items. A singular `action` on the wire is normalized to `actions`. */
export type CuTurn =
  | { kind: "computer_call"; callId: string; actions: CuAction[]; safetyChecks: SafetyCheck[] }
  | { kind: "function_call"; callId: string; name: string; argsJson: string }
  | { kind: "final"; text: string }
  | { kind: "incomplete"; reason: string };

export type CuReply =
  | { kind: "start"; task: string; screenshot: Uint8Array }
  | { kind: "computer_output"; callId: string; screenshot: Uint8Array; acknowledged: SafetyCheck[] }
  | { kind: "function_output"; callId: string; output: string; screenshot?: Uint8Array }
  /** Starts a fresh response chain (50-images-per-request cap). */
  | { kind: "rollover"; summary: string; screenshot: Uint8Array };

export interface CuSession {
  /** Owns previous_response_id and store:true. Returns the response's output items in order. */
  send(reply: CuReply, ctx: CallCtx): Promise<CuTurn[]>;
  imagesInChain(): number;
}

export interface ComputerUseModel {
  readonly provider: Provider;
  readonly model: string;
  open(opts: { instructions: string; functions: FunctionTool[] }): CuSession;
}

// ---- Ledger: written inside meta (and by the scripted model); callers never record manually ----

export interface ModelCallRecord {
  purpose: Purpose;
  provider: Provider;
  model: string;
  jobId?: Id;
  runId?: Id;
  stepIdx?: number;
  responseId?: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  images: number;
  audioMs?: number;
  latencyMs: number;
  costUsd: number; // at Standard list price; never contributor pricing in reported numbers
  status: "ok" | "error" | "timeout" | "incomplete";
  errorCode?: ErrorCode;
}

export interface Ledger {
  record(r: ModelCallRecord): void;
  totals(f: { jobId?: Id; runId?: Id; purposes?: Purpose[] }): {
    calls: number;
    costUsd: number;
    latencyMs: number;
  };
}

export type PriceTable = Record<
  string,
  { inPerM: number; outPerM: number; cachedPerM: number } | { perAudioHour: number }
>;

/** Standard list prices from dev.meta.ai/docs/pricing-rate-limits (2026-10-27). Baseten price: fill in once known. */
export const PRICES: PriceTable = {
  "muse-wonder-1.0": { inPerM: 4.0, outPerM: 20.0, cachedPerM: 0.2 },
  "muse-spark-1.3": { inPerM: 1.25, outPerM: 4.25, cachedPerM: 0.15 },
  "muse-spark-1.3-contributor": { inPerM: 0.1, outPerM: 0.2, cachedPerM: 0.002 },
  "muse-voice-transcribe-1.0": { perAudioHour: 0.18 },
};

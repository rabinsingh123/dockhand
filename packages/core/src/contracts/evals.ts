import type { ErrorCode, Id } from "./base.ts";
import type { ParamValue } from "./browser.ts";
import type { HealRung, RunResult } from "./skills.ts";

/** Per-browser-context portal configuration (set via the portal's session cookie). */
export interface PortalSession {
  ui: "v1" | "v2";
  mutation: { seed: number; operators?: string[] } | null;
  runId: Id;
}

export type EvalSuite = "replay" | "mutation" | "repair" | "agentic" | "ablation";

export interface EvalCase {
  id: string;
  suite: EvalSuite;
  skill: string;
  version: number;
  portalId: string;
  tenant?: string;
  portal: PortalSession;
  /** Expected category of the injected change, from the portal's operator list. */
  expectedCategory?: "heal_deterministic" | "heal_deterministic_or_model" | "heal_model" | "must_fail_safe";
  params: Record<string, ParamValue>;
  expected: Record<string, string>; // canonical submission fields, normalized
}

export interface EvalResult {
  caseId: string;
  suite: EvalSuite;
  ok: boolean; // all expected fields correct in the ground-truth submission (or a correct safe stop)
  outcome: RunResult["outcome"];
  fields: {
    correct: number;
    total: number;
    mismatches: { field: string; expected: string; actual: string }[];
  };
  /** Wrote a submission with at least one wrong field. The number that must stay at 0. */
  silentWrong: boolean;
  safeStop: boolean; // stopped without writing, as required for must_fail_safe cases
  heals: { rung: HealRung; count: number }[];
  ms: number;
  execCostUsd: number;
  modelCalls: number;
  provider: "meta" | "baseten" | "scripted" | "none";
  errorCode?: ErrorCode;
}

// Canary dry-runs: a candidate skill version replays to the commit boundary (never clicking it) with several
// param sets before it is activated. Nothing is written; every run reads back what it entered.

import type {
  ArtifactStore,
  ErrorCode,
  ParamValue,
  RunResult,
  Skill,
  WriteGuardConfig,
} from "@dockhand/core";
import type { Page } from "playwright";
import { runSkill } from "./runner.ts";

export interface CanaryOptions {
  artifacts: ArtifactStore;
  stepTimeoutMs?: number;
  /** Similarity heals during a canary. Default false: a patched skill should not need healing. */
  allowFallbackHeal?: boolean;
  /** A run passes only if every step resolved as stored (no heal). Default true. */
  strict?: boolean;
  runIdFor?: (i: number) => string;
  writeGuard?: WriteGuardConfig;
}

export interface CanaryFailure {
  index: number;
  params: Record<string, ParamValue>;
  outcome: RunResult["outcome"];
  errorCode?: ErrorCode;
  error?: string;
  /** Steps that did not resolve as stored ("s9 healed (fallback)", "s17 failed"). */
  steps: string[];
}

export interface CanaryResult {
  passed: number;
  total: number;
  failures: CanaryFailure[];
}

/** Dry-runs `skill` once per param set, each on a page from `newPage` (closed afterwards). */
export async function runCanary(
  newPage: () => Promise<Page>,
  skill: Skill,
  paramSets: Record<string, ParamValue>[],
  opts: CanaryOptions,
): Promise<CanaryResult> {
  const failures: CanaryFailure[] = [];
  let passed = 0;
  for (const [i, params] of paramSets.entries()) {
    const page = await newPage();
    try {
      const r = await runSkill(
        page,
        skill,
        params,
        { approveCommit: async () => "rejected", approveSafety: async () => "rejected" },
        {
          runId: opts.runIdFor?.(i) ?? `canary-${skill.name}-v${skill.version}-${i}`,
          stepTimeoutMs: opts.stepTimeoutMs ?? 4000,
          screenshots: "fail_only",
          allowFallbackHeal: opts.allowFallbackHeal ?? false,
          dryRun: true,
          artifacts: opts.artifacts,
          ...(opts.writeGuard ? { writeGuard: opts.writeGuard } : {}),
        },
      );
      const off = r.steps
        .filter((s) => s.status !== "ok" && s.status !== "skipped")
        .map((s) => `${s.stepId} ${s.status}${s.rung ? ` (${s.rung})` : ""}`);
      if (r.outcome === "dry_run_ok" && (opts.strict === false || off.length === 0)) {
        passed++;
      } else {
        failures.push({
          index: i,
          params,
          outcome: r.outcome,
          ...(r.errorCode ? { errorCode: r.errorCode } : {}),
          ...(r.error ? { error: r.error } : {}),
          steps: off,
        });
      }
    } finally {
      await page.close().catch(() => {});
    }
  }
  return { passed, total: paramSets.length, failures };
}

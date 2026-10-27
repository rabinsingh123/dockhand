// Every eval path is resolved from the workspace root, never from cwd.

import { join } from "node:path";
import { varDir, workspaceRoot } from "@dockhand/core";

/** var/evals: cached bootstrap skills, browser state, failure screenshots. */
export function evalsVarDir(): string {
  return join(varDir(), "evals");
}

export function skillCacheDir(): string {
  return join(evalsVarDir(), "skills");
}

/** Per-eval ledger and artifact index (separate from the app's var/dockhand.sqlite). */
export function evalsDbPath(): string {
  return join(varDir(), "evals.sqlite");
}

/** evals/results: raw JSONL (git-ignored), summary.json, summary.md and the chart PNGs. */
export function resultsDir(): string {
  return join(workspaceRoot(), "evals", "results");
}

/** A path inside the repo, given POSIX-relative to the workspace root ("fixtures/docs/w9-sample.pdf"). */
export function repoPath(rel: string): string {
  return join(workspaceRoot(), ...rel.split("/"));
}

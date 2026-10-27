// Job state machine (docs/reviews/architect-review.md §3.6). Pure: persistence with compare-and-set
// lives in repo.ts, which also logs every rejected transition as a job_events row (accepted = 0).

import type { JobEvent, JobStatus } from "@dockhand/core";

export type TransitionResult = { ok: true; next: JobStatus } | { ok: false; reason: string };

export const JOB_STATUSES: readonly JobStatus[] = [
  "received",
  "understanding",
  "awaiting_input",
  "awaiting_approval",
  "executing",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
];

const TERMINAL: ReadonlySet<JobStatus> = new Set(["succeeded", "failed", "cancelled", "expired"]);

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL.has(status);
}

/**
 * The table from §3.6, plus one row the table lacks: `understanding --finished(ok=false)--> failed`,
 * so a failed download, transcription or understanding call ends the job honestly instead of
 * pretending it was understood.
 */
export function transition(status: JobStatus, event: JobEvent): TransitionResult {
  if (TERMINAL.has(status)) return reject(status, event, "job is already finished");
  if (event.type === "cancel") return { ok: true, next: "cancelled" };
  if (event.type === "crash_recovered") return { ok: true, next: "failed" };

  switch (status) {
    case "received":
      if (event.type === "start") return { ok: true, next: "understanding" };
      break;
    case "understanding":
      if (event.type === "understood") {
        if (event.missing.length > 0) return { ok: true, next: "awaiting_input" };
        return { ok: true, next: event.writes ? "awaiting_approval" : "executing" };
      }
      if (event.type === "finished" && !event.ok) return { ok: true, next: "failed" };
      break;
    case "awaiting_input":
      if (event.type === "input") return { ok: true, next: "understanding" };
      break;
    case "awaiting_approval":
      if (event.type === "gate_resolved") {
        switch (event.decision) {
          case "approved":
            return { ok: true, next: "executing" };
          case "rejected":
            return { ok: true, next: "cancelled" };
          case "edit":
            return { ok: true, next: "awaiting_input" };
          case "expired":
            return { ok: true, next: "expired" };
        }
      }
      break;
    case "executing":
      if (event.type === "gate_open") return { ok: true, next: "awaiting_approval" };
      if (event.type === "finished") return { ok: true, next: event.ok ? "succeeded" : "failed" };
      break;
  }
  return reject(status, event, "not allowed in this state");
}

function reject(status: JobStatus, event: JobEvent, why: string): TransitionResult {
  return { ok: false, reason: `${event.type} from ${status}: ${why}` };
}

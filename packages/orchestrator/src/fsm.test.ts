import type { Decision, JobEvent, JobStatus } from "@dockhand/core";
import { describe, expect, it } from "vitest";
import { isTerminal, JOB_STATUSES, transition } from "./fsm.ts";

const DECISIONS: Decision[] = ["approved", "rejected", "edit", "expired"];

/** One representative of every event shape (both branches of the boolean ones). */
const EVENTS: JobEvent[] = [
  { type: "start" },
  { type: "understood", missing: ["seats"], writes: true },
  { type: "understood", missing: [], writes: true },
  { type: "understood", missing: [], writes: false },
  { type: "input", waId: "wamid.1" },
  { type: "gate_open", gateId: "G1" },
  ...DECISIONS.map((decision): JobEvent => ({ type: "gate_resolved", gateId: "G1", decision })),
  { type: "finished", ok: true },
  { type: "finished", ok: false, errorCode: "STEP_NOT_FOUND" },
  { type: "cancel" },
  { type: "crash_recovered" },
];

const key = (s: JobStatus, e: JobEvent) => `${s} + ${JSON.stringify(e)}`;

/** The §3.6 table, expanded per event shape. Everything not listed must be rejected. */
const ALLOWED = new Map<string, JobStatus>();
const allow = (s: JobStatus, e: JobEvent, next: JobStatus) => ALLOWED.set(key(s, e), next);
allow("received", { type: "start" }, "understanding");
allow("understanding", { type: "understood", missing: ["seats"], writes: true }, "awaiting_input");
allow("understanding", { type: "understood", missing: [], writes: true }, "awaiting_approval");
allow("understanding", { type: "understood", missing: [], writes: false }, "executing");
allow("understanding", { type: "finished", ok: false, errorCode: "STEP_NOT_FOUND" }, "failed");
allow("awaiting_input", { type: "input", waId: "wamid.1" }, "understanding");
allow("awaiting_approval", { type: "gate_resolved", gateId: "G1", decision: "approved" }, "executing");
allow("awaiting_approval", { type: "gate_resolved", gateId: "G1", decision: "rejected" }, "cancelled");
allow("awaiting_approval", { type: "gate_resolved", gateId: "G1", decision: "edit" }, "awaiting_input");
allow("awaiting_approval", { type: "gate_resolved", gateId: "G1", decision: "expired" }, "expired");
allow("executing", { type: "gate_open", gateId: "G1" }, "awaiting_approval");
allow("executing", { type: "finished", ok: true }, "succeeded");
allow("executing", { type: "finished", ok: false, errorCode: "STEP_NOT_FOUND" }, "failed");
for (const s of JOB_STATUSES) {
  if (isTerminal(s)) continue;
  allow(s, { type: "cancel" }, "cancelled");
  allow(s, { type: "crash_recovered" }, "failed");
}

describe("transition", () => {
  for (const status of JOB_STATUSES) {
    for (const event of EVENTS) {
      const expected = ALLOWED.get(key(status, event));
      it(`${status} --${event.type}${describeEvent(event)}--> ${expected ?? "rejected"}`, () => {
        const result = transition(status, event);
        if (expected) expect(result).toEqual({ ok: true, next: expected });
        else {
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.reason).toContain(event.type);
        }
      });
    }
  }

  it("covers every row of the table", () => {
    // 13 explicit rows plus cancel and crash_recovered from each of the 5 non-terminal states.
    expect(ALLOWED.size).toBe(13 + 5 * 2);
  });

  it("treats the four end states as terminal", () => {
    expect(JOB_STATUSES.filter(isTerminal)).toEqual(["succeeded", "failed", "cancelled", "expired"]);
  });
});

function describeEvent(e: JobEvent): string {
  if (e.type === "understood") return `(missing=${e.missing.length}, writes=${e.writes})`;
  if (e.type === "gate_resolved") return `(${e.decision})`;
  if (e.type === "finished") return `(ok=${e.ok})`;
  return "";
}

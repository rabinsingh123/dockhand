// Progress summary for a session rollover, written by the harness from the trace (never by the model).

import type { CuRunInput, TraceStep } from "@dockhand/core";

const MAX_STEPS = 30;

function targetName(step: TraceStep): string {
  const fp = step.target?.fingerprint;
  return fp?.label || fp?.name || fp?.text || fp?.placeholder || fp?.tag || "the page";
}

/** One line per meaningful step; noise and blocked attempts are left out. */
export function describeStep(step: TraceStep): string | null {
  if (step.tags.includes("noise")) return null;
  const a = step.action;
  if (step.tags.includes("blocked"))
    return `tried to submit with "${targetName(step)}" (blocked: no approval yet)`;
  switch (a.type) {
    case "click":
    case "double_click":
      return step.tags.includes("option") ? `chose "${targetName(step)}"` : `clicked "${targetName(step)}"`;
    case "type":
      return step.target ? `typed "${a.text}" into "${targetName(step)}"` : `typed "${a.text}"`;
    case "keypress":
      return `pressed ${a.keys.join("+")}`;
    case "drag":
      return `dragged "${targetName(step)}"`;
    case "fn":
      if (a.name === "attach_file")
        return `attached file slot "${(a.args as { slot?: string }).slot ?? "?"}"`;
      if (a.name === "request_commit") return "asked for approval to submit";
      return null;
    default:
      return null;
  }
}

export interface RolloverState {
  url: string;
  heading: string;
  form: Record<string, string>;
  commitApproved: boolean;
  attachedSlots: string[];
  note?: string;
}

/** Task text for a fresh response chain: what is done, where we are, what remains. */
export function rolloverSummary(
  input: Pick<CuRunInput, "goal" | "params">,
  steps: TraceStep[],
  s: RolloverState,
): string {
  const done = steps.map(describeStep).filter((x): x is string => x !== null);
  const recent = done.slice(-MAX_STEPS);
  const filled = Object.entries(s.form).filter(([, v]) => v !== "" && v !== "false");
  const shown = Object.values(s.form).map((v) => v.toLowerCase());
  const remaining = Object.entries(input.params).filter(([, v]) => {
    if (typeof v === "object") return false;
    const text = String(v).toLowerCase();
    return !shown.some((f) => f.includes(text));
  });
  const lines = [
    "You are continuing a task in a new session (the earlier one reached its screenshot limit).",
    `Goal: ${input.goal}`,
    "",
    `Done so far (${done.length} actions${done.length > recent.length ? `, last ${recent.length} listed` : ""}):`,
    ...(recent.length ? recent.map((d) => `- ${d}`) : ["- nothing yet"]),
    "",
    `Current page: ${s.url}${s.heading ? ` ("${s.heading}")` : ""}`,
  ];
  if (filled.length > 0) lines.push("Fields filled on this page:", ...filled.map(([k, v]) => `- ${k}: ${v}`));
  if (remaining.length > 0) {
    lines.push("Values not yet visible on this page:", ...remaining.map(([k, v]) => `- ${k}: ${String(v)}`));
  }
  if (s.attachedSlots.length > 0) lines.push(`Files attached: ${s.attachedSlots.join(", ")}.`);
  lines.push(
    s.commitApproved
      ? "Submitting was approved: click the submit control now."
      : "Submitting has not been approved yet: call request_commit before submitting.",
  );
  if (s.note) lines.push(s.note);
  lines.push("Continue from the screenshot below.");
  return lines.join("\n");
}

// Drift watch: automation that maintains itself. Per active skill, a dry-run replay with synthetic values on a
// fresh page, up to the commit step only (the runner stops before it and the write guard holds every write, so
// nothing is ever submitted).
// - Every step resolves and reads back: the run is recorded as verified and the rep hears nothing.
// - Steps broke: the whole ladder repairs them (free rungs, Muse Spark Open, computer use), 5 canary dry runs check the fix, v(n+1) goes
//   live (older versions kept) and the rep gets one card with Roll back and Details buttons.
// - The page needs something new (a required field): the rep is asked once, and the answer becomes the new
//   param's default, so the next real request fills it without asking.
// - It cannot be healed safely: one line; the next real request tries again before anything is submitted.

import { runComputerUse } from "@dockhand/browser";
import {
  type ArtifactRef,
  type HealRung,
  type ParamValue,
  type Repairer,
  type RunResult,
  type Skill,
  type SkillBody,
  type StepResult,
  ulid,
} from "@dockhand/core";
import { createCuRepairer, createOpenWeightsRepairer, rebaseSkill, runSkill } from "@dockhand/skills";
import { repairSummary } from "../messages.ts";
import { FILE_SLOTS, syntheticParamSets } from "../params.ts";
import { writeGuardFor } from "../portals.ts";
import type { CompanyKit } from "../profile.ts";
import { diffPhoneCardHtml } from "../tools/phone-cards.ts";
import { usd } from "../tools/receipts.ts";
import { canaryOn, leaseFor, realOpenWeights } from "./browser.ts";
import { type CuSessionInfo, type FlowEnv, modelFor } from "./env.ts";

export type WatchTrigger = "schedule" | "command";

export interface WatchOutcome {
  skill: string;
  version: number;
  outcome: "verified" | "repaired" | "canary_failed" | "broken" | "skipped";
  /** The version the watch activated. */
  activated?: number;
  /** What the rep was told (absent when nothing needed saying). */
  message?: string;
  costUsd: number;
}

/** What the demo HUD calls a watch's dry run. */
export const WATCH_LABEL = "Drift watch · dry run";
export const WATCH_CANARY_RUNS = 5;
export const WATCH_SUITE = "drift_watch";

/** Buttons on a watch card: `w:<skill>:<version>:rb` (roll back) and `w:<skill>:<version>:dt` (details). */
export const WATCH_BUTTON = /^w:([a-z][a-z0-9_]*):(\d+):(rb|dt)$/;

/** Values for a dry run: each param's default or first-run example, files from the company kit. */
export function watchParams(skill: Skill, kit: CompanyKit): Record<string, ParamValue> | null {
  const base: Record<string, ParamValue> = {};
  for (const p of skill.params) {
    if (p.type === "file") {
      const slot = Object.entries(FILE_SLOTS).find(([, aliases]) => aliases.includes(p.name))?.[0] ?? p.name;
      const file = kit.files[slot] ?? kit.files[p.name];
      if (file) base[p.name] = file;
      else if (p.required) return null;
      continue;
    }
    const v = p.default ?? p.example;
    if (v === undefined) {
      if (p.required) return null;
      continue;
    }
    base[p.name] =
      p.type === "number" && Number.isFinite(Number(v)) ? Number(v) : p.type === "boolean" ? v === "true" : v;
  }
  return syntheticParamSets(skill, base, 1)[0] ?? base;
}

const FREE: HealRung[] = ["fallback", "similarity"];

/** "2 steps (1 free, 1 with Muse Spark Open, $0.004)". */
function repairedPhrase(steps: StepResult[], costUsd: number): string {
  const healed = steps.filter((s) => s.rung && s.rung !== "ask_rep");
  const free = healed.filter((s) => FREE.includes(s.rung as HealRung)).length;
  const open = healed.filter((s) => s.rung === "open_weights").length;
  const cu = healed.filter((s) => s.rung === "computer_use").length;
  const parts = [
    ...(free ? [`${free} free`] : []),
    ...(open ? [`${open} with Muse Spark Open`] : []),
    ...(cu ? [`${cu} with Muse computer use`] : []),
    ...(costUsd > 0 ? [usd(costUsd)] : []),
  ];
  return `${healed.length} step${healed.length === 1 ? "" : "s"} (${parts.join(", ")})`;
}

/** The label the failing step was about, from the runner's "s7 (Fill 'City'): …" error. */
function brokenStep(r: RunResult): string {
  const intent = /^s\d+ \((.*?)\): /.exec(r.error ?? "")?.[1];
  const name = intent ? /'([^']+)'/.exec(intent)?.[1] : undefined;
  return name ? `the '${name}' step` : "one step";
}

export interface WatchCtx {
  skill: string;
  trigger: WatchTrigger;
  /** Who gets the card or the question. */
  rep: string;
}

/** Watches one active skill. Never throws for a run failure; the outcome says what happened. */
export async function watchSkill(env: FlowEnv & { tmpDir: string }, w: WatchCtx): Promise<WatchOutcome> {
  const stored = env.skills.active(w.skill);
  if (!stored) return { skill: w.skill, version: 0, outcome: "skipped", costUsd: 0 };
  const portal = env.portals[stored.portalId];
  const kit = await env.company();
  const params = portal ? watchParams(stored, kit) : null;
  if (!portal || !params)
    return { skill: stored.name, version: stored.version, outcome: "skipped", costUsd: 0 };

  // A job of its own, so the question gate, the run and every model call are attributed to the watch.
  const job = env.repos.jobs.create(w.rep);
  env.repos.jobs.apply(job.id, { type: "start" });
  env.repos.jobs.update(job.id, { intent: "command" });
  env.repos.jobs.apply(job.id, { type: "understood", missing: [], writes: false });
  const runId = ulid(env.clock);
  env.repos.runs.start({
    id: runId,
    jobId: job.id,
    mode: "replay",
    skillName: stored.name,
    skillVersion: stored.version,
    portalId: portal.id,
    params,
    suite: WATCH_SUITE,
  });
  const when = w.trigger === "schedule" ? " overnight" : "";
  const answers: { label: string; answer: string }[] = [];
  const opOf = new Map(stored.steps.map((s) => [s.id, s.op]));
  const lease = await leaseFor(env, portal, runId);
  let result: RunResult;
  try {
    result = await runSkill(
      lease.page,
      rebaseSkill(stored, portal.url),
      params,
      {
        // A dry run stops before the commit; these never fire, and refusing them is the safe answer.
        approveCommit: async () => "rejected",
        approveSafety: async () => "rejected",
        // The whole ladder, as on a real request. A dry run never submits and the write guard holds every write, so
        // computer use (at most 8 actions) is safe here; without it a step Muse Spark Open declines (a field renamed
        // and moved to another section) would wait for the rep's next request.
        repairers: watchRepairers(env, lease.page, { runId, portalId: portal.id, params, portal }),
        async askRep(q) {
          lease.extend(env.gateTtlMs + 5 * 60_000);
          const options = (q.options ?? []).filter((o) => o.trim() !== "");
          const buttons =
            options.length > 0 && options.length <= 3
              ? options.map((o, i) => ({ id: `opt${i}` as const, title: o }))
              : [{ id: "reject" as const, title: "Skip" }];
          const { gateId, decision } = await env.approvals.open({
            jobId: job.id,
            runId,
            kind: "question",
            to: w.rep,
            body: [
              `${portal.name} now requires ${q.label} for every registration. Which should I use?`,
              options.length > 3 ? `Options: ${options.join(", ")}.` : "",
              options.length > 0 && options.length <= 3
                ? "Tap one, or reply with the value."
                : "Reply with the value.",
              "I'll use it from now on, so nobody gets asked again.",
            ]
              .filter(Boolean)
              .join("\n"),
            image: q.screenshot,
            ttlMs: env.gateTtlMs,
            buttons,
          });
          const d = await env.park(decision);
          const answer = d.startsWith("opt")
            ? (options[Number(d.slice(3))] ?? null)
            : d === "approved"
              ? (env.textAnswers.get(gateId) ?? null)
              : null;
          if (answer !== null) answers.push({ label: q.label, answer });
          return answer;
        },
        onStep: (s) =>
          env.repos.runs.step(runId, {
            ...s,
            op: opOf.get(s.stepId) ?? (s.rung === "ask_rep" ? "fill" : "step"),
          }),
      },
      {
        runId,
        stepTimeoutMs: env.stepTimeoutMs,
        screenshots: "fail_only",
        allowFallbackHeal: true,
        dryRun: true,
        writeGuard: writeGuardFor(portal),
        artifacts: env.artifacts,
        hudLabel: WATCH_LABEL,
      },
    );
  } finally {
    await lease.release();
  }
  const costUsd = env.ledger.totals({ runId }).costUsd;
  env.repos.runs.finish(runId, {
    outcome: result.outcome === "dry_run_ok" ? (result.patched ? "repaired" : "verified") : result.outcome,
    errorCode: result.errorCode ?? null,
    ms: result.ms,
    execCostUsd: costUsd,
    modelCalls: env.ledger.totals({ runId }).calls,
    finalScreenshotId: result.finalScreenshot?.id ?? null,
  });
  const say = async (body: string, buttons?: { id: string; title: string }[], image?: ArtifactRef) => {
    const waId = buttons
      ? await env.wa.sendButtons(w.rep, body, buttons, image ? { headerImage: image } : {})
      : await env.wa.sendText(w.rep, body);
    env.repos.messages.insertOutbound({
      waId,
      to: w.rep,
      jobId: job.id,
      kind: buttons ? "interactive" : "text",
      text: body,
    });
  };
  const done = (o: Omit<WatchOutcome, "skill" | "version" | "costUsd">): WatchOutcome => {
    if (env.repos.jobs.get(job.id)?.status === "executing")
      env.repos.jobs.apply(job.id, { type: "finished", ok: o.outcome !== "broken" });
    return { skill: stored.name, version: stored.version, costUsd, ...o };
  };

  if (result.outcome === "dry_run_ok" && !result.patched) return done({ outcome: "verified" });

  if (result.outcome !== "dry_run_ok" || !result.patched) {
    const message =
      result.outcome === "needs_input"
        ? `${portal.name} now requires information ${stored.name} has no value for, so v${stored.version} stays as it is. The next real request will ask you.`
        : `${portal.name} changed${when} and I couldn't repair ${brokenStep(result)} safely, so ${stored.name} v${stored.version} stays as it is. The next real request will try that step again before anything is submitted.`;
    await say(message);
    return done({ outcome: "broken", message });
  }

  // Repaired (and maybe asked): a new param takes the rep's answer as its default, then the canary decides.
  const patched = result.patched as SkillBody;
  const known = new Set(stored.params.map((p) => p.name));
  const withDefaults: SkillBody = {
    ...patched,
    params: patched.params.map((p) => {
      if (known.has(p.name)) return p;
      const answer = answers.find((a) => a.label === p.description)?.answer;
      return answer === undefined ? p : { ...p, default: answer };
    }),
  };
  const candidate: Skill = { ...withDefaults, version: stored.version + 1, parentVersion: stored.version };
  const base: Record<string, ParamValue> = { ...params };
  for (const p of withDefaults.params) if (base[p.name] === undefined && p.default) base[p.name] = p.default;
  const canary = await canaryOn(
    env,
    portal,
    candidate,
    syntheticParamSets(candidate, base, WATCH_CANARY_RUNS),
    `${runId}-canary`,
  );
  if (canary.passed < canary.total) {
    env.log.warn("drift watch fix failed the canary", { runId, failures: canary.failures });
    const message = `${portal.name} changed${when}. My fix failed ${canary.total - canary.passed} of ${canary.total} dry runs, so ${stored.name} v${stored.version} stays active. The next real request will repair it again before anything is submitted.`;
    await say(message);
    return done({ outcome: "canary_failed", message });
  }
  const source =
    answers.length > 0 ? "ask_rep" : result.steps.some((s) => s.rung === "open_weights") ? "repair" : "heal";
  const saved = env.skills.saveVersion(withDefaults, stored.version, true, source, runId);
  const asked = answers
    .map((a) => `${portal.name} now requires ${a.label}: I'll use ${a.answer} from now on.`)
    .join(" ");
  const repaired = result.steps.some((s) => s.rung && s.rung !== "ask_rep")
    ? `${portal.name} changed${when}. I repaired ${repairedPhrase(result.steps, costUsd)} and checked it with ${canary.passed} dry runs.`
    : `Checked with ${canary.passed} dry runs.`;
  const message = [asked, repaired, `v${saved.version} is active, v${stored.version} is kept. Nothing to do.`]
    .filter(Boolean)
    .join(" ");
  // The phone card: every number from this watch's ledger and canary; the credit only for a real Baseten call.
  const card = await env.phoneCards.render(
    job.id,
    diffPhoneCardHtml({
      portalName: portal.name,
      parent: stored,
      saved,
      steps: result.steps,
      canary,
      costUsd,
      usedOpenWeights: realOpenWeights(env, job.id, runId),
      watch: { when: w.trigger === "schedule" ? "overnight" : "on demand" },
    }),
  );
  await say(
    message,
    [
      { id: `w:${saved.name}:${saved.version}:rb`, title: "Roll back" },
      { id: `w:${saved.name}:${saved.version}:dt`, title: "Details" },
    ],
    card,
  );
  return done({ outcome: "repaired", activated: saved.version, message });
}

/** The grouped diff of the version a watch activated, for the Details button: a summary line and changes. */
export function watchDetails(
  env: FlowEnv,
  name: string,
  version: number,
): {
  summary: string | null;
  changes: string[];
  parent: number | null;
  sourceRunId: string | null;
  steps: StepResult[];
  costUsd: number;
} {
  const saved = env.skills.get(name, version);
  const row = env.db.raw
    .prepare("SELECT source_run_id FROM skills WHERE name = ? AND version = ?")
    .get(name, version) as { source_run_id: string | null } | undefined;
  const parent = saved?.parentVersion ?? null;
  const before = parent ? env.skills.get(name, parent) : undefined;
  const runId = row?.source_run_id ?? null;
  const steps = runId
    ? env.repos.runs.steps(runId).map(
        (s): StepResult => ({
          idx: s.idx,
          stepId: s.stepId,
          status: s.status as StepResult["status"],
          ...(s.rung ? { rung: s.rung as HealRung } : {}),
          ms: 0,
        }),
      )
    : [];
  return {
    summary: saved && before ? repairSummary(steps, before.steps, saved.steps) : null,
    changes: (saved?.changelog ?? "").split("\n").filter((l) => l.trim() !== ""),
    parent,
    sourceRunId: runId,
    steps,
    costUsd: runId ? (env.repos.runs.get(runId)?.execCostUsd ?? 0) : 0,
  };
}

/** A watch's repair ladder after the free rungs: Muse Spark Open when configured, then computer use. */
function watchRepairers(
  env: FlowEnv,
  page: CuSessionInfo["page"],
  o: {
    runId: CuSessionInfo["runId"];
    portalId: string;
    params: CuSessionInfo["params"];
    portal: Parameters<typeof writeGuardFor>[0];
  },
): Repairer[] {
  const repairers: Repairer[] = [];
  if (env.models.hasOpenWeights())
    repairers.push(
      createOpenWeightsRepairer(env.models, {
        model: env.config.openWeights.model,
        ledger: env.ledger,
        artifacts: env.artifacts,
      }),
    );
  repairers.push(
    createCuRepairer({
      model: modelFor(env.repairCu, {
        page,
        purpose: "cu_repair",
        runId: o.runId,
        portalId: o.portalId,
        params: o.params,
      }),
      runComputerUse,
      artifacts: env.artifacts,
      writeGuard: writeGuardFor(o.portal),
      ledger: env.ledger,
    }),
  );
  return repairers;
}

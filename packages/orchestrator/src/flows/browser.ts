// Browser flows. First run: computer use guided by the teach draft (or a zero-shot goal), commit gate in
// WhatsApp, then compile -> annotate -> two dry runs -> v1. Replay: the compiled skill with zero model calls on
// the happy path, the heal ladder when the portal changed, and a canary before any patched version goes live.

import { runComputerUse } from "@dockhand/browser";
import {
  type ArtifactRef,
  type CuRunResult,
  DockhandError,
  type HealRung,
  type Lease,
  type ParamSpec,
  type ParamValue,
  type PlanAction,
  type Repairer,
  type RunResult,
  type Skill,
  type SkillDraft,
  type Trace,
  ulid,
} from "@dockhand/core";
import {
  annotateSkillDetailed,
  compile,
  createCuRepairer,
  createOpenWeightsRepairer,
  rebaseSkill,
  runCanary,
  runSkill,
} from "@dockhand/skills";
import { firstRunStop, repairSummary, stopReason } from "../messages.ts";
import { fitSpecsToValues, inferSpecs, syntheticParamSets, withExamples } from "../params.ts";
import { FIRST_RUN_LIMITS } from "../plan.ts";
import { type PortalTarget, writeGuardFor } from "../portals.ts";
import { basetenHeal, diffCardLedger, diffPhoneCardHtml } from "../tools/phone-cards.ts";
import { receiptCaption, skillCardHtml } from "../tools/receipts.ts";
import {
  type FlowEnv,
  gateHooks,
  intakeCost,
  type JobCtx,
  modelFor,
  runTotals,
  sendImage,
  sendText,
  trySend,
} from "./env.ts";
import type { FlowOutcome } from "./teach.ts";

type ComputerUseAction = Extract<PlanAction, { kind: "computer_use" }>;
type ReplayAction = Extract<PlanAction, { kind: "skill_replay" }>;

const RUNG_WORDS: Record<HealRung, string> = {
  fallback: "a stored fallback selector",
  similarity: "a similarity match",
  open_weights: "Muse Spark Open",
  computer_use: "Muse computer use",
  ask_rep: "your answer",
};

export const OPEN_WEIGHTS_RUNG: HealRung = "open_weights";

/**
 * "Built with Muse Spark Open" only when Baseten really served a heal for this job: never for the fake
 * stand-in, scripted models or cassette replays (those record provider fake, scripted or cassette).
 */
export function realOpenWeights(env: Pick<FlowEnv, "db">, jobId: string, runId: string): boolean {
  return basetenHeal(env.db, jobId, runId); // one rule for receipts and cards (tools/phone-cards.ts)
}

function portalOf(env: FlowEnv, portalId: string): PortalTarget {
  const portal = env.portals[portalId];
  if (!portal) throw new DockhandError("TOOL_ERROR", `portal "${portalId}" is not configured`);
  return portal;
}

async function leaseFor(env: FlowEnv, portal: PortalTarget, runId: string): Promise<Lease> {
  const lease = await env.pool.lease({
    portalId: portal.id,
    runId,
    cookies: await portal.session({ runId }),
    ttlMs: env.gateTtlMs * 2 + 10 * 60_000,
  });
  if (portal.prepare) {
    try {
      await portal.prepare(lease.page);
    } catch (err) {
      await lease.release();
      throw err;
    }
  }
  return lease;
}

function fileSlots(params: Record<string, ParamValue>): Record<string, ArtifactRef> {
  const out: Record<string, ArtifactRef> = {};
  for (const [name, v] of Object.entries(params)) if (typeof v === "object") out[name] = v.file;
  return out;
}

async function screenshotBytes(env: FlowEnv, ref: ArtifactRef | undefined): Promise<Uint8Array | undefined> {
  if (!ref) return undefined;
  try {
    return await env.artifacts.read(ref);
  } catch {
    return undefined;
  }
}

/** Dry runs on fresh pages (one lease at a time, released before the next). */
async function canaryOn(
  env: FlowEnv,
  portal: PortalTarget,
  skill: Skill,
  sets: Record<string, ParamValue>[],
  baseRunId: string,
): Promise<{ passed: number; total: number; failures: string[] }> {
  let current: Lease | undefined;
  let i = 0;
  try {
    const result = await runCanary(
      async () => {
        await current?.release();
        current = await leaseFor(env, portal, `${baseRunId}-c${i++}`);
        return current.page;
      },
      rebaseSkill(skill, portal.url),
      sets,
      {
        artifacts: env.artifacts,
        writeGuard: writeGuardFor(portal),
        stepTimeoutMs: env.stepTimeoutMs,
        runIdFor: (n) => `${baseRunId}-c${n}`,
      },
    );
    return {
      passed: result.passed,
      total: result.total,
      failures: result.failures.map(
        (f) => `${f.outcome}${f.errorCode ? ` ${f.errorCode}` : ""}${f.error ? `: ${f.error}` : ""}`,
      ),
    };
  } finally {
    await current?.release();
  }
}

// ---------- first run ----------

export async function runFirstRun(
  env: FlowEnv,
  job: JobCtx,
  action: ComputerUseAction,
): Promise<FlowOutcome> {
  const portal = portalOf(env, action.portalId);
  const draft = action.draftId ? env.skills.getDraft(action.draftId) : undefined;
  const runId = ulid(env.clock);
  env.repos.runs.start({
    id: runId,
    jobId: job.id,
    mode: "agentic",
    skillName: action.compileAs,
    portalId: portal.id,
    params: action.params,
  });
  await trySend(
    env,
    job,
    `First run on ${portal.name} with computer use${draft ? ", following your recording" : ""}. I'll show you the filled form before anything is submitted.`,
  );

  const t0 = performance.now();
  const startedAt = env.clock.now();
  let lastProgress = 0;
  const lease = await leaseFor(env, portal, runId);
  let res: CuRunResult;
  try {
    await lease.page.goto(action.startUrl, { waitUntil: "load" });
    const hooks = {
      ...gateHooks(env, job, {
        runId,
        origin: portal.url,
        portalName: portal.name,
        extendLease: (ms: number) => lease.extend(ms),
      }),
      // A plain "still working" line every 20 s or so on long runs; quiet on short ones.
      progress(r: { action: number; note: string }) {
        const now = env.clock.now();
        if (now - startedAt < 15_000 || now - lastProgress < 20_000) return;
        lastProgress = now;
        void trySend(env, job, `Still working on ${portal.name}: ${r.action} actions so far.`);
      },
    };
    res = await runComputerUse(
      modelFor(env.cu, {
        page: lease.page,
        purpose: "cu_first_run",
        runId,
        portalId: portal.id,
        params: action.params,
      }),
      {
        page: lease.page,
        portalId: portal.id,
        runId,
        goal: action.goal,
        guidance: draft?.steps ?? [],
        params: action.params,
        attachments: fileSlots(action.params),
        commitPolicy: "gate",
        commitHints: draft?.commitStep ? [draft.commitStep] : (portal.commitHints ?? []),
        writeGuard: writeGuardFor(portal),
        limits: {
          maxActions: FIRST_RUN_LIMITS[portal.id as keyof typeof FIRST_RUN_LIMITS] ?? 30,
          maxWallMs: 15 * 60_000,
          maxCostUsd: 1.5,
          rolloverAfterImages: 20,
        },
        costSoFar: () => env.ledger.totals({ runId }).costUsd,
        artifacts: env.artifacts,
      },
      hooks,
      { purpose: "cu_first_run", jobId: job.id, runId, timeoutMs: 90_000 },
    );
  } finally {
    await lease.release();
  }
  if (res.blockedForeign?.length) {
    env.log.warn("write guard aborted requests to another origin", {
      runId,
      portal: portal.id,
      requests: res.blockedForeign,
    });
  }
  const seconds = (performance.now() - t0 - (res.humanMs ?? 0)) / 1000; // machine time: the rep's waits are left out
  const traceRef = await env.artifacts.put(
    new TextEncoder().encode(JSON.stringify(res.trace)),
    "application/json",
    {
      kind: "trace",
      jobId: job.id,
      runId,
    },
  );
  const committed = res.trace.steps.some((s) => s.tags.includes("commit") && !s.tags.includes("blocked"));
  const outcome =
    res.outcome === "done" && committed ? "success" : res.outcome === "done" ? "failed" : res.outcome;
  const finishRun = (extracted?: Record<string, string>, errorCode?: string) => {
    const t = runTotals(env, runId);
    env.repos.runs.finish(runId, {
      outcome: outcome === "budget_exceeded" ? "failed" : outcome,
      errorCode: errorCode ?? null,
      ms: seconds * 1000,
      execCostUsd: t.costUsd,
      modelCalls: t.calls,
      traceArtifactId: traceRef.id,
      finalScreenshotId: res.trace.final.screenshot?.id ?? null,
      ...(extracted ? { extracted } : {}),
    });
  };

  if (outcome === "rejected" || outcome === "expired") {
    finishRun(undefined, outcome === "rejected" ? "APPROVAL_REJECTED" : "APPROVAL_EXPIRED");
    await trySend(
      env,
      job,
      outcome === "rejected"
        ? "Cancelled before submitting. Nothing was sent."
        : "This request expired. Send it again to retry.",
    );
    return { ok: false, errorCode: outcome === "rejected" ? "APPROVAL_REJECTED" : "APPROVAL_EXPIRED" };
  }
  if (outcome !== "success") {
    const code = res.outcome === "budget_exceeded" ? "BUDGET_EXCEEDED" : "TOOL_ERROR";
    finishRun(undefined, code);
    const why = firstRunStop(res.message, res.outcome === "budget_exceeded");
    await sendText(env, job, `The first run on ${portal.name} stopped: ${why}. Nothing was submitted.`);
    if (res.trace.final.screenshot) await sendImage(env, job, res.trace.final.screenshot, "Where it stopped");
    return { ok: false, errorCode: code };
  }

  // The submission happened: compile the run into a skill, then report both.
  const compiled = await compileRun(env, job, { runId, trace: res.trace, action, draft, portal });
  const idRegex = compiled.skill?.success.extract[0]?.regex;
  const id = firstMatch(res.trace.final.text, idRegex) ?? firstMatch(res.trace.final.url, idRegex);
  finishRun(id ? { [compiled.skill?.success.extract[0]?.name ?? "id"]: id } : {});

  const t = runTotals(env, runId);
  const receipt = await env.cards.receipt(job.id, {
    title: draft?.title ?? `${portal.name}: first run`,
    tier: "agentic",
    ...(id ? { headline: id } : {}),
    lines: [
      `Submitted on ${portal.name} after your approval`,
      `${res.trace.steps.length} computer-use actions, ${t.calls} model calls`,
      compiled.skill
        ? `Compiled into ${compiled.skill.name} v${compiled.skill.version} (verified ${compiled.verified.passed}/${compiled.verified.total} dry runs)`
        : `Not compiled yet: ${compiled.reason}`,
    ],
    seconds,
    execCostUsd: t.costUsd,
    intakeCostUsd: intakeCost(env, job.id),
    ...(compiled.skill ? { skill: { name: compiled.skill.name, version: compiled.skill.version } } : {}),
    screenshot: await screenshotBytes(env, res.trace.final.screenshot),
  });
  await sendImage(env, job, receipt.image, receiptCaption(receipt));
  if (compiled.skill && compiled.card) {
    await sendImage(
      env,
      job,
      compiled.card,
      `New skill: ${compiled.skill.name} v${compiled.skill.version}. Next time it replays in seconds with no model calls.`,
    );
  }
  return { ok: true };
}

function firstMatch(text: string, regex: string | undefined): string | undefined {
  if (!regex) return undefined;
  try {
    return new RegExp(regex).exec(text)?.[0];
  } catch {
    return undefined;
  }
}

interface Compiled {
  skill?: Skill;
  card?: ArtifactRef;
  verified: { passed: number; total: number };
  reason?: string;
}

/** compile -> annotate (Spark proposes, code verifies) -> two dry runs -> saveVersion v1 -> skill card. */
async function compileRun(
  env: FlowEnv,
  job: JobCtx,
  o: {
    runId: string;
    trace: Trace;
    action: ComputerUseAction;
    draft: SkillDraft | undefined;
    portal: PortalTarget;
  },
): Promise<Compiled> {
  const { runId, trace, action, draft, portal } = o;
  try {
    // Enum values in a draft are what the video showed: examples, never the list a skill accepts.
    const draftSpecs = fitSpecsToValues(
      (draft?.params ?? []).map(({ enumValues: _shown, ...p }) => p),
      action.params,
    );
    const specs = mergeSpecs(draftSpecs, inferSpecs(action.params));
    const { skill: body0, warnings } = compile(trace, {
      name: action.compileAs,
      title: draft?.title ?? `${portal.name} task`,
      params: specs,
      createdFrom: {
        kind: draft ? "video" : "goal",
        ...(action.draftId ? { draftId: action.draftId } : {}),
        traceRunId: runId,
      },
    });
    if (warnings.length > 0) env.log.info("compile warnings", { runId, warnings });
    const report = await annotateSkillDetailed(
      { ...body0, params: withExamples(body0.params, trace.params) },
      trace,
      draft ?? null,
      env.models,
      { jobId: job.id, runId, timeoutMs: 45_000 },
    );
    const renames = Object.fromEntries(
      report.applied.flatMap((line) => {
        const m = /^rename (\S+) -> (\S+)$/.exec(line);
        return m?.[1] && m[2] ? [[m[1], m[2]]] : [];
      }),
    );
    const body = report.body;
    const firstValues = Object.fromEntries(
      Object.entries(action.params).map(([k, v]) => [renames[k] ?? k, v]),
    );
    const candidate: Skill = { ...body, version: 1, parentVersion: null };
    const sets = [firstValues, ...syntheticParamSets(candidate, firstValues, 1)];
    const verified = await canaryOn(env, portal, candidate, sets, `${runId}-verify`);
    if (verified.passed < verified.total) {
      env.log.warn("compiled skill failed verification", { runId, failures: verified.failures });
      return {
        verified,
        reason: `the compiled program failed ${verified.total - verified.passed} of ${verified.total} dry runs`,
      };
    }
    const skill = env.skills.saveVersion(body, null, true, "compile", runId);
    const card = await env.cards.card(
      job.id,
      skillCardHtml({
        skill,
        portalName: portal.name,
        verified,
        fromRun: runId,
        ...(report.successDescription ? { successDescription: report.successDescription } : {}),
      }),
    );
    return { skill, card, verified };
  } catch (err) {
    env.log.error("compile failed", { runId, err });
    return { verified: { passed: 0, total: 0 }, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Draft specs win; params the run used that the draft lacks (files, tenant) get inferred specs. */
function mergeSpecs(primary: ParamSpec[], inferred: ParamSpec[]): ParamSpec[] {
  const out = [...primary];
  for (const s of inferred) if (!out.some((p) => p.name === s.name)) out.push(s);
  return out;
}

// ---------- replay ----------

export async function runReplay(env: FlowEnv, job: JobCtx, action: ReplayAction): Promise<FlowOutcome> {
  const stored = env.skills.get(action.skill, action.version) ?? env.skills.active(action.skill);
  if (!stored) throw new DockhandError("TOOL_ERROR", `skill ${action.skill} v${action.version} not found`);
  const portal = portalOf(env, stored.portalId);
  const skill = rebaseSkill(stored, portal.url);
  const runId = ulid(env.clock);
  env.repos.runs.start({
    id: runId,
    jobId: job.id,
    mode: "replay",
    skillName: skill.name,
    skillVersion: skill.version,
    portalId: portal.id,
    params: action.params,
  });

  const answers: { label: string; answer: string }[] = [];
  const lease = await leaseFor(env, portal, runId);
  let result: RunResult;
  try {
    const gates = gateHooks(env, job, {
      runId,
      origin: portal.url,
      portalName: portal.name,
      extendLease: (ms) => lease.extend(ms),
    });
    const repairers: Repairer[] = [];
    if (env.models.hasOpenWeights()) {
      repairers.push(
        createOpenWeightsRepairer(env.models, {
          model: env.config.openWeights.model,
          ledger: env.ledger,
          artifacts: env.artifacts, // keeps each pick for the flight recorder
        }),
      );
    }
    repairers.push(
      createCuRepairer({
        model: modelFor(env.repairCu, {
          page: lease.page,
          purpose: "cu_repair",
          runId,
          portalId: portal.id,
          params: action.params,
        }),
        runComputerUse,
        artifacts: env.artifacts,
        writeGuard: writeGuardFor(portal),
        ledger: env.ledger,
      }),
    );
    const opOf = new Map(skill.steps.map((s) => [s.id, s.op]));
    result = await runSkill(
      lease.page,
      skill,
      action.params,
      {
        ...gates,
        async askRep(q) {
          const answer = (await gates.askRep?.(q)) ?? null;
          if (answer !== null) answers.push({ label: q.label, answer });
          return answer;
        },
        repairers,
        onStep: (s) =>
          env.repos.runs.step(runId, {
            ...s,
            op: opOf.get(s.stepId) ?? (s.rung === "ask_rep" ? "fill" : "step"),
          }),
      },
      {
        runId,
        stepTimeoutMs: env.stepTimeoutMs,
        screenshots: "final_only",
        allowFallbackHeal: true,
        writeGuard: writeGuardFor(portal),
        artifacts: env.artifacts,
        successTimeoutMs: 15_000,
      },
    );
  } finally {
    await lease.release();
  }

  const totals = runTotals(env, runId);
  const rungs = [...new Set(result.steps.flatMap((s) => (s.rung ? [s.rung] : [])))];
  const repaired = rungs.some((r) => r === "open_weights" || r === "computer_use");
  env.repos.runs.finish(runId, {
    outcome: result.outcome,
    errorCode: result.errorCode ?? null,
    ms: result.ms,
    execCostUsd: totals.costUsd,
    modelCalls: totals.calls,
    mode: repaired ? "repair" : "replay",
    finalScreenshotId: result.finalScreenshot?.id ?? null,
    extracted: result.extracted,
  });

  switch (result.outcome) {
    case "success": {
      const id = Object.values(result.extracted)[0];
      const summary = repairSummary(result.steps, skill.steps, result.patched?.steps ?? skill.steps);
      const receipt = await env.cards.receipt(job.id, {
        title: skill.title,
        tier: repaired ? "repair" : "replay",
        ...(id ? { headline: id } : {}),
        lines: [
          `Submitted on ${portal.name} after your approval`,
          summary ?? "Every step matched the compiled program: no model calls",
        ],
        seconds: result.ms / 1000,
        execCostUsd: totals.costUsd,
        intakeCostUsd: intakeCost(env, job.id),
        skill: { name: skill.name, version: skill.version },
        ...(result.verification
          ? { verified: { matched: result.verification.matched, checked: result.verification.checked } }
          : {}),
        usedOpenWeights: realOpenWeights(env, job.id, runId),
        screenshot: await screenshotBytes(env, result.finalScreenshot),
      });
      await sendImage(env, job, receipt.image, receiptCaption(receipt, realOpenWeights(env, job.id, runId)));
      if (result.patched)
        await promotePatch(env, job, {
          stored,
          result,
          runId,
          params: action.params,
          answers,
          portal,
          rungs,
          summary,
        });
      return { ok: true };
    }
    case "rejected":
      await trySend(env, job, "Cancelled before submitting. Nothing was sent.");
      return { ok: false, errorCode: "APPROVAL_REJECTED" };
    case "expired":
      await trySend(env, job, "This request expired. Send it again to retry.");
      return { ok: false, errorCode: "APPROVAL_EXPIRED" };
    case "unknown":
      await sendText(
        env,
        job,
        `I clicked submit on ${portal.name} but could not confirm the result, so I won't click again. Check the portal before retrying.`,
      );
      if (result.finalScreenshot)
        await sendImage(env, job, result.finalScreenshot, "The page after submitting");
      return { ok: false, errorCode: "UNKNOWN_OUTCOME" };
    default: {
      const why = stopReason(portal.name, result.errorCode, result.error);
      await sendText(env, job, `Stopped before submitting: ${why}. Nothing was submitted.`);
      if (result.finalScreenshot) await sendImage(env, job, result.finalScreenshot, "Where it stopped");
      return { ok: false, errorCode: result.errorCode ?? "TOOL_ERROR" };
    }
  }
}

/** A patched skill goes live only after canary dry runs pass; the old version stays for rollback. */
async function promotePatch(
  env: FlowEnv,
  job: JobCtx,
  o: {
    stored: Skill;
    result: RunResult;
    runId: string;
    params: Record<string, ParamValue>;
    answers: { label: string; answer: string }[];
    portal: PortalTarget;
    rungs: HealRung[];
    summary: string | null;
  },
): Promise<void> {
  const patched = o.result.patched;
  if (!patched) return;
  const parent = env.skills.active(o.stored.name) ?? o.stored;
  const candidate: Skill = { ...patched, version: parent.version + 1, parentVersion: parent.version };
  const base: Record<string, ParamValue> = { ...o.params };
  for (const p of patched.params) {
    if (base[p.name] !== undefined) continue;
    const answer = o.answers.find((a) => a.label === p.description)?.answer;
    if (answer !== undefined) base[p.name] = answer;
  }
  const canary = await canaryOn(
    env,
    o.portal,
    candidate,
    syntheticParamSets(candidate, base, 3),
    `${o.runId}-canary`,
  );
  if (canary.passed < canary.total) {
    env.log.warn("patched skill failed the canary", { runId: o.runId, failures: canary.failures });
    await trySend(
      env,
      job,
      `${o.portal.name} changed. This run got through, but the fixed skill failed ${canary.total - canary.passed} of ${canary.total} dry runs, so ${parent.name} v${parent.version} stays active.`,
    );
    return;
  }
  const source = o.rungs.includes("ask_rep")
    ? "ask_rep"
    : o.rungs.some((r) => r === "open_weights" || r === "computer_use")
      ? "repair"
      : "heal";
  const saved = env.skills.saveVersion(patched, parent.version, true, source, o.runId);
  const how = o.rungs.map((r) => RUNG_WORDS[r]).join(" + ") || "a free heal";
  const card = await env.phoneCards.render(
    job.id,
    diffPhoneCardHtml({
      portalName: o.portal.name,
      parent,
      saved,
      steps: o.result.steps,
      canary: { passed: canary.passed, total: canary.total },
      ...diffCardLedger(env, job.id, o.runId), // cost and credit: only what the ledger recorded
    }),
  );
  await sendImage(
    env,
    job,
    card,
    [
      `Portal changed: ${o.portal.name}.`,
      o.summary ?? `Fixed by ${how}.`,
      `Checked on ${canary.passed}/${canary.total} dry runs. Saved ${saved.name} v${saved.version} (v${parent.version} kept: /rollback ${saved.name} ${parent.version}).`,
    ].join("\n"),
  );
}

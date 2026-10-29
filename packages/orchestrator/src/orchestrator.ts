// The orchestrator: one inbound message at a time per rep (keyed lock), the attach rule (§1.4), intake ->
// understanding -> deterministic plan -> plan gate -> flows. Waiting on a person never holds the rep's lock,
// and drain() resolves once nothing is computing (parked approvals do not count).

import { join } from "node:path";
import { renderHtml } from "@dockhand/browser";
import {
  type ArtifactStore,
  type BrowserPool,
  type Clock,
  type CompanyProfile,
  type Config,
  type CrmClient,
  createLedger,
  type Db,
  DockhandError,
  type ErrorCode,
  type Id,
  type InboundMessage,
  type Ledger,
  type Logger,
  type ModelGateway,
  type QuoteService,
  type SkillStore,
  type Understanding,
  varDir,
  type WhatsAppClient,
} from "@dockhand/core";
import type { DockhandApprovalBroker, GateDecision } from "./approvals.ts";
import { inputsMentionEspo, leadToUnderstanding, planLead, understandLead } from "./espocrm.ts";
import { realOpenWeights, runFirstRun, runReplay } from "./flows/browser.ts";
import { isCommand, runCommand } from "./flows/commands.ts";
import { type CuModelSource, type FlowEnv, type JobCtx, sendText, trySend } from "./flows/env.ts";
import { runQuote } from "./flows/quote.ts";
import { type FlowOutcome, runTeach } from "./flows/teach.ts";
import {
  WATCH_BUTTON,
  WATCH_CANARY_RUNS,
  type WatchOutcome,
  type WatchTrigger,
  watchDetails,
  watchSkill,
} from "./flows/watch.ts";
import {
  analyzeMedia,
  classifyMedia,
  downloadMedia,
  type IntakeItem,
  transcriptionKeywords,
  UNSUPPORTED_MEDIA,
} from "./intake.ts";
import { intakeFailure, isCancelText, isSkipText } from "./messages.ts";
import { buildPlan } from "./plan.ts";
import { ESPOCRM, type PortalDirectory, type PortalInfo } from "./portals.ts";
import { type CompanyKit, loadCompanyKit, repProfile } from "./profile.ts";
import { createRepos, type JobRow, type MessageRow } from "./repo.ts";
import { createPhoneCards, diffPhoneCardHtml } from "./tools/phone-cards.ts";
import { createCardRenderer, type RenderHtml } from "./tools/receipts.ts";
import { type KnownSkill, teachUnderstanding, type UnderstandInput, understand } from "./understand.ts";

export interface OrchestratorDeps {
  db: Db;
  clock: Clock;
  config: Config;
  log: Logger;
  wa: WhatsAppClient;
  models: ModelGateway;
  /** First-run computer use. Default: models.computerUse({ model: "muse-spark-1.3" }). */
  cu?: CuModelSource;
  /** Rung-3 repair. Default: models.computerUse({ model: "muse-spark-1.3" }) (muse-wonder-1.0 refuses the computer tool). */
  repairCu?: CuModelSource;
  pool: BrowserPool & { renderHtml?: RenderHtml };
  skills: SkillStore;
  crm: CrmClient;
  quotes: QuoteService;
  artifacts: ArtifactStore;
  approvals: DockhandApprovalBroker;
  portals: PortalDirectory;
  /** Supplier profile and its documents. Default: fixtures/profile/tidewater.json. */
  company?: CompanyKit | (() => Promise<CompanyKit>);
  ledger?: Ledger;
  render?: RenderHtml;
  tmpDir?: string;
  stepTimeoutMs?: number;
  /** 0 disables the 30 s expiry sweep (tests call approvals.expireDue() themselves). */
  expirySweepMs?: number;
  /** Drift watch interval; 0 or unset = only on demand (/watch, the dev route). */
  watchEveryMs?: number;
}

export interface Orchestrator {
  /** One inbound message, already deduplicated and allow-listed by the webhook. Serialized per rep. */
  handle(msg: InboundMessage): Promise<void>;
  /** Boot sweep: in-flight jobs fail with a message, their gates expire, unknown outcomes are marked. */
  recover(): Promise<void>;
  /** Resolves when nothing is computing (jobs parked on an approval do not count). */
  drain(): Promise<void>;
  /** Drift watch now: dry-run every active skill (or one), repair, canary, tell the rep only what changed. */
  watch(o?: { skill?: string; trigger?: WatchTrigger; rep?: string }): Promise<WatchOutcome[]>;
  close(): void;
}

export const RESTART_MESSAGE =
  "I restarted while working on this request, so I stopped it. If it may have been submitted, check the portal or HubSpot before sending it again.";

export const WAITING_ON_CARD =
  'A request of yours is waiting on the card above. Tap a button there, or reply "cancel" to stop it.';

export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  const { db, clock, config, log, wa, models, approvals } = deps;
  const repos = createRepos(db, clock);
  const ledger = deps.ledger ?? createLedger(db, clock);
  const tmpDir = deps.tmpDir ?? join(varDir(), "tmp");
  const render: RenderHtml =
    deps.render ??
    (deps.pool.renderHtml
      ? deps.pool.renderHtml.bind(deps.pool)
      : (html, size, o) => renderHtml(html, size, o ?? {}));
  const intakeCache = new Map<string, IntakeItem>();
  const textAnswers = new Map<Id, string>();
  const locks = new Map<string, Promise<void>>();

  // ---- activity tracking for drain() ----
  let active = 0;
  const idleWaiters: (() => void)[] = [];
  const enter = () => {
    active++;
  };
  const leave = () => {
    active--;
    if (active === 0) for (const resolve of idleWaiters.splice(0)) resolve();
  };
  const run = <T>(fn: () => Promise<T>): Promise<T> => {
    enter();
    let p: Promise<T>;
    try {
      p = fn();
    } catch (err) {
      p = Promise.reject(err);
    }
    return p.finally(leave);
  };
  const park = <T>(p: Promise<T>): Promise<T> => {
    leave();
    return p.finally(enter);
  };
  const spawn = (what: string, fn: () => Promise<unknown>) => {
    void run(fn).catch((err) => log.error(`${what} failed`, { err }));
  };

  let companyKit: Promise<CompanyKit> | undefined;
  const company = (): Promise<CompanyKit> => {
    companyKit ??= (async () => {
      if (typeof deps.company === "function") return deps.company();
      if (deps.company) return deps.company;
      try {
        return await loadCompanyKit(deps.artifacts);
      } catch (err) {
        log.warn("company profile not loaded; supplier onboarding is unavailable", { err });
        return { profile: {} as CompanyProfile, files: {} };
      }
    })();
    return companyKit;
  };

  const env: FlowEnv & { tmpDir: string } = {
    db,
    repos,
    clock,
    log,
    config,
    wa,
    models,
    ledger,
    pool: deps.pool,
    skills: deps.skills,
    crm: deps.crm,
    quotes: deps.quotes,
    artifacts: deps.artifacts,
    approvals,
    portals: deps.portals,
    cards: createCardRenderer({ artifacts: deps.artifacts, render }),
    phoneCards: createPhoneCards({ artifacts: deps.artifacts, render }),
    company,
    cu: deps.cu ?? models.computerUse({ model: "muse-spark-1.3" }),
    repairCu: deps.repairCu ?? models.computerUse({ model: "muse-spark-1.3" }),
    park,
    textAnswers,
    gateTtlMs: approvals.defaultTtlMs,
    stepTimeoutMs: deps.stepTimeoutMs ?? 4000,
    tmpDir,
  };
  const portalInfos: Record<string, PortalInfo> = Object.fromEntries(
    Object.entries(deps.portals).map(([k, p]) => [
      k,
      { id: p.id, name: p.name, url: p.url, startPath: p.startPath },
    ]),
  );

  function withRepLock(rep: string, fn: () => Promise<void>): Promise<void> {
    const prev = locks.get(rep) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    locks.set(rep, tail);
    void tail.then(() => {
      if (locks.get(rep) === tail) locks.delete(rep);
    });
    return next;
  }

  const jobCtx = (job: Pick<JobRow, "id" | "rep">): JobCtx => ({
    id: job.id,
    rep: repProfile(repos, job.rep),
  });

  // ---- routing (T1) ----

  type Route =
    | { type: "skip" | "button" | "command" | "unsupported" }
    | { type: "new" | "input"; jobId: Id }
    | { type: "edit" | "answer" | "cancel"; jobId: Id; gateId: Id };

  function routeMessage(msg: InboundMessage): Route {
    return db.tx((): Route => {
      // The gateway already stored the row (that is its dedupe); direct callers get it stored here.
      repos.messages.insertInbound(msg);
      if (msg.kind === "button") return { type: "button" };
      if (msg.kind === "text" && isCommand(msg.text)) return { type: "command" };
      if (msg.kind === "unsupported") return { type: "unsupported" };
      if (msg.kind !== "text") {
        if (classifyMedia(msg) === "unsupported") return { type: "unsupported" };
        return newJob(msg);
      }
      const replied = msg.replyTo ? repos.messages.get(msg.replyTo)?.jobId : null;
      // "cancel" typed at a card stops it like the Cancel button (question gates take text as the answer).
      if (isCancelText(msg.text)) {
        const pending = repos.gates.pendingForRep(msg.from).filter((g) => g.kind !== "question");
        const gate = pending.find((g) => g.jobId === replied) ?? pending[0];
        if (gate) {
          repos.messages.linkJob(msg.waId, gate.jobId);
          return { type: "cancel", jobId: gate.jobId, gateId: gate.id };
        }
      }
      const target =
        (replied ? attachable(repos.jobs.get(replied)) : undefined) ?? repos.jobs.attachableFor(msg.from);
      if (!target) return newJob(msg);
      repos.messages.linkJob(msg.waId, target.id);
      if (target.status === "awaiting_input") {
        repos.jobs.apply(target.id, { type: "input", waId: msg.waId });
        return { type: "input", jobId: target.id };
      }
      const gate = repos.gates
        .pendingForJob(target.id)
        .find((g) => g.kind === "plan" || g.kind === "question");
      if (!gate) return newJob(msg);
      if (gate.kind === "question" && isSkipText(msg.text))
        return { type: "cancel", jobId: target.id, gateId: gate.id };
      return { type: gate.kind === "plan" ? "edit" : "answer", jobId: target.id, gateId: gate.id };
    });
  }

  function attachable(job: JobRow | undefined): JobRow | undefined {
    if (!job) return undefined;
    if (job.status === "awaiting_input") return job;
    if (job.status !== "awaiting_approval") return undefined;
    return repos.gates.pendingForJob(job.id).some((g) => g.kind === "plan" || g.kind === "question")
      ? job
      : undefined;
  }

  function newJob(msg: InboundMessage): Route {
    const job = repos.jobs.create(msg.from);
    repos.messages.linkJob(msg.waId, job.id);
    repos.jobs.apply(job.id, { type: "start" });
    return { type: "new", jobId: job.id };
  }

  async function process(msg: InboundMessage): Promise<void> {
    if (!config.reps.allowlist.includes(msg.from)) {
      log.warn("message from a number outside REP_ALLOWLIST ignored", { from: msg.from });
      return;
    }
    const route = routeMessage(msg);
    void wa.markRead(msg.waId).catch(() => {});
    switch (route.type) {
      case "button": {
        const watchButton = WATCH_BUTTON.exec(msg.button?.id ?? "");
        if (watchButton) {
          await onWatchButton(
            msg.from,
            watchButton[1] as string,
            Number(watchButton[2]),
            watchButton[3] as string,
          );
          return;
        }
        const status = approvals.resolveFromButton(msg.button?.id ?? "", msg.from, msg.waId);
        if (status === "unknown")
          await wa.sendText(msg.from, "That button is no longer active. Nothing changed.");
        return;
      }
      case "command": {
        if (/^\/watch\b/i.test(msg.text?.trim() ?? "")) {
          const name = msg.text?.trim().split(/\s+/)[1];
          const names = name ? [name] : deps.skills.list().map((r) => r.name);
          const body =
            names.length === 0
              ? "No skills to watch yet."
              : names.length === 1
                ? `Checking ${names[0]} with a dry run on its portal. Nothing is submitted.`
                : `Checking ${names.length} skills with dry runs on their portals. Nothing is submitted.`;
          const waId = await wa.sendText(msg.from, body);
          repos.messages.insertOutbound({ waId, to: msg.from, jobId: null, kind: "text", text: body });
          if (names.length > 0)
            spawn("drift watch", () =>
              watchNow({ trigger: "command", rep: msg.from, ...(name ? { skill: name } : {}) }),
            );
          return;
        }
        const rep = repProfile(repos, msg.from);
        const body = runCommand(msg.text ?? "", {
          skills: deps.skills,
          repos,
          ledger,
          rep: { phone: rep.phone, tz: rep.tz },
          portalNames: Object.fromEntries(Object.values(deps.portals).map((p) => [p.id, p.name])),
        });
        const waId = await wa.sendText(msg.from, body);
        repos.messages.insertOutbound({ waId, to: msg.from, jobId: null, kind: "text", text: body });
        return;
      }
      case "unsupported":
        await wa.sendText(msg.from, UNSUPPORTED_MEDIA);
        return;
      case "skip":
        return;
      case "cancel":
        approvals.resolve(route.gateId, "rejected", msg.from, msg.waId);
        return;
      case "answer":
        textAnswers.set(route.gateId, (msg.text ?? "").trim());
        if (approvals.resolve(route.gateId, "approved", msg.from, msg.waId) !== "resolved")
          textAnswers.delete(route.gateId);
        return;
      case "edit": {
        if (approvals.resolve(route.gateId, "edit", msg.from, msg.waId) !== "resolved") return;
        repos.jobs.apply(route.jobId, { type: "input", waId: msg.waId });
        await understandJob(route.jobId, msg);
        return;
      }
      case "new":
      case "input":
        await understandJob(route.jobId, msg);
        return;
    }
  }

  // ---- intake + understanding + plan ----

  async function intakeItem(
    row: MessageRow,
    msg: InboundMessage | undefined,
    job: JobCtx,
  ): Promise<IntakeItem> {
    const cached = intakeCache.get(row.waId);
    if (cached) return cached;
    let item: IntakeItem;
    if (msg?.waId === row.waId && msg.media) {
      const kind = classifyMedia(msg);
      const media = await downloadMedia(msg, job.id, { wa, artifacts: deps.artifacts });
      repos.messages.setMedia(row.waId, media.id);
      item = { waId: row.waId, kind, media, ...(msg.text ? { text: msg.text } : {}) };
    } else if (row.mediaArtifactId) {
      const media = deps.artifacts.get(row.mediaArtifactId);
      item = {
        waId: row.waId,
        kind: classifyMedia({ kind: "document", media: { mediaId: "", mime: media.mime } }),
        media,
        ...(row.text ? { text: row.text } : {}),
      };
    } else {
      item = { waId: row.waId, kind: "text", ...(row.text ? { text: row.text } : {}) };
    }
    if (item.kind === "voice" || item.kind === "photo" || item.kind === "pdf") {
      item = await analyzeMedia(
        item,
        { jobId: job.id, rep: job.rep, keywords: keywords() },
        { wa, artifacts: deps.artifacts, models, log, ffmpegPath: config.ffmpegPath, tmpDir },
      );
    }
    intakeCache.set(row.waId, item);
    return item;
  }

  function keywords(): string[] {
    const examples: string[] = [];
    for (const s of deps.skills.list()) {
      if (deps.skills.active(s.name)?.portalId === ESPOCRM) continue;
      for (const p of deps.skills.active(s.name)?.params ?? []) {
        if (p.example && (p.type === "string" || p.type === "enum")) examples.push(p.example);
        for (const v of p.enumValues ?? []) examples.push(v);
      }
    }
    return transcriptionKeywords({ companies: repos.jobs.recentCompanies(20), skillExamples: examples });
  }

  function knownSkills(): KnownSkill[] {
    return deps.skills.list().flatMap((row) => {
      const s = deps.skills.active(row.name);
      return s && s.portalId !== ESPOCRM
        ? [
            {
              name: s.name,
              title: s.title,
              params: s.params.map(({ name, type, required, description }) => ({
                name,
                type,
                required,
                description,
              })),
            },
          ]
        : [];
    });
  }

  function inputsOf(items: IntakeItem[]): UnderstandInput[] {
    return items.flatMap((i): UnderstandInput[] => {
      if (i.kind === "voice") return i.transcript ? [{ kind: "voice", text: i.transcript.text }] : [];
      if ((i.kind === "photo" || i.kind === "pdf") && i.extraction) {
        return [
          { kind: "document", source: i.kind === "photo" ? "photo" : "pdf", extraction: i.extraction },
          ...(i.text ? [{ kind: "caption" as const, text: i.text }] : []),
        ];
      }
      return i.text ? [{ kind: i.kind === "text" ? "text" : "caption", text: i.text }] : [];
    });
  }

  async function understandJob(jobId: Id, msg: InboundMessage): Promise<void> {
    const row = repos.jobs.get(jobId);
    if (!row) return;
    const job = jobCtx(row);
    try {
      const items: IntakeItem[] = [];
      for (const m of repos.messages.inboundForJob(jobId)) items.push(await intakeItem(m, msg, job));
      const video = items.find((i) => i.kind === "video");
      const inputs = inputsOf(items);
      // A request that names EspoCRM gets the lead understanding call; everything else is unchanged.
      const lead =
        !video && deps.portals[ESPOCRM] && inputsMentionEspo(inputs)
          ? await understandLead(models, inputs, { jobId, timeoutMs: 45_000 })
          : null;
      const u: Understanding = video
        ? teachUnderstanding(video.text)
        : lead
          ? leadToUnderstanding(lead)
          : await understand(
              models,
              { rep: job.rep, nowMs: clock.now(), inputs, skills: knownSkills() },
              { jobId, timeoutMs: 45_000 },
            );
      repos.jobs.update(jobId, {
        understanding: u,
        intent: lead ? "create_lead" : u.intent,
        language: u.language,
      });
      const kit = await company();
      const planCtx = {
        jobId,
        skills: deps.skills,
        rep: job.rep,
        company: kit.profile,
        companyFiles: kit.files,
        attachments: items.flatMap((i) => (i.media ? [i.media] : [])),
        clock,
        portals: portalInfos,
      };
      const outcome = lead ? planLead(lead, planCtx) : buildPlan(u, planCtx);
      if (outcome.type === "ask") {
        repos.jobs.apply(jobId, { type: "understood", missing: outcome.missing, writes: false });
        await sendText(env, job, outcome.question);
        return;
      }
      if (outcome.type === "reply") {
        repos.jobs.apply(jobId, { type: "understood", missing: [], writes: false });
        // Not a task, while a card is waiting for the rep: point at the card instead of the help text.
        const waiting =
          u.intent === "unknown" || u.intent === "question"
            ? repos.gates.pendingForRep(job.rep.phone).find((g) => g.jobId !== jobId)
            : undefined;
        await sendText(env, job, waiting ? WAITING_ON_CARD : outcome.text);
        finish(jobId, { ok: true });
        return;
      }
      const plan = outcome.plan;
      repos.jobs.update(jobId, { plan });
      if (!plan.writes) {
        repos.jobs.apply(jobId, { type: "understood", missing: [], writes: false });
        spawn("execute", () => execute(jobId, video?.text));
        return;
      }
      repos.jobs.apply(jobId, { type: "understood", missing: [], writes: true });
      const { decision } = await approvals.open({
        jobId,
        kind: "plan",
        to: job.rep.phone,
        body: plan.approvalText,
        ttlMs: approvals.defaultTtlMs,
      });
      spawn("plan gate", () => afterPlanGate(jobId, decision));
    } catch (err) {
      log.error("understanding failed", { jobId, err });
      const code = codeOf(err);
      repos.jobs.update(jobId, { error: { code, message: messageOf(err) } });
      repos.jobs.apply(jobId, { type: "finished", ok: false, errorCode: code });
      await trySend(env, job, intakeFailure(code));
    }
  }

  async function afterPlanGate(jobId: Id, decision: Promise<GateDecision>): Promise<void> {
    const d = await park(decision);
    const row = repos.jobs.get(jobId);
    if (!row) return;
    if (d === "approved") return execute(jobId);
    // The job's status says why the gate closed (a boot sweep fails the job and has already told the rep).
    if (d === "rejected" && row.status === "cancelled")
      await trySend(env, jobCtx(row), "Cancelled. Nothing was written.");
    if (d === "expired" && row.status === "expired")
      await trySend(env, jobCtx(row), "This request expired. Send it again to retry.");
    // "edit": the text that edited it re-plans the job in handle().
  }

  // ---- execution ----

  async function execute(jobId: Id, caption?: string): Promise<void> {
    const row = repos.jobs.get(jobId);
    if (!row?.plan) return;
    const job = jobCtx(row);
    const plan = row.plan;
    let outcome: FlowOutcome = { ok: true };
    try {
      if (plan.intent === "quote") outcome = await runQuote(env, job, plan, row.understanding);
      else {
        for (const action of plan.actions) {
          if (action.kind === "skill_replay") outcome = await runReplay(env, job, action);
          else if (action.kind === "computer_use") outcome = await runFirstRun(env, job, action);
          else if (action.kind === "teach") outcome = await runTeach(env, job, action, caption);
          else throw new DockhandError("TOOL_ERROR", `no flow runs ${action.kind} outside a quote`);
          if (!outcome.ok) break;
        }
      }
    } catch (err) {
      log.error("execution failed", { jobId, err });
      outcome = { ok: false, errorCode: codeOf(err) };
      repos.jobs.update(jobId, { error: { code: codeOf(err), message: messageOf(err) } });
      await trySend(env, job, "Something went wrong on my side, so I stopped. Nothing else was submitted.");
    }
    finish(jobId, outcome);
  }

  /** `finished` applies only while executing: a rejected or expired gate already ended the job. */
  function finish(jobId: Id, o: FlowOutcome): void {
    if (repos.jobs.get(jobId)?.status !== "executing") return;
    repos.jobs.apply(jobId, {
      type: "finished",
      ok: o.ok,
      ...(o.errorCode ? { errorCode: o.errorCode } : {}),
    });
  }

  // ---- lifecycle ----

  let sweep: ReturnType<typeof setInterval> | undefined;
  let watchTimer: ReturnType<typeof setInterval> | undefined;
  let watching: Promise<WatchOutcome[]> | undefined;

  /** The rep a background watch reports to: whoever last ran the skill, else the first allow-listed rep. */
  function watchRep(skill: string): string | undefined {
    const row = db.raw
      .prepare(
        `SELECT j.rep FROM runs r JOIN jobs j ON j.id = r.job_id
         WHERE r.skill_name = ? AND r.eval_suite IS NULL ORDER BY r.started_at DESC, r.rowid DESC LIMIT 1`,
      )
      .get(skill) as { rep: string } | undefined;
    return row?.rep ?? config.reps.allowlist[0];
  }

  /** One watch at a time; a second call waits for (and returns) the one in progress. */
  function watchNow(
    o: { skill?: string; trigger?: WatchTrigger; rep?: string } = {},
  ): Promise<WatchOutcome[]> {
    if (watching) return watching;
    watching = (async () => {
      const outcomes: WatchOutcome[] = [];
      const names = o.skill ? [o.skill] : deps.skills.list().map((r) => r.name);
      for (const name of names) {
        const rep = o.rep ?? watchRep(name);
        if (!rep) continue;
        try {
          outcomes.push(await watchSkill(env, { skill: name, trigger: o.trigger ?? "schedule", rep }));
        } catch (err) {
          log.error("drift watch failed", { skill: name, err });
        }
      }
      // On demand, the rep asked: say so when every skill still matches (a scheduled watch stays quiet).
      if (
        o.trigger === "command" &&
        o.rep &&
        outcomes.length > 0 &&
        outcomes.every((x) => x.outcome === "verified")
      ) {
        const body =
          outcomes.length === 1
            ? `${outcomes[0]?.skill} still matches its portal: every step resolved and read back in a dry run. Nothing to do.`
            : `All ${outcomes.length} skills still match their portals: every step resolved and read back in dry runs. Nothing to do.`;
        const waId = await wa.sendText(o.rep, body);
        repos.messages.insertOutbound({ waId, to: o.rep, jobId: null, kind: "text", text: body });
      }
      const skipped = outcomes.filter((x) => x.outcome === "skipped").map((x) => x.skill);
      if (o.trigger === "command" && o.rep && skipped.length > 0) {
        const body = `I couldn't dry-run ${skipped.join(", ")}: a required value has no sample yet. The next real request checks it.`;
        const waId = await wa.sendText(o.rep, body);
        repos.messages.insertOutbound({ waId, to: o.rep, jobId: null, kind: "text", text: body });
      }
      return outcomes;
    })().finally(() => {
      watching = undefined;
    });
    return watching;
  }

  async function onWatchButton(rep: string, name: string, version: number, what: string): Promise<void> {
    const reply = async (body: string) => {
      const waId = await wa.sendText(rep, body);
      repos.messages.insertOutbound({ waId, to: rep, jobId: null, kind: "text", text: body });
    };
    const saved = deps.skills.get(name, version);
    if (!saved) return reply("That skill version is gone. Nothing changed.");
    const parent = saved.parentVersion;
    if (what === "rb") {
      const active = deps.skills.active(name)?.version;
      if (!parent) return reply(`${name} v${version} has no earlier version. Nothing changed.`);
      if (active === parent) return reply(`Already rolled back: ${name} v${parent} is active.`);
      if (active !== version)
        return reply(
          `${name} v${active} is active now, so I left it alone. /rollback ${name} <version> picks one.`,
        );
      deps.skills.activate(name, parent);
      return reply(
        `Rolled back: ${name} v${parent} is active (v${version} kept: /rollback ${name} ${version}).`,
      );
    }
    const d = watchDetails(env, name, version);
    const before = parent ? deps.skills.get(name, parent) : undefined;
    const card = await env.phoneCards.render(
      `watch-${name}-${version}`,
      diffPhoneCardHtml({
        portalName: deps.portals[saved.portalId]?.name ?? saved.portalId,
        parent: before ?? saved,
        saved,
        steps: d.steps,
        canary: { passed: WATCH_CANARY_RUNS, total: WATCH_CANARY_RUNS },
        costUsd: d.costUsd,
        usedOpenWeights: d.sourceRunId ? realOpenWeights(env, "", d.sourceRunId) : false,
      }),
    );
    const caption = [
      `*${name} v${parent ?? "?"} → v${version}*`,
      d.summary ?? "No step changes recorded.",
    ].join("\n");
    const waId = await wa.sendImage(rep, card, caption);
    repos.messages.insertOutbound({ waId, to: rep, jobId: null, kind: "image", text: caption });
  }

  return {
    handle(msg) {
      return run(() => withRepLock(msg.from, () => process(msg)));
    },

    async recover() {
      for (const job of repos.jobs.inFlight()) {
        repos.jobs.update(job.id, { error: { code: "CRASH_RECOVERED", message: "process restarted" } });
        repos.jobs.apply(job.id, { type: "crash_recovered" });
        approvals.expireForJob(job.id);
        await trySend(env, jobCtx(job), RESTART_MESSAGE);
      }
      const unknown = repos.toolCalls.markStartedUnknown();
      if (unknown.length > 0)
        log.warn("tool calls with unknown outcome after restart", { keys: unknown.map((u) => u.idemKey) });
      repos.runs.markUnfinished();
      approvals.expireDue();
      const every = deps.expirySweepMs ?? 30_000;
      if (every > 0 && !sweep) {
        sweep = setInterval(() => {
          try {
            approvals.expireDue();
          } catch (err) {
            log.error("expiry sweep failed", { err });
          }
        }, every);
        sweep.unref?.();
      }
      if ((deps.watchEveryMs ?? 0) > 0 && !watchTimer) {
        watchTimer = setInterval(
          () => spawn("drift watch", () => watchNow({ trigger: "schedule" })),
          deps.watchEveryMs,
        );
        watchTimer.unref?.();
      }
    },

    watch(o) {
      return run(() => watchNow(o));
    },

    async drain() {
      for (;;) {
        if (active > 0) await new Promise<void>((resolve) => idleWaiters.push(resolve));
        await new Promise((resolve) => setImmediate(resolve)); // let tasks resumed by a gate re-enter
        await approvals.flush();
        if (active === 0) return;
      }
    },

    close() {
      if (sweep) clearInterval(sweep);
      sweep = undefined;
      if (watchTimer) clearInterval(watchTimer);
      watchTimer = undefined;
    },
  };
}

function codeOf(err: unknown): ErrorCode {
  return err instanceof DockhandError ? err.code : "TOOL_ERROR";
}

function messageOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

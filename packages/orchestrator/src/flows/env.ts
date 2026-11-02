// What every flow gets: dependencies, messaging that records outbound rows, approval gates, costs.

import type {
  ArtifactRef,
  ArtifactStore,
  BrowserPool,
  Clock,
  ComputerUseModel,
  Config,
  CrmClient,
  CuHooks,
  Db,
  Decision,
  Id,
  Ledger,
  Logger,
  ModelGateway,
  ParamValue,
  Purpose,
  QuoteService,
  RepProfile,
  RunHooks,
  SkillStore,
  WhatsAppClient,
} from "@dockhand/core";
import type { Page } from "playwright";
import type { DockhandApprovalBroker, GateDecision } from "../approvals.ts";
import { clipText } from "../messages.ts";
import type { PortalDirectory } from "../portals.ts";
import type { CompanyKit } from "../profile.ts";
import type { Repos } from "../repo.ts";
import { askPhoneCardHtml, type PhoneCards, submitPhoneCardHtml } from "../tools/phone-cards.ts";
import type { CardRenderer } from "../tools/receipts.ts";

/** What a model source learns about the session it serves (scripted stand-ins script from it). */
export interface CuSessionInfo {
  page: Page;
  purpose: "cu_first_run" | "cu_repair";
  runId: Id;
  portalId: string;
  /** The run's values (a first run's, or the replay's being repaired). */
  params: Record<string, ParamValue>;
}

/** A model for one browser page (the scripted CI model needs the page; real models ignore it). */
export type CuModelSource = ComputerUseModel | ((o: CuSessionInfo) => ComputerUseModel);

export interface FlowEnv {
  db: Db;
  repos: Repos;
  clock: Clock;
  log: Logger;
  config: Config;
  wa: WhatsAppClient;
  models: ModelGateway;
  ledger: Ledger;
  pool: BrowserPool;
  skills: SkillStore;
  crm: CrmClient;
  quotes: QuoteService;
  artifacts: ArtifactStore;
  approvals: DockhandApprovalBroker;
  portals: PortalDirectory;
  cards: CardRenderer;
  /** Phone-sized 2x cards (teach, skill diff, drift watch): tools/phone-cards.ts. */
  phoneCards: PhoneCards;
  company: () => Promise<CompanyKit>;
  cu: CuModelSource;
  repairCu: CuModelSource;
  /** Marks the calling task as waiting on a person (drain() does not wait for it). */
  park<T>(p: Promise<T>): Promise<T>;
  /** Text answers to question gates, keyed by gate id (set before the gate resolves). */
  textAnswers: Map<Id, string>;
  gateTtlMs: number;
  stepTimeoutMs: number;
}

export interface JobCtx {
  id: Id;
  rep: RepProfile;
}

export function modelFor(source: CuModelSource, o: CuSessionInfo): ComputerUseModel {
  return typeof source === "function" ? source(o) : source;
}

// ---------- messaging (every outbound message is linked to its job, so replies attach) ----------

export async function sendText(env: FlowEnv, job: JobCtx, body: string): Promise<string> {
  const waId = await env.wa.sendText(job.rep.phone, body);
  env.repos.messages.insertOutbound({ waId, to: job.rep.phone, jobId: job.id, kind: "text", text: body });
  return waId;
}

export async function sendImage(
  env: FlowEnv,
  job: JobCtx,
  image: ArtifactRef,
  caption?: string,
): Promise<string> {
  const waId = await env.wa.sendImage(job.rep.phone, image, caption);
  env.repos.messages.insertOutbound({
    waId,
    to: job.rep.phone,
    jobId: job.id,
    kind: "image",
    ...(caption ? { text: caption } : {}),
  });
  return waId;
}

export async function sendDocument(
  env: FlowEnv,
  job: JobCtx,
  doc: ArtifactRef,
  filename: string,
  caption?: string,
): Promise<string> {
  const waId = await env.wa.sendDocument(job.rep.phone, doc, filename, caption);
  env.repos.messages.insertOutbound({
    waId,
    to: job.rep.phone,
    jobId: job.id,
    kind: "document",
    ...(caption ? { text: caption } : {}),
  });
  return waId;
}

/** Best effort: a failed progress or courtesy message never fails the job. */
export async function trySend(env: FlowEnv, job: JobCtx, body: string): Promise<void> {
  try {
    await sendText(env, job, body);
  } catch (err) {
    env.log.warn("message not sent", { jobId: job.id, err });
  }
}

// ---------- costs ----------

export const INTAKE_PURPOSES: Purpose[] = ["transcribe", "extract", "understand"];

export function intakeCost(env: FlowEnv, jobId: Id): number {
  return env.ledger.totals({ jobId, purposes: INTAKE_PURPOSES }).costUsd;
}

export function runTotals(env: FlowEnv, runId: Id): { calls: number; costUsd: number } {
  const t = env.ledger.totals({ runId });
  return { calls: t.calls, costUsd: t.costUsd };
}

// ---------- gates ----------

/** Room for read-back lines in a submit message (WhatsApp caps a button message's body at 1024 characters). */
const READBACK_CHARS = 880;

/** As many lines as fit in `max` characters, then how many are left: the rest are on the form in the picture. */
function listWithin(lines: string[], max: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > max) {
      out.push(`${lines.length - out.length} more on the form above.`);
      break;
    }
    out.push(line);
    used += line.length + 1;
  }
  return out;
}

/** Approval hooks for a browser run: commit and safety gates in WhatsApp, with the screenshot as header. */
export function gateHooks(
  env: FlowEnv,
  job: JobCtx,
  run: { runId: Id; origin: string; portalName: string; extendLease: (ms: number) => void },
): CuHooks & Pick<RunHooks, "askRep"> {
  const open = async (
    kind: "commit" | "safety" | "question",
    body: string,
    image: ArtifactRef,
    buttons?: Parameters<DockhandApprovalBroker["open"]>[0]["buttons"],
  ) => {
    run.extendLease(env.gateTtlMs + 5 * 60_000);
    const { gateId, decision } = await env.approvals.open({
      jobId: job.id,
      runId: run.runId,
      kind,
      to: job.rep.phone,
      body,
      image,
      ttlMs: env.gateTtlMs,
      origin: run.origin,
      ...(buttons ? { buttons } : {}),
    });
    return { gateId, decision: await env.park(decision) };
  };
  /** A card around the page's screenshot; the bare screenshot when the card cannot be drawn. */
  const cardOr = async (shot: ArtifactRef, html: (bytes?: Uint8Array) => string): Promise<ArtifactRef> => {
    try {
      const bytes = await env.artifacts.read(shot).catch(() => undefined);
      return await env.phoneCards.render(job.id, html(bytes));
    } catch (err) {
      env.log.warn("approval card not rendered", { jobId: job.id, err });
      return shot;
    }
  };
  /** Fields the rep answered during this run: their read-back values are named in the submit message. */
  const answered = new Set<string>();
  return {
    async approveCommit(r) {
      const lines = (r.readback ?? []).filter((f) => f.value.trim() !== "" && f.value !== "false");
      // The card shows the filled form; the message lists every value read back, in sharp text the rep can check
      // (raw: a field that reads "true" must look wrong, not like a ticked box). The company and anything the rep
      // just answered come first, and nothing is sent before the tap.
      const company = lines.find((f) => /company|customer|account|legal name/i.test(f.label));
      const named = [
        ...(company ? [company] : []),
        ...lines.filter((f) => answered.has(f.label) && f !== company),
      ];
      const ordered = [...named, ...lines.filter((f) => !named.includes(f))];
      const body = [
        lines.length > 0
          ? `Ready to submit on ${run.portalName}. ${lines.length} fields, read back from the page:`
          : `Ready to submit on ${run.portalName}. Check the review page on the card.`,
        ...listWithin(
          ordered.map((f) => `${f.label}: ${f.value}`),
          READBACK_CHARS,
        ),
        "Approve to submit. Nothing is sent until you tap.",
      ].join("\n");
      const card = await cardOr(r.screenshot, (shot) =>
        submitPhoneCardHtml({
          portalName: run.portalName,
          readback: r.readback ?? [],
          ...(shot ? { screenshot: shot } : {}),
          ...(r.highlight ? { highlight: r.highlight } : {}),
        }),
      );
      const { decision } = await open("commit", body, card);
      return asDecision(decision);
    },
    async approveSafety(r) {
      const body = [
        `${run.portalName} raised a safety check:`,
        ...r.checks.map((c) => c.message),
        "Continue?",
      ].join("\n");
      const { decision } = await open("safety", body, r.screenshot);
      return asDecision(decision);
    },
    async askRep(q) {
      const options = (q.options ?? []).filter((o) => o.trim() !== "");
      const buttons =
        options.length > 0 && options.length <= 3
          ? options.map((o, i) => ({ id: `opt${i}` as const, title: o }))
          : undefined;
      const body = [
        `${run.portalName} now asks for "${q.label}", and I have no value for it.`,
        options.length > 3 ? clipText(`Options: ${options.join(", ")}.`, 400) : "",
        buttons
          ? `Tap one, or reply with the value ("skip" stops here). I'll remember it.`
          : `Reply with the value ("skip" stops here). I'll remember it.`,
      ]
        .filter(Boolean)
        .join("\n");
      const card = await cardOr(q.screenshot, (shot) =>
        askPhoneCardHtml({
          portalName: run.portalName,
          label: q.label,
          options,
          ...(shot ? { screenshot: shot } : {}),
        }),
      );
      const { gateId, decision } = await open(
        "question",
        body,
        card,
        buttons ?? [{ id: "reject", title: "Skip" }],
      );
      const answer = decision.startsWith("opt")
        ? (options[Number(decision.slice(3))] ?? null)
        : decision === "approved"
          ? (env.textAnswers.get(gateId) ?? null)
          : null;
      if (answer !== null) answered.add(q.label);
      return answer;
    },
  };
}

function asDecision(d: GateDecision): Decision {
  return d.startsWith("opt") ? "approved" : (d as Decision);
}

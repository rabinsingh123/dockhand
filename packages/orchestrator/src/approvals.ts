// Approval broker: gate rows with a TTL, WhatsApp reply buttons, and the in-memory promise a waiting
// flow holds. The database decides (T2 compare-and-set); the promise only follows the database.

import type {
  ApprovalBroker,
  ArtifactRef,
  ArtifactStore,
  Button,
  Clock,
  Db,
  Decision,
  GateKind,
  Id,
  Logger,
  WhatsAppClient,
} from "@dockhand/core";
import { ulid } from "@dockhand/core";
import { createRepos, type GateRow } from "./repo.ts";

export type GateDecision = Decision | `opt${number}`;
/** What a tap or a text reply can decide (expiry is the broker's call, never the rep's). */
export type RepDecision = Exclude<GateDecision, "expired">;
export type ResolveStatus = ReturnType<ApprovalBroker["resolveFromButton"]>;

export type GateButtonId = "approve" | "reject" | "edit" | `opt${number}`;

export interface GateOpen {
  jobId: Id;
  runId?: Id;
  kind: GateKind;
  to: string;
  body: string;
  image?: ArtifactRef;
  ttlMs: number;
  buttons?: { id: GateButtonId; title: string }[];
  /**
   * The portal origin this gate is about (commit and safety gates). Eval auto-approve applies only
   * when it is a localhost origin the broker was configured with; callers never pass a flag.
   */
  origin?: string;
}

export interface DockhandApprovalBroker extends ApprovalBroker {
  open(g: GateOpen): Promise<{ gateId: Id; decision: Promise<GateDecision> }>;
  /** Default TTL: 60 min in demo mode, else 20 min. */
  readonly defaultTtlMs: number;
  /** Same rules as a button tap, for text replies (question answers, plan edits). */
  resolve(gateId: Id, decision: RepDecision, from: string, waId: string): ResolveStatus;
  /** Boot sweep: expires a job's pending gates without touching the job (it is failed separately). */
  expireForJob(jobId: Id): number;
  /** Waits for the one-line replies sent to late, duplicate or foreign taps. */
  flush(): Promise<void>;
}

export interface ApprovalBrokerDeps {
  db: Db;
  wa: WhatsAppClient;
  clock: Clock;
  log: Logger;
  artifacts: ArtifactStore;
  demoMode?: boolean;
  /** Evals only. Every origin must be http(s) on localhost, 127.0.0.1 or [::1]; anything else throws. */
  evalAutoApprove?: { origins: string[] };
}

export const GATE_TTL_MS = 20 * 60_000;
export const DEMO_GATE_TTL_MS = 60 * 60_000;

export function gateTtlMs(demoMode: boolean): number {
  return demoMode ? DEMO_GATE_TTL_MS : GATE_TTL_MS;
}

const DEFAULT_BUTTONS: Record<GateKind, { id: GateButtonId; title: string }[]> = {
  plan: [
    { id: "approve", title: "Approve" },
    { id: "reject", title: "Cancel" },
  ],
  commit: [
    { id: "approve", title: "Approve" },
    { id: "reject", title: "Cancel" },
  ],
  safety: [
    { id: "approve", title: "Continue" },
    { id: "reject", title: "Stop" },
  ],
  skill_confirm: [
    { id: "approve", title: "Looks right" },
    { id: "reject", title: "Cancel" },
  ],
  skill_patch: [
    { id: "approve", title: "Approve" },
    { id: "reject", title: "Keep old version" },
  ],
  question: [{ id: "reject", title: "Skip" }],
};

export const REPLIES = {
  expired: "This request expired. Send it again to retry.",
  alreadyResolved: "Already handled. Nothing changed.",
  wrongSender: "That button belongs to someone else's request. Nothing changed.",
} as const;

const MAX_BODY = 1024;
const MAX_TITLE = 20;

/** `g:<gateId>:<a|r|e|oN>` */
export function buttonId(gateId: Id, id: GateButtonId): string {
  if (id === "approve") return `g:${gateId}:a`;
  if (id === "reject") return `g:${gateId}:r`;
  if (id === "edit") return `g:${gateId}:e`;
  return `g:${gateId}:o${id.slice(3)}`;
}

export function parseButtonId(raw: string): { gateId: Id; decision: RepDecision } | null {
  const m = /^g:([0-9A-Za-z]+):(a|r|e|o\d{1,2})$/.exec(raw.trim());
  if (!m?.[1] || !m[2]) return null;
  const code = m[2];
  const decision: RepDecision =
    code === "a"
      ? "approved"
      : code === "r"
        ? "rejected"
        : code === "e"
          ? "edit"
          : `opt${Number(code.slice(1))}`;
  return { gateId: m[1], decision };
}

/** What the job state machine sees: an option tap or a text answer lets the job continue. */
function jobDecision(d: GateDecision): Decision {
  return d.startsWith("opt") ? "approved" : (d as Decision);
}

export function createApprovalBroker(deps: ApprovalBrokerDeps): DockhandApprovalBroker {
  const { db, wa, clock, log } = deps;
  const repos = createRepos(db, clock);
  const autoOrigins = new Set((deps.evalAutoApprove?.origins ?? []).map(localOriginOrThrow));
  const waiters = new Map<Id, (d: GateDecision) => void>();
  const sends = new Set<Promise<unknown>>();
  const defaultTtlMs = gateTtlMs(deps.demoMode ?? false);

  const reply = (to: string, body: string) => {
    const p = wa.sendText(to, body).catch((err) => log.warn("gate reply failed", { err }));
    sends.add(p);
    void p.finally(() => sends.delete(p));
  };

  const settle = (gateId: Id, d: GateDecision) => {
    const resolve = waiters.get(gateId);
    waiters.delete(gateId);
    resolve?.(d);
  };

  /** T5 for one gate: gate expired + job transition + event row, then the waiting flow hears "expired". */
  const expireGate = (g: GateRow, now: number): boolean => {
    const changed = db.tx(() => {
      if (!repos.gates.expire(g.id, now)) return false;
      repos.jobs.apply(g.jobId, { type: "gate_resolved", gateId: g.id, decision: "expired" });
      return true;
    });
    if (changed) settle(g.id, "expired");
    return changed;
  };

  const resolveGate = (gateId: Id, decision: RepDecision, from: string, waId: string): ResolveStatus => {
    const gate = repos.gates.get(gateId);
    if (!gate) return "unknown";
    const job = repos.jobs.get(gate.jobId);
    if (!job || job.rep !== from) {
      reply(from, REPLIES.wrongSender);
      return "wrong_sender";
    }
    const now = clock.now();
    const resolved = db.tx(() => {
      if (!repos.gates.resolve(gate.id, decision, waId, now)) return false;
      repos.jobs.apply(gate.jobId, {
        type: "gate_resolved",
        gateId: gate.id,
        decision: jobDecision(decision),
      });
      return true;
    });
    if (resolved) {
      settle(gate.id, decision);
      return "resolved";
    }
    const current = repos.gates.get(gate.id);
    if (current?.status === "expired" || (current?.status === "pending" && current.expiresAt <= now)) {
      if (current.status === "pending") expireGate(current, now);
      reply(from, REPLIES.expired);
      return "expired";
    }
    reply(from, REPLIES.alreadyResolved);
    return "already_resolved";
  };

  return {
    defaultTtlMs,

    async open(g) {
      const gateId = ulid(clock);
      const now = clock.now();
      const auto = autoApproves(g);
      db.tx(() => {
        repos.gates.insert({
          id: gateId,
          jobId: g.jobId,
          runId: g.runId ?? null,
          kind: g.kind,
          body: g.body,
          imageArtifactId: g.image?.id ?? null,
          expiresAt: now + g.ttlMs,
        });
        // A plan gate opens together with the `understood` transition (the caller applies it).
        if (g.kind !== "plan") repos.jobs.apply(g.jobId, { type: "gate_open", gateId });
      });

      if (auto) {
        const decision: RepDecision = g.kind === "question" ? "rejected" : "approved";
        resolveGate(gateId, decision, repos.jobs.get(g.jobId)?.rep ?? g.to, `auto:eval:${gateId}`);
        log.info("gate auto-approved for a localhost portal", { gateId, kind: g.kind, decision });
        return { gateId, decision: Promise.resolve(decision) };
      }

      const decision = new Promise<GateDecision>((resolve) => waiters.set(gateId, resolve));
      const buttons = (g.buttons ?? DEFAULT_BUTTONS[g.kind])
        .slice(0, 3)
        .map((b): Button => ({ id: buttonId(gateId, b.id), title: clip(b.title, MAX_TITLE) }));
      try {
        const waId = await wa.sendButtons(g.to, clip(g.body, MAX_BODY), uniqueTitles(buttons), {
          ...(g.image ? { headerImage: g.image } : {}),
        });
        db.tx(() => {
          repos.gates.setWaId(gateId, waId);
          repos.messages.insertOutbound({
            waId,
            to: g.to,
            jobId: g.jobId,
            kind: "interactive",
            text: g.body,
          });
        });
      } catch (err) {
        // Nobody can tap a card that never arrived: expire the gate so the flow stops cleanly.
        log.error("could not send the approval card", { gateId, kind: g.kind, err });
        const row = repos.gates.get(gateId);
        if (row) expireGate(row, clock.now());
      }
      return { gateId, decision };
    },

    resolveFromButton(rawId, from, waId) {
      const parsed = parseButtonId(rawId);
      if (!parsed) return "unknown";
      return resolveGate(parsed.gateId, parsed.decision, from, waId);
    },

    resolve: resolveGate,

    expireDue() {
      const now = clock.now();
      let n = 0;
      for (const g of repos.gates.due(now)) if (expireGate(g, now)) n++;
      return n;
    },

    expireForJob(jobId) {
      const now = clock.now();
      let n = 0;
      for (const g of repos.gates.pendingForJob(jobId)) {
        if (repos.gates.expire(g.id, now)) {
          n++;
          settle(g.id, "expired");
        }
      }
      return n;
    },

    async flush() {
      while (sends.size > 0) await Promise.allSettled([...sends]);
    },
  };

  function autoApproves(g: GateOpen): boolean {
    if (autoOrigins.size === 0 || !g.origin) return false;
    const origin = safeLocalOrigin(g.origin);
    return origin !== null && autoOrigins.has(origin);
  }
}

function clip(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : `${chars.slice(0, max - 1).join("")}…`;
}

/** WhatsApp rejects duplicate titles; clipping can create them, so number the repeats. */
function uniqueTitles(buttons: Button[]): Button[] {
  const seen = new Set<string>();
  return buttons.map((b) => {
    let title = b.title;
    for (let i = 2; seen.has(title); i++) title = `${clip(b.title, MAX_TITLE - 3)} ${i}`;
    seen.add(title);
    return { ...b, title };
  });
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function safeLocalOrigin(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return LOCAL_HOSTS.has(url.hostname) ? url.origin : null;
  } catch {
    return null;
  }
}

function localOriginOrThrow(raw: string): string {
  const origin = safeLocalOrigin(raw);
  if (!origin) throw new Error(`eval auto-approve only works against localhost portals, not "${raw}"`);
  return origin;
}

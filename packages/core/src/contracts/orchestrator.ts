import { z } from "zod";
import type { ArtifactRef, Clock, ErrorCode, Id } from "./base.ts";
import type { Decision, ParamValue } from "./browser.ts";
import type { Transcript } from "./models.ts";
import type { SkillStore } from "./skills.ts";

export type JobStatus =
  | "received"
  | "understanding"
  | "awaiting_input"
  | "awaiting_approval"
  | "executing"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

export type JobEvent =
  | { type: "start" }
  | { type: "understood"; missing: string[]; writes: boolean }
  | { type: "input"; waId: string }
  | { type: "gate_open"; gateId: Id }
  | { type: "gate_resolved"; gateId: Id; decision: Decision }
  | { type: "finished"; ok: boolean; errorCode?: ErrorCode }
  | { type: "cancel" }
  | { type: "crash_recovered" };

export const Intent = z.enum([
  "quote",
  "register_deal",
  "supplier_onboarding",
  "teach",
  "command",
  "question",
  "unknown",
]);
export type Intent = z.infer<typeof Intent>;
/**
 * Additive: what a plan or a job is for. The Understanding intents, plus create_lead (EspoCRM), which its own
 * understanding call sets (packages/orchestrator/src/espocrm.ts): the general understanding schema and prompt
 * stay as they are.
 */
export type PlanIntent = Intent | "create_lead";

/**
 * The only model-produced planning object; flat on purpose (no unions, nothing recursive).
 * Every field is present; unknown ones are null (works with strict structured-output modes).
 * Dates are ISO YYYY-MM-DD resolved against "today" in the rep's time zone; numbers are plain numbers.
 */
export const Understanding = z.object({
  intent: Intent,
  language: z.enum(["pt", "en", "es"]),
  company: z.string().nullable(),
  city: z.string().nullable(),
  country: z.string().nullable(),
  seats: z.number().nullable(),
  startDate: z.string().nullable(),
  contactName: z.string().nullable(),
  contactEmail: z.string().nullable(),
  contactPhone: z.string().nullable(),
  product: z.string().nullable(),
  estValue: z.number().nullable(),
  closeDate: z.string().nullable(),
  website: z.string().nullable(),
  referralPartner: z.string().nullable(),
  notes: z.string().nullable(),
  portalUrl: z.string().nullable(),
  tenant: z.string().nullable(),
  inviteCode: z.string().nullable(),
  buyerName: z.string().nullable(),
  missing: z.array(z.string()),
  summaryForRep: z.string(),
});
export type Understanding = z.infer<typeof Understanding>;

export interface QuoteRequest {
  company: string;
  city: string;
  country: string;
  seats: number;
  startDate: string;
  currency: "BRL" | "USD";
  language: "pt-BR" | "en";
}

export interface Quote {
  number: string;
  validUntil: string;
  currency: string;
  totalMinor: number;
  lines: { sku: string; description: string; qty: number; unitMinor: number; totalMinor: number }[];
}

export type PlanAction =
  | { kind: "crm_upsert_company"; company: string; city?: string; country?: string }
  | { kind: "crm_create_deal"; name: string; amountMinor: number; currency: string; closeDate: string }
  | { kind: "quote_pdf"; request: QuoteRequest }
  | { kind: "crm_attach_quote" }
  | { kind: "draft_reply"; language: "pt-BR" | "en" }
  | { kind: "skill_replay"; skill: string; version: number; params: Record<string, ParamValue> }
  | {
      kind: "computer_use";
      portalId: string;
      startUrl: string;
      draftId?: Id;
      goal: string;
      params: Record<string, ParamValue>;
      compileAs: string;
    }
  | { kind: "teach"; video: ArtifactRef; narration?: Transcript };

export interface Plan {
  jobId: Id;
  intent: PlanIntent;
  actions: PlanAction[];
  writes: boolean;
  approvalText: string;
  approvalImage?: ArtifactRef;
}

export interface RepProfile {
  phone: string;
  name: string;
  tz: string; // e.g. America/Sao_Paulo
  locale: "pt-BR" | "en-US";
  languageBias: string[]; // e.g. ["Portuguese", "English"]
}

/** Synthetic supplier profile of the fictional company "Tidewater Cloud" (canonical field -> value). */
export type CompanyProfile = Record<string, string>;

export type GateKind = "plan" | "commit" | "safety" | "skill_confirm" | "skill_patch" | "question";

export interface ApprovalBroker {
  open(g: {
    jobId: Id;
    runId?: Id;
    kind: GateKind;
    to: string;
    body: string;
    image?: ArtifactRef;
    ttlMs: number;
    buttons?: { id: "approve" | "reject" | "edit" | `opt${number}`; title: string }[];
  }): Promise<{ gateId: Id; decision: Promise<Decision | `opt${number}`> }>;
  /** DB first (compare-and-set), then the in-memory promise. */
  resolveFromButton(
    buttonId: string,
    from: string,
    waId: string,
  ): "resolved" | "already_resolved" | "expired" | "unknown" | "wrong_sender";
  expireDue(): number; // on a 30 s interval and on boot
}

/** key = idempotency key "jobId:actionIdx"; the fake dedupes on it, HubSpot embeds it for reconciliation. */
export interface CrmClient {
  upsertCompany(
    c: { name: string; city?: string; country?: string; domain?: string },
    key: string,
  ): Promise<{ id: string; created: boolean; url: string }>;
  createDeal(
    d: { name: string; amountMinor: number; currency: string; closeDate: string; companyId: string },
    key: string,
  ): Promise<{ id: string; url: string }>;
  attachFileNote(
    n: { dealId: string; body: string; file: ArtifactRef; filename: string },
    key: string,
  ): Promise<{ noteId: string }>;
}

export interface QuoteService {
  price(r: QuoteRequest): Quote; // pure
  renderPdf(q: Quote, r: QuoteRequest): Promise<ArtifactRef>;
}

export interface Receipt {
  jobId: Id;
  title: string;
  lines: string[];
  tier: "api" | "replay" | "agentic" | "repair";
  seconds: number;
  execCostUsd: number;
  intakeCostUsd: number; // transcription + extraction; always shown next to execution cost
  skill?: { name: string; version: number };
  verified?: { matched: number; checked: number };
  image: ArtifactRef;
}

export interface PlanContext {
  jobId: Id;
  skills: SkillStore;
  rep: RepProfile;
  company: CompanyProfile;
  attachments: ArtifactRef[];
  clock: Clock;
}

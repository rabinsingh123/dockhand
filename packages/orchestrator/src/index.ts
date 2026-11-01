// @dockhand/orchestrator public API. The test harness is a separate entry: "@dockhand/orchestrator/testing".

export {
  buttonId,
  createApprovalBroker,
  DEMO_GATE_TTL_MS,
  type DockhandApprovalBroker,
  GATE_TTL_MS,
  type GateDecision,
  type GateOpen,
  gateTtlMs,
  parseButtonId,
  REPLIES,
} from "./approvals.ts";
export { isCommand, runCommand } from "./flows/commands.ts";
export type { CuModelSource } from "./flows/env.ts";
export { draftReply } from "./flows/quote.ts";
export { normalizeDraft, teachRequest } from "./flows/teach.ts";
export { isTerminal, JOB_STATUSES, type TransitionResult, transition } from "./fsm.ts";
export { classifyMedia, toWav, transcriptionKeywords } from "./intake.ts";
export {
  createOrchestrator,
  type Orchestrator,
  type OrchestratorDeps,
  RESTART_MESSAGE,
} from "./orchestrator.ts";
export {
  paramsFromProfile,
  paramsFromUnderstanding,
  profileParams,
  syntheticParamSets,
  UNDERSTANDING_ALIASES,
} from "./params.ts";
export {
  activeSkillFor,
  type BuildPlanContext,
  buildPlan,
  type PlanOutcome,
  SUPPLIER_SKILL,
  WHAT_I_DO,
} from "./plan.ts";
export {
  CARAVELA,
  PORTAL_DEFAULTS,
  type PortalDirectory,
  type PortalInfo,
  type PortalTarget,
  parseInviteUrl,
  SUPPLIER,
  WRITE_GUARD_ALLOW,
  writeGuardFor,
} from "./portals.ts";
export { type CompanyKit, DEFAULT_REP, loadCompanyKit, repProfile } from "./profile.ts";
export { createRepos, idemKey, type Repos } from "./repo.ts";
export { createFakeCrm, type FakeCrm } from "./tools/crm-fake.ts";
export { createHubSpotCrm, type HubSpotOptions, jobShortId } from "./tools/hubspot.ts";
export {
  askPhoneCardHtml,
  diffPhoneCardHtml,
  draftCounts,
  money,
  planPhoneCardHtml,
  skillCounts,
  skillPhoneCardHtml,
  submitPhoneCardHtml,
  teachPhoneCardHtml,
} from "./tools/phone-cards.ts";
export { createQuoteService, PRICE_BOOK, priceQuote, renderQuotePdf } from "./tools/quotes.ts";
export { createCardRenderer, OPEN_WEIGHTS_CREDIT, receiptCaption, receiptHtml } from "./tools/receipts.ts";
export { Extraction, normalizeUnderstanding, understand, understandingRequest } from "./understand.ts";
export {
  createOrchestratorFromDev,
  type DevLike,
  type FromDevOptions,
  portalDirectory,
  type Wired,
} from "./wiring.ts";

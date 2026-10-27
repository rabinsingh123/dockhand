// biome-ignore-all assist/source/organizeImports: contract exports stay first; implementations are appended below.
// Contracts: every cross-package type. Lead-only changes.
export * from "./contracts/base.ts";
export * from "./contracts/browser.ts";
export * from "./contracts/evals.ts";
export * from "./contracts/models.ts";
export * from "./contracts/orchestrator.ts";
export * from "./contracts/skills.ts";
export * from "./contracts/whatsapp.ts";

// Implementations (owned by the core agent; see docs/ARCHITECTURE.md):
// config, db, artifacts, clock, ids, log are added here as they land.
export { createArtifactStore, createMemoryArtifactStore } from "./artifacts.ts";
export { createFixedClock, systemClock } from "./clock.ts";
export {
  type Config,
  type CrmMode,
  loadConfig,
  type MetaMode,
  modeBanner,
  type WhatsAppMode,
} from "./config.ts";
export { type Db, openDb } from "./db.ts";
export { ulid } from "./ids.ts";
export { costOf, createLedger } from "./ledger.ts";
export { createLogger } from "./log.ts";
export { varDir, workspaceRoot } from "./paths.ts";

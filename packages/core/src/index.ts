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

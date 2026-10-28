// One call that builds the orchestrator from the gateway's dev process (apps/gateway startDevProcess()).
// Structural types only: the orchestrator does not depend on the gateway or the portals package.

import { join } from "node:path";
import { createBrowserPool, type DockhandBrowserPool } from "@dockhand/browser";
import {
  type ArtifactStore,
  type Clock,
  type Config,
  type CookieSpec,
  type CrmClient,
  type Db,
  type Logger,
  type ModelGateway,
  varDir,
  type WhatsAppClient,
} from "@dockhand/core";
import { createSkillStore } from "@dockhand/skills";
import { createApprovalBroker, type DockhandApprovalBroker } from "./approvals.ts";
import type { CuModelSource } from "./flows/env.ts";
import { createOrchestrator, type Orchestrator, type OrchestratorDeps } from "./orchestrator.ts";
import { CARAVELA, PORTAL_DEFAULTS, type PortalDirectory, SUPPLIER, WRITE_GUARD_ALLOW } from "./portals.ts";
import { createFakeCrm } from "./tools/crm-fake.ts";
import { createHubSpotCrm } from "./tools/hubspot.ts";
import { createQuoteService } from "./tools/quotes.ts";

/** A started portal (PortalHandle from @dockhand/portals fits). */
export interface PortalHandleLike {
  url: string;
  session(o: { runId: string }): Promise<CookieSpec[]>;
}

/** What apps/gateway's startDevProcess() returns (the parts used here). */
export interface DevLike {
  config: Config;
  db: Db;
  log: Logger;
  clock: Clock;
  artifacts: ArtifactStore;
  whatsapp: WhatsAppClient;
  portals?: { partner: PortalHandleLike; supplier: PortalHandleLike };
}

export interface FromDevOptions
  extends Partial<Omit<OrchestratorDeps, "db" | "clock" | "config" | "log" | "wa" | "artifacts">> {
  /** Required: createModelGateway(...) in live/record/cassette modes, createFakeModelGateway(...) in fake mode. */
  models: ModelGateway;
  /** First-run computer-use model id (default muse-spark-1.3; chosen by measurement). */
  firstRunModel?: string;
}

/** Portal directory from started portals, or from the configured ports (portals in another process). */
export function portalDirectory(config: Config, started?: DevLike["portals"]): PortalDirectory {
  const partnerUrl = started?.partner.url ?? `http://127.0.0.1:${config.ports.partnerPortal}`;
  const supplierUrl = started?.supplier.url ?? `http://127.0.0.1:${config.ports.supplierPortal}`;
  const sessionFor = (handle: PortalHandleLike | undefined, url: string) =>
    handle
      ? (o: { runId: string }) => handle.session({ runId: o.runId })
      : (o: { runId: string }) => httpSession(url, o.runId);
  return {
    [CARAVELA]: {
      ...(PORTAL_DEFAULTS[CARAVELA] as (typeof PORTAL_DEFAULTS)[string]),
      url: partnerUrl,
      session: sessionFor(started?.partner, partnerUrl),
      writeGuardAllow: WRITE_GUARD_ALLOW[CARAVELA] ?? [],
    },
    [SUPPLIER]: {
      ...(PORTAL_DEFAULTS[SUPPLIER] as (typeof PORTAL_DEFAULTS)[string]),
      url: supplierUrl,
      session: sessionFor(started?.supplier, supplierUrl),
      writeGuardAllow: WRITE_GUARD_ALLOW[SUPPLIER] ?? [],
    },
  };
}

/** POST /api/__test/session on a portal in another process (cookies follow the portal defaults). */
async function httpSession(baseUrl: string, runId: string): Promise<CookieSpec[]> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/__test/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId }),
  });
  if (!res.ok) throw new Error(`portal session at ${baseUrl} answered ${res.status}`);
  return ((await res.json()) as { cookies: CookieSpec[] }).cookies;
}

export interface Wired {
  orchestrator: Orchestrator;
  approvals: DockhandApprovalBroker;
  pool: DockhandBrowserPool | OrchestratorDeps["pool"];
  /** Stops the expiry sweep and closes the browser. */
  close(): Promise<void>;
}

/**
 * Usage in apps/gateway main.ts:
 *   const dev = await startDevProcess();
 *   const { orchestrator } = createOrchestratorFromDev(dev, { models });
 *   await orchestrator.recover();
 *   dev.wire(async (messages) => { for (const m of messages) await orchestrator.handle(m); });
 */
export function createOrchestratorFromDev(dev: DevLike, o: FromDevOptions): Wired {
  const { config, db, log, clock, artifacts } = dev;
  const ownPool = o.pool
    ? undefined
    : createBrowserPool({
        headless: config.headless,
        maxContexts: 4,
        storageStateDir: join(varDir(), "browser-state"),
      });
  const pool = o.pool ?? (ownPool as DockhandBrowserPool);
  const crm: CrmClient =
    o.crm ??
    (config.crm.mode === "hubspot" && config.crm.hubspotToken
      ? createHubSpotCrm({
          token: config.crm.hubspotToken,
          db,
          artifacts,
          clock,
          log,
          lookupAccount: true,
          pipeline: config.crm.pipeline,
          dealStage: config.crm.dealStage,
          currencyCode: config.crm.dealCurrency,
        })
      : createFakeCrm());
  const approvals =
    o.approvals ??
    createApprovalBroker({ db, wa: dev.whatsapp, clock, log, artifacts, demoMode: config.demoMode });
  const cu: CuModelSource = o.cu ?? o.models.computerUse({ model: o.firstRunModel ?? "muse-spark-1.3" });
  const orchestrator = createOrchestrator({
    ...o,
    db,
    clock,
    config,
    log,
    wa: dev.whatsapp,
    artifacts,
    pool,
    crm,
    approvals,
    cu,
    skills: o.skills ?? createSkillStore(db, clock),
    quotes: o.quotes ?? createQuoteService({ artifacts, clock }),
    portals: o.portals ?? portalDirectory(config, dev.portals),
  });
  return {
    orchestrator,
    approvals,
    pool,
    async close() {
      orchestrator.close();
      await ownPool?.closeAll();
    },
  };
}

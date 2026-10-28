// In-process Dockhand for end-to-end tests, evals and gateway tests: temp SQLite, memory artifacts, both mock
// portals on port 0, the WhatsApp emulator wired to a gateway-like webhook handler (signature check, dedupe,
// allow-list) and to the real WhatsApp client in-process, one shared Chromium, the fake model gateway answering
// from fixtures, the fake CRM, and the scripted computer-use model. No network, no keys, no sleeps.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserPool, createScriptedModel, type DockhandBrowserPool } from "@dockhand/browser";
import {
  type ArtifactStore,
  type CrmClient,
  createFixedClock,
  createLedger,
  createLogger,
  createMemoryArtifactStore,
  type Db,
  type EmulatorControl,
  type Ledger,
  loadConfig,
  type ModelGateway,
  openDb,
  type ScriptStep,
  type SkillStore,
  workspaceRoot,
} from "@dockhand/core";
import { createFakeModelGateway, type FakeGatewayOptions } from "@dockhand/meta";
import { type PortalHandle, startPartnerPortal, startSupplierPortal } from "@dockhand/portals";
import { createSkillStore } from "@dockhand/skills";
import { createEmulator, createWhatsAppClient, parseWebhook, verifySignature } from "@dockhand/whatsapp";
import { createApprovalBroker, type DockhandApprovalBroker } from "../approvals.ts";
import { createOrchestrator, type Orchestrator } from "../orchestrator.ts";
import { loadCompanyKit } from "../profile.ts";
import { createRepos, type Repos } from "../repo.ts";
import { createFakeCrm } from "../tools/crm-fake.ts";
import { createQuoteService } from "../tools/quotes.ts";
import { portalDirectory } from "../wiring.ts";
import { fixtureStructured, standInComputerUse } from "./stand-ins.ts";

export const TEST_REP = "5511999990001";
const SECRET = "test-app-secret";
const TOKEN = "test-token";
const PHONE_ID = "109000000000001";
const VERSION = "v26.0";

export type CuScriptSource =
  | ScriptStep[]
  | ((o: { purpose: "cu_first_run" | "cu_repair"; runId: string }) => ScriptStep[] | undefined);

export interface TestSystemOptions {
  /** A whole gateway, or fake-gateway handlers (defaults answer from fixtures/). */
  models?: ModelGateway | FakeGatewayOptions;
  /** Computer-use scripts: one for every first run, or chosen per session. */
  cuScript?: CuScriptSource;
  crm?: CrmClient;
  reps?: string[];
  clockStartMs?: number;
}

export interface TestSystem {
  emulator: EmulatorControl & { redeliver(waId: string): Promise<number> };
  portals: { partner: PortalHandle; supplier: PortalHandle };
  orchestrator: Orchestrator;
  approvals: DockhandApprovalBroker;
  db: Db;
  repos: Repos;
  clock: ReturnType<typeof createFixedClock>;
  skills: SkillStore;
  crm: CrmClient;
  ledger: Ledger;
  artifacts: ArtifactStore;
  pool: DockhandBrowserPool;
  rep: string;
  close(): Promise<void>;
}

export async function createTestSystem(opts: TestSystemOptions = {}): Promise<TestSystem> {
  const dir = mkdtempSync(join(tmpdir(), "dockhand-system-"));
  const clock = createFixedClock(opts.clockStartMs ?? Date.UTC(2026, 9, 27, 13, 0, 0));
  const reps = opts.reps ?? [TEST_REP];
  const db = openDb(join(dir, "dockhand.sqlite"));
  const repos = createRepos(db, clock);
  const artifacts = createMemoryArtifactStore(clock);
  const ledger = createLedger(db, clock);
  const log = createLogger({ level: "silent" });
  const config = loadConfig({
    META_MODE: "fake",
    WHATSAPP_MODE: "emulator",
    CRM_MODE: "fake",
    REP_ALLOWLIST: reps.join(","),
    WHATSAPP_APP_SECRET: SECRET,
    WHATSAPP_TOKEN: TOKEN,
    WHATSAPP_PHONE_NUMBER_ID: PHONE_ID,
    FFMPEG_PATH: process.env.FFMPEG_PATH,
    LOG_LEVEL: "silent",
  });
  const repFixture = JSON.parse(
    readFileSync(join(workspaceRoot(), "fixtures", "reps", "rep.json"), "utf8"),
  ) as {
    name: string;
    tz: string;
    locale: string;
    languageBias: string[];
  };
  for (const phone of reps) repos.reps.upsert({ phone, ...repFixture, allowed: true });

  const [partner, supplier] = await Promise.all([
    startPartnerPortal({ port: 0, latencyMs: [0, 0] }),
    startSupplierPortal({ port: 0, latencyMs: [0, 0] }),
  ]);

  let orchestrator: Orchestrator | undefined;
  // Gateway-like webhook: signature over the raw bytes, dedupe by wamid, allow-list, then the orchestrator.
  const webhook = async (raw: string, signature: string | null): Promise<Response> => {
    if (!verifySignature(new TextEncoder().encode(raw), signature ?? undefined, SECRET)) {
      return new Response("Invalid signature", { status: 401 });
    }
    for (const m of parseWebhook(JSON.parse(raw)).messages) {
      if (!reps.includes(m.from)) continue;
      if (!repos.messages.insertInbound(m)) continue; // a retry of a stored message
      void orchestrator?.handle(m).catch(() => {});
    }
    return new Response("OK", { status: 200 });
  };
  const emulator = createEmulator({
    webhookUrl: "http://gateway.test/webhook/whatsapp",
    appSecret: SECRET,
    phoneNumberId: PHONE_ID,
    graphVersion: VERSION,
    token: TOKEN,
    clock,
    fetch: async (_url, init) =>
      webhook(String(init?.body), new Headers(init?.headers).get("x-hub-signature-256")),
  });
  const wa = createWhatsAppClient({
    baseUrl: "http://emulator.test/graph",
    graphVersion: VERSION,
    token: TOKEN,
    phoneNumberId: PHONE_ID,
    artifacts,
    fetch: async (input, init) => emulator.app.request(new Request(input, init)),
  });

  const models =
    opts.models &&
    "structured" in opts.models &&
    "computerUse" in opts.models &&
    "hasOpenWeights" in opts.models
      ? (opts.models as ModelGateway)
      : createFakeModelGateway({
          structured: fixtureStructured,
          transcribe: () => {
            throw new Error("no transcript scripted for this test");
          },
          ...(opts.models as FakeGatewayOptions | undefined),
          ledger,
          clock,
        });
  const pool = createBrowserPool({
    headless: true,
    maxContexts: 4,
    storageStateDir: join(dir, "browser-state"),
  });
  const skills = createSkillStore(db, clock);
  const crm = opts.crm ?? createFakeCrm();
  const approvals = createApprovalBroker({ db, wa, clock, log, artifacts });
  const scripts = opts.cuScript;
  const scripted =
    (purpose: "cu_first_run" | "cu_repair") =>
    ({ page, runId }: { page: import("playwright").Page; runId: string }) => {
      const script =
        typeof scripts === "function"
          ? scripts({ purpose, runId })
          : purpose === "cu_first_run"
            ? scripts
            : undefined;
      return createScriptedModel(
        script ?? [{ do: "done", text: "BLOCKED: no script for this session" }],
        page,
        {
          ledger,
          model: `scripted-${purpose}`,
        },
      );
    };

  orchestrator = createOrchestrator({
    db,
    clock,
    config,
    log,
    wa,
    models,
    // Without a script, computer use follows the stand-ins (scripts built from each run's values).
    cu: scripts === undefined ? standInComputerUse("cu_first_run", { ledger }) : scripted("cu_first_run"),
    repairCu: scripts === undefined ? standInComputerUse("cu_repair", { ledger }) : scripted("cu_repair"),
    pool,
    skills,
    crm,
    quotes: createQuoteService({ artifacts, clock }),
    artifacts,
    approvals,
    portals: portalDirectory(config, { partner, supplier }),
    company: () => loadCompanyKit(artifacts),
    ledger,
    tmpDir: join(dir, "tmp"),
    expirySweepMs: 0,
    // Generous per-step deadline: integration files run in parallel, and a slow first render is not a bug.
    stepTimeoutMs: 10_000,
  });

  return {
    emulator: Object.assign(emulator.control, { redeliver: emulator.redeliver }),
    portals: { partner, supplier },
    orchestrator,
    approvals,
    db,
    repos,
    clock,
    skills,
    crm,
    ledger,
    artifacts,
    pool,
    rep: reps[0] ?? TEST_REP,
    async close() {
      orchestrator?.close();
      emulator.close();
      await pool.closeAll();
      await Promise.all([partner.close(), supplier.close()]);
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---------- fixture-backed model answers and scripts (shared with META_MODE=fake in `pnpm dev`) ----------

export {
  caravelaScript,
  caravelaScriptFromParams,
  createStandInGateway,
  equivalentNames,
  fixtureStructured,
  fixtureUnderstanding,
  inboundFixtures,
  pickEquivalent,
  repairScript,
  standInComputerUse,
  supplierScript,
  supplierScriptFromParams,
  teachFixture,
  textEdits,
  type VoiceFixture,
  voiceFixtures,
} from "./stand-ins.ts";

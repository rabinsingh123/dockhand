// In-process Dockhand for end-to-end tests, evals and gateway tests: temp SQLite, memory artifacts, both mock
// portals on port 0, the WhatsApp emulator wired to a gateway-like webhook handler (signature check, dedupe,
// allow-list) and to the real WhatsApp client in-process, one shared Chromium, the fake model gateway answering
// from fixtures, the fake CRM, and the scripted computer-use model. No network, no keys, no sleeps.

import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserPool, createScriptedModel, type DockhandBrowserPool } from "@dockhand/browser";
import {
  type ArtifactStore,
  type CallCtx,
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
  type StructuredRequest,
  type Understanding,
  workspaceRoot,
} from "@dockhand/core";
import { createFakeModelGateway, type FakeGatewayOptions } from "@dockhand/meta";
import {
  type PortalHandle,
  SUPPLIER_FIELDS,
  startPartnerPortal,
  startSupplierPortal,
} from "@dockhand/portals";
import { createSkillStore } from "@dockhand/skills";
import { createEmulator, createWhatsAppClient, parseWebhook, verifySignature } from "@dockhand/whatsapp";
import { createApprovalBroker, type DockhandApprovalBroker } from "../approvals.ts";
import { createOrchestrator, type Orchestrator } from "../orchestrator.ts";
import { loadCompanyKit } from "../profile.ts";
import { createRepos, type Repos } from "../repo.ts";
import { createFakeCrm } from "../tools/crm-fake.ts";
import { createQuoteService } from "../tools/quotes.ts";
import type { Extraction } from "../understand.ts";
import { portalDirectory } from "../wiring.ts";

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
    cu: scripted("cu_first_run"),
    repairCu: scripted("cu_repair"),
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

// ---------- fixture-backed model answers ----------

const FIXTURES = () => join(workspaceRoot(), "fixtures");

interface InboundFixture {
  file: string;
  sha256: string;
  extraction: Extraction;
  understanding: Understanding;
  key: string;
}

let inboundCache: InboundFixture[] | undefined;

/** Every fixtures/inbound/* file with its expected extraction and Understanding. */
export function inboundFixtures(): InboundFixture[] {
  if (inboundCache) return inboundCache;
  const dir = join(FIXTURES(), "inbound");
  inboundCache = readdirSync(dir)
    .filter((f) => f.endsWith(".expected.json"))
    .map((f) => {
      const e = JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown> & {
        fixture: string;
        understanding: Understanding;
      };
      const file = join(workspaceRoot(), e.fixture);
      const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
      const referral = e.kind === "partner_referral_form";
      const facts = referral
        ? (e.asWritten as Record<string, string>)
        : {
            buyer: String(e.buyer),
            invite_url: String(e.portalUrl),
            invite_code: String(e.inviteCode),
            deadline: String(e.deadlineAsWritten),
            reference: String(e.reference),
            documents_requested: (e.documentsRequested as string[]).join(", "),
          };
      return {
        file,
        sha256,
        key: referral ? (e.understanding.company ?? "") : String(e.inviteCode),
        understanding: e.understanding,
        extraction: {
          documentType: referral ? "partner_referral_form" : "supplier_registration_invitation",
          language: (e.understanding.language ?? "en") as Extraction["language"],
          fields: Object.entries(facts).map(([name, value]) => ({
            name: name.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase(),
            value: String(value),
          })),
          summary: String(e.description ?? `${e.kind} from ${e.buyer ?? "a partner"}`),
        },
      };
    });
  return inboundCache;
}

export interface VoiceFixture {
  id: string;
  script: string;
  expected: Understanding;
}

export function voiceFixtures(): VoiceFixture[] {
  const data = JSON.parse(readFileSync(join(FIXTURES(), "voice", "expected.json"), "utf8")) as {
    scripts: VoiceFixture[];
  };
  return data.scripts;
}

export function teachFixture(): { draft: Record<string, unknown>; videoPath: string } {
  const e = JSON.parse(
    readFileSync(join(FIXTURES(), "teach", "caravela-register-deal.expected.json"), "utf8"),
  ) as {
    draft: Record<string, unknown>;
  };
  return { draft: e.draft, videoPath: join(FIXTURES(), "teach", "caravela-register-deal.mp4") };
}

const promptOf = (req: StructuredRequest<unknown>) =>
  req.input.map((p) => (p.type === "text" ? p.text : "")).join("\n");

/** Answers structured calls from fixtures: extraction by file hash, understanding by what the prompt mentions. */
export function fixtureStructured(req: StructuredRequest<unknown>, ctx: CallCtx): unknown {
  switch (ctx.purpose) {
    case "extract": {
      const part = req.input.find((p) => p.type === "image" || p.type === "pdf");
      const sha = part?.type === "image" ? part.image.sha256 : part?.type === "pdf" ? part.file.sha256 : "";
      const hit = inboundFixtures().find((f) => f.sha256 === sha);
      if (!hit) throw new Error(`no extraction fixture for sha ${sha.slice(0, 12)}`);
      return hit.extraction;
    }
    case "understand": {
      const prompt = promptOf(req);
      const voice = voiceFixtures().find((v) => prompt.includes(v.script));
      if (voice) return voice.expected;
      const doc = inboundFixtures().find((f) => f.key && prompt.includes(f.key));
      if (doc) return doc.understanding;
      return {
        ...inboundFixtures()[0]?.understanding,
        intent: "unknown",
        missing: [],
        summaryForRep: "Not a task.",
      };
    }
    case "teach":
      return teachFixture().draft;
    case "compile_annotate":
      return {
        title: "",
        steps: [],
        params: [],
        success: { description: "", textPattern: null, idRegex: null, idName: null },
      };
    default:
      throw new Error(`fixture gateway has no answer for purpose ${ctx.purpose}`);
  }
}

// ---------- scripted computer-use sessions for the mock portals ----------

const s = (label: string, text: string): ScriptStep => ({ do: "fill", target: { label }, text });
const pick = (name: string, option: string): ScriptStep => ({
  do: "select",
  trigger: { role: "combobox", name },
  option,
});

/** The first run of a deal registration on Caravela Partner Hub v1 (starting on /deals/new). */
export function caravelaScript(v: {
  company: string;
  website?: string;
  country: string;
  city: string;
  contactName: string;
  contactEmail: string;
  contactPhone?: string;
  product: string;
  seats: number;
  closeDateDmy: string;
  referralPartner?: string;
  notes?: string;
}): ScriptStep[] {
  return [
    s("End customer company", v.company),
    ...(v.website ? [s("Company website", v.website)] : []),
    pick("Country", v.country),
    s("City", v.city),
    s("Contact full name", v.contactName),
    s("Contact email", v.contactEmail),
    ...(v.contactPhone ? [s("Contact phone", v.contactPhone)] : []),
    pick("Product", v.product),
    s("Seats", String(v.seats)),
    s("Expected close date", v.closeDateDmy),
    ...(v.referralPartner ? [s("Referral partner", v.referralPartner)] : []),
    ...(v.notes ? [s("Notes", v.notes)] : []),
    {
      do: "check",
      target: { role: "checkbox", name: "The end customer agreed to be contacted by Caravela" },
    },
    { do: "call", name: "request_commit", args: { summary: `Register ${v.company}` } },
    { do: "click", target: { role: "button", name: "Submit registration" } },
    { do: "done", text: "Registration received." },
  ];
}

/** Zero-shot supplier registration (acme layout) from the company profile, with both uploads. */
export function supplierScript(
  profile: Record<string, string>,
  tenant: "acme" | "globex" = "acme",
): ScriptStep[] {
  const out: ScriptStep[] = [{ do: "click", target: { role: "button", name: "Start registration" } }];
  let step: string | undefined;
  for (const f of SUPPLIER_FIELDS) {
    if (f.tenants && !f.tenants.includes(tenant)) continue;
    if (f.showWhen && profile[f.showWhen.key] !== String(f.showWhen.equals)) continue;
    if (step !== undefined && f.step !== step)
      out.push({ do: "click", target: { role: "button", name: "Next" } });
    step = f.step;
    const value = profile[f.key];
    if (value === undefined || value === "") continue;
    switch (f.type) {
      case "combobox":
        out.push(pick(f.label, value));
        break;
      case "radio":
        out.push({ do: "check", target: { role: "radio", name: value } });
        break;
      case "checkbox":
        if (value === "true" && f.defaultValue !== true)
          out.push({ do: "check", target: { role: "checkbox", name: f.label } });
        break;
      case "checkboxGroup":
        out.push({ do: "check", target: { role: "checkbox", name: value } });
        break;
      case "file":
        out.push(
          { do: "click", target: { role: "button", name: `Choose file for ${f.label}` } },
          { do: "call", name: "attach_file", args: { slot: f.key.replace(/File$/, "") } },
        );
        break;
      default:
        out.push(s(f.label, value));
    }
  }
  out.push(
    { do: "click", target: { role: "button", name: "Next" } },
    {
      do: "call",
      name: "request_commit",
      args: { summary: "Submit the Tidewater Cloud supplier registration" },
    },
    { do: "click", target: { role: "button", name: "Submit for approval" } },
    { do: "done", text: "Registration submitted." },
  );
  return out;
}

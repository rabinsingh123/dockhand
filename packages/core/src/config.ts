import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { workspaceRoot } from "./paths.ts";

export type MetaMode = "live" | "record" | "cassette" | "fake";
export type WhatsAppMode = "cloud" | "emulator";
export type CrmMode = "hubspot" | "fake";

export interface Config {
  meta: { mode: MetaMode; apiKey?: string; baseUrl: string };
  openWeights: {
    model: string;
    apiKey?: string;
    baseUrl: string;
    priceInPerM?: number;
    priceOutPerM?: number;
  };
  /** In emulator mode token, phoneNumberId, appSecret and verifyToken are always set (dev defaults). */
  whatsapp: {
    mode: WhatsAppMode;
    token?: string;
    phoneNumberId?: string;
    appSecret?: string;
    verifyToken?: string;
    graphVersion: string;
  };
  crm: { mode: CrmMode; hubspotToken?: string };
  reps: { allowlist: string[] };
  ports: { gateway: number; partnerPortal: number; supplierPortal: number };
  ffmpegPath: string;
  headless: boolean;
  demoMode: boolean;
  logLevel: string;
}

/** Used only in WHATSAPP_MODE=emulator when the variable is unset. Not secrets: the emulator is local. */
const EMULATOR_DEFAULTS = {
  token: "emulator-token",
  phoneNumberId: "109000000000001",
  appSecret: "emulator-app-secret",
  verifyToken: "emulator-verify-token",
} as const;

const port = (fallback: number) => z.coerce.number().int().min(0).max(65535).default(fallback);

const flag = (fallback: boolean) =>
  z
    .string()
    .default(String(fallback))
    .transform((value, ctx) => {
      const v = value.toLowerCase();
      if (["1", "true", "yes", "on"].includes(v)) return true;
      if (["0", "false", "no", "off"].includes(v)) return false;
      ctx.addIssue({ code: "custom", message: `expected true/false, got "${value}"` });
      return z.NEVER;
    });

const phoneList = z
  .string()
  .default("")
  .transform((value, ctx) => {
    const numbers: string[] = [];
    for (const entry of value.split(",")) {
      const digits = entry.trim().replace(/^\+/, "");
      if (digits === "") continue;
      if (!/^\d{6,15}$/.test(digits)) {
        ctx.addIssue({
          code: "custom",
          message: `"${entry.trim()}" is not a phone number (E.164 digits, no spaces)`,
        });
        continue;
      }
      if (!numbers.includes(digits)) numbers.push(digits);
    }
    return numbers;
  });

const EnvSchema = z.object({
  // .env.example once used "mock" for the fake gateway; accept it as an alias.
  META_MODE: z.preprocess(
    (v) => (v === "mock" ? "fake" : v),
    z.enum(["live", "record", "cassette", "fake"]).default("fake"),
  ),
  MODEL_API_KEY: z.string().optional(),
  META_BASE_URL: z.url().default("https://api.meta.ai/v1"),
  OPEN_WEIGHTS_MODEL: z.string().default("meta-models/muse-spark-open"),
  BASETEN_API_KEY: z.string().optional(),
  BASETEN_BASE_URL: z.url().default("https://inference.baseten.co/v1"),
  OPEN_WEIGHTS_PRICE_IN: z.coerce.number().nonnegative().optional(),
  OPEN_WEIGHTS_PRICE_OUT: z.coerce.number().nonnegative().optional(),
  WHATSAPP_MODE: z.enum(["cloud", "emulator"]).default("emulator"),
  WHATSAPP_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().regex(/^\d+$/, "digits only").optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_GRAPH_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/, 'expected a Graph API version like "v26.0"')
    .default("v26.0"),
  REP_ALLOWLIST: phoneList,
  CRM_MODE: z.enum(["hubspot", "fake"]).default("fake"),
  HUBSPOT_TOKEN: z.string().optional(),
  GATEWAY_PORT: port(8787),
  PARTNER_PORTAL_PORT: port(5101),
  SUPPLIER_PORTAL_PORT: port(5102),
  FFMPEG_PATH: z.string().default("ffmpeg"),
  HEADLESS: flag(true),
  DEMO_MODE: flag(false),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
});

/**
 * Parses settings from `env`, or from process.env after loading `<workspace root>/.env` when it exists
 * (process.loadEnvFile never overrides variables already set). Empty values count as unset.
 * Throws one error listing every invalid value, or every secret the active live modes need.
 */
export function loadConfig(env?: Record<string, string | undefined>): Config {
  let source = env;
  if (source === undefined) {
    const dotenv = join(workspaceRoot(), ".env");
    if (existsSync(dotenv)) process.loadEnvFile(dotenv);
    source = process.env;
  }

  const parsed = EnvSchema.safeParse(withoutEmptyValues(source));
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (issue) => `  - ${issue.path.join(".") || "(env)"}: ${issue.message}`,
    );
    throw new Error(`Invalid configuration:\n${lines.join("\n")}`);
  }
  const e = parsed.data;

  const missing: string[] = [];
  const need = (name: string, value: unknown, why: string) => {
    if (value === undefined || (Array.isArray(value) && value.length === 0)) missing.push(`${name} (${why})`);
  };
  if (e.META_MODE === "live" || e.META_MODE === "record")
    need("MODEL_API_KEY", e.MODEL_API_KEY, `META_MODE=${e.META_MODE}`);
  if (e.WHATSAPP_MODE === "cloud") {
    need("WHATSAPP_TOKEN", e.WHATSAPP_TOKEN, "WHATSAPP_MODE=cloud");
    need("WHATSAPP_PHONE_NUMBER_ID", e.WHATSAPP_PHONE_NUMBER_ID, "WHATSAPP_MODE=cloud");
    need("WHATSAPP_APP_SECRET", e.WHATSAPP_APP_SECRET, "WHATSAPP_MODE=cloud");
    need("WHATSAPP_VERIFY_TOKEN", e.WHATSAPP_VERIFY_TOKEN, "WHATSAPP_MODE=cloud");
    need("REP_ALLOWLIST", e.REP_ALLOWLIST, "WHATSAPP_MODE=cloud: at least one rep number");
  }
  if (e.CRM_MODE === "hubspot") need("HUBSPOT_TOKEN", e.HUBSPOT_TOKEN, "CRM_MODE=hubspot");
  if (missing.length > 0) {
    throw new Error(
      `Missing settings for the active modes:\n${missing.map((m) => `  - ${m}`).join("\n")}\n` +
        "Set them in .env (see .env.example) or switch to a non-live mode.",
    );
  }

  const emulator = e.WHATSAPP_MODE === "emulator";
  return {
    meta: { mode: e.META_MODE, apiKey: e.MODEL_API_KEY, baseUrl: trimSlash(e.META_BASE_URL) },
    openWeights: {
      model: e.OPEN_WEIGHTS_MODEL,
      apiKey: e.BASETEN_API_KEY,
      baseUrl: trimSlash(e.BASETEN_BASE_URL),
      priceInPerM: e.OPEN_WEIGHTS_PRICE_IN,
      priceOutPerM: e.OPEN_WEIGHTS_PRICE_OUT,
    },
    whatsapp: {
      mode: e.WHATSAPP_MODE,
      token: e.WHATSAPP_TOKEN ?? (emulator ? EMULATOR_DEFAULTS.token : undefined),
      phoneNumberId: e.WHATSAPP_PHONE_NUMBER_ID ?? (emulator ? EMULATOR_DEFAULTS.phoneNumberId : undefined),
      appSecret: e.WHATSAPP_APP_SECRET ?? (emulator ? EMULATOR_DEFAULTS.appSecret : undefined),
      verifyToken: e.WHATSAPP_VERIFY_TOKEN ?? (emulator ? EMULATOR_DEFAULTS.verifyToken : undefined),
      graphVersion: e.WHATSAPP_GRAPH_VERSION,
    },
    crm: { mode: e.CRM_MODE, hubspotToken: e.HUBSPOT_TOKEN },
    reps: { allowlist: e.REP_ALLOWLIST },
    ports: {
      gateway: e.GATEWAY_PORT,
      partnerPortal: e.PARTNER_PORTAL_PORT,
      supplierPortal: e.SUPPLIER_PORTAL_PORT,
    },
    ffmpegPath: e.FFMPEG_PATH,
    headless: e.HEADLESS,
    demoMode: e.DEMO_MODE,
    logLevel: e.LOG_LEVEL,
  };
}

/** Model routing (docs/ARCHITECTURE.md section 5), shown in the banner. */
const MODEL_ROUTING = [
  ["voice", "muse-voice-transcribe-1.0"],
  ["vision/understand", "muse-spark-1.3"],
  ["teach", "muse-wonder-1.0"],
  ["computer use", "muse-spark-1.3"],
  ["heal rung 2", "meta-models/muse-spark-open"],
] as const;

/** One screen: modes, models, ports, which secrets are set. Never prints a secret value. */
export function modeBanner(c: Config): string {
  const set = (v: string | undefined) => (v ? "set" : "missing");
  const notLive = [
    c.meta.mode !== "live" ? `META_MODE=${c.meta.mode}` : null,
    c.whatsapp.mode !== "cloud" ? `WHATSAPP_MODE=${c.whatsapp.mode}` : null,
    c.crm.mode !== "hubspot" ? `CRM_MODE=${c.crm.mode}` : null,
  ].filter((v): v is string => v !== null);
  const rule = "=".repeat(78);
  const lines = [
    rule,
    "Dockhand",
    `  modes     meta=${c.meta.mode}  whatsapp=${c.whatsapp.mode}  crm=${c.crm.mode}  demo=${c.demoMode ? "on" : "off"}  headless=${c.headless}`,
    `  models    ${MODEL_ROUTING.map(([job, model]) => `${job}=${model}`).join("  ")}`,
    `            open weights=${c.openWeights.model} (${c.openWeights.apiKey ? "baseten configured" : "off: heal rung 2 skipped"})`,
    `  meta      ${c.meta.baseUrl}  MODEL_API_KEY=${set(c.meta.apiKey)}`,
    `  whatsapp  graph ${c.whatsapp.graphVersion} via ${c.whatsapp.mode === "cloud" ? "graph.facebook.com" : "local emulator"}  token=${set(c.whatsapp.token)}  app secret=${set(c.whatsapp.appSecret)}`,
    `  crm       ${c.crm.mode === "hubspot" ? "HubSpot" : "in-memory fake"}  HUBSPOT_TOKEN=${set(c.crm.hubspotToken)}`,
    `  ports     gateway=${c.ports.gateway}  partner portal=${c.ports.partnerPortal}  supplier portal=${c.ports.supplierPortal}`,
    `  reps      ${c.reps.allowlist.length} allow-listed`,
  ];
  if (notLive.length > 0)
    lines.push(`  NOT LIVE  ${notLive.join(", ")}: do not record a take against this setup.`);
  lines.push(rule);
  return lines.join("\n");
}

function withoutEmptyValues(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string" && value.trim() !== "") out[key] = value.trim();
  }
  return out;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

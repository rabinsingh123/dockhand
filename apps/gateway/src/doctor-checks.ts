import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { type Config, loadConfig } from "@dockhand/core";

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorOptions {
  /** Environment to validate; default: loadConfig() (reads <root>/.env, then process.env). */
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  graphBaseUrl?: string; // default https://graph.facebook.com
  hubspotBaseUrl?: string; // default https://api.hubapi.com
  /** Launches and closes Chromium, returning its version. Default: Playwright. */
  launchBrowser?: () => Promise<string>;
  timeoutMs?: number; // per network check, default 15 s
}

const MIN_NODE: [number, number] = [22, 13]; // node:sqlite without a flag
const META_MODELS = {
  required: ["muse-spark-1.3", "muse-voice-transcribe-1.0"],
  fallback: ["muse-wonder-1.0"],
};

/** Runs every check and returns one line per check. Never throws; never puts a secret in a detail. */
export async function runDoctor(opts: DoctorOptions = {}): Promise<CheckResult[]> {
  const results: CheckResult[] = [checkNode()];
  let config: Config | undefined;
  try {
    config = loadConfig(opts.env);
    results.push({
      name: "config",
      status: "ok",
      detail: `meta=${config.meta.mode} whatsapp=${config.whatsapp.mode} crm=${config.crm.mode}, ${config.reps.allowlist.length} rep(s) allow-listed`,
    });
  } catch (err) {
    results.push({ name: "config", status: "fail", detail: errorText(err) });
  }
  if (!config) {
    for (const name of [
      "ffmpeg",
      "chromium",
      "ports",
      "meta models",
      "whatsapp token",
      "baseten",
      "hubspot",
    ]) {
      results.push({ name, status: "skip", detail: "config invalid" });
    }
    return results;
  }

  const secrets = [
    config.meta.apiKey,
    config.openWeights.apiKey,
    config.whatsapp.token,
    config.whatsapp.appSecret,
    config.whatsapp.verifyToken,
    config.crm.hubspotToken,
  ].filter((s): s is string => typeof s === "string" && s.length >= 4);
  const http = createHttp(opts.fetch ?? globalThis.fetch, opts.timeoutMs ?? 15_000);

  const checks: Promise<CheckResult | CheckResult[]>[] = [
    checkFfmpeg(config.ffmpegPath),
    checkChromium(opts.launchBrowser ?? launchPlaywrightChromium),
    checkPorts(config),
    checkMetaModels(config, http),
    checkWhatsAppToken(config, http, opts.graphBaseUrl ?? "https://graph.facebook.com"),
    checkBaseten(config, http),
    checkHubSpot(config, http, opts.hubspotBaseUrl ?? "https://api.hubapi.com"),
  ];
  for (const settled of await Promise.allSettled(checks)) {
    const value =
      settled.status === "fulfilled"
        ? settled.value
        : { name: "doctor", status: "fail" as const, detail: errorText(settled.reason) };
    for (const r of Array.isArray(value) ? value : [value])
      results.push({ ...r, detail: redact(r.detail, secrets) });
  }
  return results;
}

export function formatReport(results: CheckResult[]): string {
  const label: Record<CheckStatus, string> = { ok: "ok  ", warn: "WARN", fail: "FAIL", skip: "skip" };
  const lines = results.map(
    (r) => `  ${label[r.status]}  ${r.name}: ${r.detail.replace(/\n/g, "\n          ")}`,
  );
  const failed = results.filter((r) => r.status === "fail").length;
  lines.push("", failed === 0 ? "All required checks passed." : `${failed} check(s) failed.`);
  return ["Dockhand doctor", ...lines].join("\n");
}

function checkNode(): CheckResult {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  const ok = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  return {
    name: "node",
    status: ok ? "ok" : "fail",
    detail: ok
      ? `v${process.versions.node}`
      : `v${process.versions.node}; need >= ${MIN_NODE.join(".")} (node:sqlite)`,
  };
}

function checkFfmpeg(path: string): Promise<CheckResult> {
  return new Promise((resolve) => {
    execFile(path, ["-version"], { timeout: 15_000, windowsHide: true }, (err, stdout) => {
      if (err) {
        const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
        resolve({
          name: "ffmpeg",
          status: "fail",
          detail: missing
            ? `not found at "${path}" (install ffmpeg or set FFMPEG_PATH)`
            : `"${path} -version" failed: ${err.message}`,
        });
        return;
      }
      resolve({ name: "ffmpeg", status: "ok", detail: `${stdout.split(/\r?\n/, 1)[0]} (${path})` });
    });
  });
}

async function launchPlaywrightChromium(): Promise<string> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    return browser.version();
  } finally {
    await browser.close();
  }
}

async function checkChromium(launch: () => Promise<string>): Promise<CheckResult> {
  try {
    return { name: "chromium", status: "ok", detail: `Chromium ${await launch()} launches headless` };
  } catch (err) {
    return {
      name: "chromium",
      status: "fail",
      detail: `${errorText(err).split("\n", 1)[0]} (try: pnpm exec playwright install chromium)`,
    };
  }
}

async function checkPorts(config: Config): Promise<CheckResult[]> {
  const ports: [string, number][] = [
    ["gateway", config.ports.gateway],
    ["partner portal", config.ports.partnerPortal],
    ["supplier portal", config.ports.supplierPortal],
  ];
  return Promise.all(
    ports.map(async ([what, port]): Promise<CheckResult> => {
      const name = `port ${port} (${what})`;
      if (port === 0) return { name, status: "skip", detail: "random port" };
      const problem = await portProblem(port);
      return problem ? { name, status: "fail", detail: problem } : { name, status: "ok", detail: "free" };
    }),
  );
}

function portProblem(port: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", (err: NodeJS.ErrnoException) =>
      resolve(err.code === "EADDRINUSE" ? "in use (another pnpm dev still running?)" : err.message),
    );
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(undefined)));
  });
}

async function checkMetaModels(config: Config, http: Http): Promise<CheckResult> {
  const name = "meta models";
  if (config.meta.mode !== "live" && config.meta.mode !== "record") {
    return { name, status: "skip", detail: `META_MODE=${config.meta.mode}` };
  }
  const res = await http(`${config.meta.baseUrl}/models`, { authorization: `Bearer ${config.meta.apiKey}` });
  if (!res.ok) return { name, status: "fail", detail: `GET /models: ${res.problem}` };
  const ids = modelIds(res.json);
  const missing = META_MODELS.required.filter((m) => !ids.includes(m));
  const missingFallback = META_MODELS.fallback.filter((m) => !ids.includes(m));
  if (missing.length > 0)
    return { name, status: "fail", detail: `not available to this key: ${missing.join(", ")}` };
  if (missingFallback.length > 0) {
    return {
      name,
      status: "warn",
      detail: `${missingFallback.join(", ")} not listed (teach and repair fall back to muse-spark-1.3)`,
    };
  }
  return { name, status: "ok", detail: [...META_MODELS.required, ...META_MODELS.fallback].join(", ") };
}

async function checkWhatsAppToken(config: Config, http: Http, graphBaseUrl: string): Promise<CheckResult> {
  const name = "whatsapp token";
  if (config.whatsapp.mode !== "cloud") return { name, status: "skip", detail: "WHATSAPP_MODE=emulator" };
  const url = `${graphBaseUrl}/${config.whatsapp.graphVersion}/${config.whatsapp.phoneNumberId}`;
  const res = await http(url, { authorization: `Bearer ${config.whatsapp.token}` });
  if (!res.ok) return { name, status: "fail", detail: `GET /{phone-number-id}: ${res.problem}` };
  const body = (res.json ?? {}) as { display_phone_number?: string; verified_name?: string };
  return {
    name,
    status: "ok",
    detail: `phone number ${body.display_phone_number ?? config.whatsapp.phoneNumberId}${body.verified_name ? ` (${body.verified_name})` : ""}`,
  };
}

async function checkBaseten(config: Config, http: Http): Promise<CheckResult> {
  const name = "baseten";
  if (!config.openWeights.apiKey)
    return { name, status: "skip", detail: "BASETEN_API_KEY not set (heal rung 2 skipped)" };
  const res = await http(`${config.openWeights.baseUrl}/models`, {
    authorization: `Bearer ${config.openWeights.apiKey}`,
  });
  if (!res.ok) return { name, status: "fail", detail: `GET /models: ${res.problem}` };
  return modelIds(res.json).includes(config.openWeights.model)
    ? { name, status: "ok", detail: `${config.openWeights.model} listed` }
    : { name, status: "fail", detail: `${config.openWeights.model} is not in the model list` };
}

async function checkHubSpot(config: Config, http: Http, hubspotBaseUrl: string): Promise<CheckResult> {
  const name = "hubspot";
  if (config.crm.mode !== "hubspot") return { name, status: "skip", detail: `CRM_MODE=${config.crm.mode}` };
  const res = await http(`${hubspotBaseUrl}/crm/v3/objects/companies?limit=1`, {
    authorization: `Bearer ${config.crm.hubspotToken}`,
  });
  if (res.ok) return { name, status: "ok", detail: "token valid (companies readable)" };
  const hint =
    res.status === 401
      ? " (token rejected)"
      : res.status === 403
        ? " (missing scope crm.objects.companies.read)"
        : "";
  return { name, status: "fail", detail: `GET /crm/v3/objects/companies: ${res.problem}${hint}` };
}

type Http = (
  url: string,
  headers: Record<string, string>,
) => Promise<{ ok: boolean; status: number; json?: unknown; problem: string }>;

function createHttp(doFetch: typeof fetch, timeoutMs: number): Http {
  return async (url, headers) => {
    try {
      const res = await doFetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      const text = await res.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        // not JSON
      }
      const apiMessage =
        (json as { error?: { message?: string } | string; message?: string } | undefined) ?? {};
      const message =
        typeof apiMessage.error === "object"
          ? apiMessage.error?.message
          : (apiMessage.error ?? apiMessage.message);
      return {
        ok: res.ok,
        status: res.status,
        json,
        problem: `HTTP ${res.status}${message ? `: ${message}` : ""}`,
      };
    } catch (err) {
      return { ok: false, status: 0, problem: `request failed: ${errorText(err)}` };
    }
  };
}

function modelIds(json: unknown): string[] {
  const data = (json as { data?: { id?: unknown }[] } | undefined)?.data;
  return Array.isArray(data) ? data.map((m) => String(m?.id)) : [];
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function redact(text: string, secrets: string[]): string {
  return secrets.reduce((out, secret) => out.split(secret).join("***"), text);
}

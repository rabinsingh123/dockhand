import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type CheckResult, formatReport, runDoctor } from "./doctor-checks.ts";

const byName = (results: CheckResult[], name: string) => results.find((r) => r.name === name);
const quietPorts = { GATEWAY_PORT: "0", PARTNER_PORTAL_PORT: "0", SUPPLIER_PORTAL_PORT: "0" };

const LIVE_ENV = {
  ...quietPorts,
  META_MODE: "live",
  MODEL_API_KEY: "meta-key-SECRET",
  META_BASE_URL: "https://meta.test/v1",
  WHATSAPP_MODE: "cloud",
  WHATSAPP_TOKEN: "wa-token-SECRET",
  WHATSAPP_PHONE_NUMBER_ID: "106540352242922",
  WHATSAPP_APP_SECRET: "app-SECRET",
  WHATSAPP_VERIFY_TOKEN: "verify-SECRET",
  REP_ALLOWLIST: "5511999990000",
  BASETEN_API_KEY: "bt-key-SECRET",
  BASETEN_BASE_URL: "https://baseten.test/v1",
  CRM_MODE: "hubspot",
  HUBSPOT_TOKEN: "pat-SECRET",
  FFMPEG_PATH: "definitely-not-ffmpeg-dockhand",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("runDoctor", () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });

  it("passes the local checks in fake modes and skips the live ones", async () => {
    const results = await runDoctor({
      env: { ...quietPorts, FFMPEG_PATH: "definitely-not-ffmpeg-dockhand" },
      launchBrowser: async () => "140.0.7339.16",
      fetch: async () => {
        throw new Error("no network calls in fake modes");
      },
    });
    expect(byName(results, "node")?.status).toBe("ok");
    expect(byName(results, "config")).toMatchObject({
      status: "ok",
      detail: expect.stringContaining("meta=fake"),
    });
    expect(byName(results, "ffmpeg")).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("set FFMPEG_PATH"),
    });
    expect(byName(results, "chromium")).toMatchObject({
      status: "ok",
      detail: "Chromium 140.0.7339.16 launches headless",
    });
    for (const name of ["meta models", "whatsapp token", "baseten", "hubspot"]) {
      expect(byName(results, name)?.status).toBe("skip");
    }
    expect(results.filter((r) => r.name.startsWith("port ")).map((r) => r.status)).toEqual([
      "skip",
      "skip",
      "skip",
    ]);
  });

  it("reports a port that is already taken", async () => {
    const server = createServer();
    servers.push(server);
    const port = await new Promise<number>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)),
    );
    const results = await runDoctor({
      env: { ...quietPorts, GATEWAY_PORT: String(port) },
      launchBrowser: async () => "1",
    });
    expect(byName(results, `port ${port} (gateway)`)).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("in use"),
    });
  });

  it("checks every live service with the documented requests and never prints a secret", async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const results = await runDoctor({
      env: LIVE_ENV,
      launchBrowser: async () => "1",
      graphBaseUrl: "https://graph.test",
      hubspotBaseUrl: "https://hubspot.test",
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
        if (url === "https://meta.test/v1/models") {
          return json({
            object: "list",
            data: [{ id: "muse-spark-1.3" }, { id: "muse-voice-transcribe-1.0" }],
          });
        }
        if (url === "https://graph.test/v26.0/106540352242922") {
          return json({
            display_phone_number: "15550000000",
            verified_name: "Tidewater Cloud",
            id: "106540352242922",
          });
        }
        if (url === "https://baseten.test/v1/models")
          return json({ data: [{ id: "meta-models/muse-spark-open-1026" }] });
        if (url.startsWith("https://hubspot.test/crm/v3/objects/companies")) {
          return json(
            { status: "error", message: "Authentication credentials not found for pat-SECRET" },
            401,
          );
        }
        return json({}, 404);
      },
    });
    expect(calls).toEqual(
      expect.arrayContaining([
        { url: "https://meta.test/v1/models", auth: "Bearer meta-key-SECRET" },
        { url: "https://graph.test/v26.0/106540352242922", auth: "Bearer wa-token-SECRET" },
        { url: "https://baseten.test/v1/models", auth: "Bearer bt-key-SECRET" },
        { url: "https://hubspot.test/crm/v3/objects/companies?limit=1", auth: "Bearer pat-SECRET" },
      ]),
    );
    expect(byName(results, "meta models")).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("muse-wonder-1.0"),
    });
    expect(byName(results, "whatsapp token")).toMatchObject({
      status: "ok",
      detail: "phone number 15550000000 (Tidewater Cloud)",
    });
    expect(byName(results, "baseten")).toMatchObject({ status: "ok" });
    expect(byName(results, "hubspot")).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("token rejected"),
    });
    const report = formatReport(results);
    expect(report).not.toContain("SECRET");
    expect(report).toContain("***");
    expect(report).toMatch(/FAIL {2}hubspot/);
  });

  it("fails clearly when a model is missing or a service is unreachable", async () => {
    const results = await runDoctor({
      env: LIVE_ENV,
      launchBrowser: async () => {
        throw new Error("Executable doesn't exist at C:\\ms-playwright\\chromium\nmore");
      },
      graphBaseUrl: "https://graph.test",
      hubspotBaseUrl: "https://hubspot.test",
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("meta.test")) return json({ data: [{ id: "muse-wonder-1.0" }] });
        if (url.includes("graph.test")) {
          return json(
            { error: { message: "Error validating access token: Session has expired", code: 190 } },
            401,
          );
        }
        if (url.includes("baseten.test")) return json({ data: [{ id: "another-model" }] });
        throw new TypeError("fetch failed");
      },
    });
    expect(byName(results, "meta models")).toMatchObject({
      status: "fail",
      detail: "not available to this key: muse-spark-1.3, muse-voice-transcribe-1.0",
    });
    expect(byName(results, "whatsapp token")?.detail).toContain("Session has expired");
    expect(byName(results, "baseten")).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("not in the model list"),
    });
    expect(byName(results, "hubspot")?.detail).toContain("request failed: fetch failed");
    expect(byName(results, "chromium")).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("playwright install chromium"),
    });
  });

  it("stops at an invalid config and lists what it skipped", async () => {
    const results = await runDoctor({ env: { META_MODE: "live" }, launchBrowser: async () => "1" });
    expect(byName(results, "config")).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("MODEL_API_KEY"),
    });
    expect(results.filter((r) => r.status === "skip").length).toBeGreaterThanOrEqual(5);
    expect(formatReport(results)).toContain("1 check(s) failed.");
  });
});

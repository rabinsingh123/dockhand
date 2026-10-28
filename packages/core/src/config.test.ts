import { describe, expect, it } from "vitest";
import { loadConfig, modeBanner } from "./config.ts";

const LIVE_ENV = {
  META_MODE: "live",
  MODEL_API_KEY: "sk-meta-SECRET-1",
  WHATSAPP_MODE: "cloud",
  WHATSAPP_TOKEN: "EAAG-SECRET-2",
  WHATSAPP_PHONE_NUMBER_ID: "106540352242922",
  WHATSAPP_APP_SECRET: "app-SECRET-3",
  WHATSAPP_VERIFY_TOKEN: "verify-SECRET-4",
  REP_ALLOWLIST: "5511999990000",
  CRM_MODE: "hubspot",
  HUBSPOT_TOKEN: "pat-SECRET-5",
  BASETEN_API_KEY: "bt-SECRET-6",
};

describe("loadConfig", () => {
  it("defaults to fake/emulator/fake with dev WhatsApp settings", () => {
    const c = loadConfig({});
    expect(c.meta).toEqual({ mode: "fake", apiKey: undefined, baseUrl: "https://api.meta.ai/v1" });
    expect(c.openWeights).toMatchObject({
      model: "meta-models/muse-spark-open",
      apiKey: undefined,
      baseUrl: "https://inference.baseten.co/v1",
    });
    expect(c.whatsapp.mode).toBe("emulator");
    expect(c.whatsapp.graphVersion).toBe("v26.0");
    expect(c.whatsapp.token).toBeTruthy();
    expect(c.whatsapp.phoneNumberId).toMatch(/^\d+$/);
    expect(c.whatsapp.appSecret).toBeTruthy();
    expect(c.whatsapp.verifyToken).toBeTruthy();
    expect(c.crm).toEqual({ mode: "fake", hubspotToken: undefined });
    expect(c.reps.allowlist).toEqual([]);
    expect(c.ports).toEqual({ gateway: 8787, partnerPortal: 5101, supplierPortal: 5102 });
    expect(c.ffmpegPath).toBe("ffmpeg");
    expect(c.headless).toBe(true);
    expect(c.demoMode).toBe(false);
    expect(c.logLevel).toBe("info");
  });

  it("treats empty values as unset, like a fresh copy of .env.example", () => {
    const c = loadConfig({
      META_MODE: "",
      MODEL_API_KEY: "",
      GATEWAY_PORT: " ",
      REP_ALLOWLIST: "",
      HEADLESS: "",
    });
    expect(c.meta.mode).toBe("fake");
    expect(c.meta.apiKey).toBeUndefined();
    expect(c.ports.gateway).toBe(8787);
    expect(c.headless).toBe(true);
  });

  it('accepts the legacy META_MODE "mock" as fake', () => {
    expect(loadConfig({ META_MODE: "mock" }).meta.mode).toBe("fake");
  });

  it("parses the rep allow-list, ports, booleans and prices", () => {
    const c = loadConfig({
      REP_ALLOWLIST: "+5511999990000, 5511999990001,,5511999990000",
      GATEWAY_PORT: "9000",
      PARTNER_PORTAL_PORT: "0",
      HEADLESS: "false",
      DEMO_MODE: "yes",
      OPEN_WEIGHTS_PRICE_IN: "0.5",
      OPEN_WEIGHTS_PRICE_OUT: "1.5",
      META_BASE_URL: "http://localhost:9999/v1/",
      LOG_LEVEL: "debug",
      FFMPEG_PATH: "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
    });
    expect(c.reps.allowlist).toEqual(["5511999990000", "5511999990001"]);
    expect(c.ports.gateway).toBe(9000);
    expect(c.ports.partnerPortal).toBe(0);
    expect(c.headless).toBe(false);
    expect(c.demoMode).toBe(true);
    expect(c.openWeights.priceInPerM).toBe(0.5);
    expect(c.openWeights.priceOutPerM).toBe(1.5);
    expect(c.meta.baseUrl).toBe("http://localhost:9999/v1");
    expect(c.logLevel).toBe("debug");
    expect(c.ffmpegPath).toBe("C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe");
  });

  it("reports every invalid value in one error", () => {
    let message = "";
    try {
      loadConfig({
        REP_ALLOWLIST: "5511999990000,not-a-phone",
        GATEWAY_PORT: "70000",
        HEADLESS: "maybe",
        WHATSAPP_MODE: "sandbox",
        WHATSAPP_GRAPH_VERSION: "26",
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("Invalid configuration");
    for (const key of [
      "REP_ALLOWLIST",
      "not-a-phone",
      "GATEWAY_PORT",
      "HEADLESS",
      "WHATSAPP_MODE",
      "WHATSAPP_GRAPH_VERSION",
    ]) {
      expect(message).toContain(key);
    }
  });

  it("fails fast in META_MODE=live and record without MODEL_API_KEY, not in cassette", () => {
    expect(() => loadConfig({ META_MODE: "live" })).toThrow(/MODEL_API_KEY \(META_MODE=live\)/);
    expect(() => loadConfig({ META_MODE: "record" })).toThrow(/MODEL_API_KEY \(META_MODE=record\)/);
    expect(loadConfig({ META_MODE: "cassette" }).meta.mode).toBe("cassette");
  });

  it("lists every missing WhatsApp cloud setting, and does not invent dev defaults", () => {
    let message = "";
    try {
      loadConfig({ WHATSAPP_MODE: "cloud" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("Missing settings for the active modes");
    for (const key of [
      "WHATSAPP_TOKEN",
      "WHATSAPP_PHONE_NUMBER_ID",
      "WHATSAPP_APP_SECRET",
      "WHATSAPP_VERIFY_TOKEN",
      "REP_ALLOWLIST",
    ]) {
      expect(message).toContain(key);
    }
  });

  it("fails fast in CRM_MODE=hubspot without HUBSPOT_TOKEN", () => {
    expect(() => loadConfig({ CRM_MODE: "hubspot" })).toThrow(/HUBSPOT_TOKEN \(CRM_MODE=hubspot\)/);
  });

  it("lists missing secrets for all live modes at once", () => {
    expect(() => loadConfig({ META_MODE: "live", WHATSAPP_MODE: "cloud", CRM_MODE: "hubspot" })).toThrow(
      /MODEL_API_KEY[\s\S]*WHATSAPP_TOKEN[\s\S]*HUBSPOT_TOKEN/,
    );
  });

  it("loads a complete live configuration from the environment", () => {
    const c = loadConfig(LIVE_ENV);
    expect(c.meta).toMatchObject({ mode: "live", apiKey: "sk-meta-SECRET-1" });
    expect(c.whatsapp).toEqual({
      mode: "cloud",
      token: "EAAG-SECRET-2",
      phoneNumberId: "106540352242922",
      appSecret: "app-SECRET-3",
      verifyToken: "verify-SECRET-4",
      graphVersion: "v26.0",
    });
    expect(c.crm).toEqual({ mode: "hubspot", hubspotToken: "pat-SECRET-5" });
    expect(c.openWeights.apiKey).toBe("bt-SECRET-6");
  });
});

describe("modeBanner", () => {
  it("shows modes, models and ports and never a secret value", () => {
    const banner = modeBanner(loadConfig(LIVE_ENV));
    expect(banner).toContain("meta=live");
    expect(banner).toContain("whatsapp=cloud");
    expect(banner).toContain("crm=hubspot");
    expect(banner).toContain("muse-spark-1.3");
    expect(banner).toContain("meta-models/muse-spark-open");
    expect(banner).toContain("gateway=8787");
    expect(banner).toContain("MODEL_API_KEY=set");
    expect(banner).not.toContain("NOT LIVE");
    expect(banner).not.toMatch(/SECRET/);
    expect(banner.split("\n").length).toBeLessThanOrEqual(20);
  });

  it("warns loudly when anything is not live", () => {
    const banner = modeBanner(loadConfig({}));
    expect(banner).toContain("NOT LIVE");
    expect(banner).toContain("META_MODE=fake");
    expect(banner).toContain("WHATSAPP_MODE=emulator");
    expect(banner).toContain("MODEL_API_KEY=missing");
    expect(banner).not.toContain(loadConfig({}).whatsapp.appSecret);
  });
});

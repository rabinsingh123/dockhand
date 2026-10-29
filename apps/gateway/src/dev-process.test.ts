import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, type InboundMessage, loadConfig } from "@dockhand/core";
import { signatureHeader } from "@dockhand/whatsapp";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REFUSAL_TEXT } from "./app.ts";
import { type DevProcess, startDevProcess } from "./dev-process.ts";

const REP = "5511999990000";
const STRANGER = "5521977770000";
const OGG = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 9, 8, 7, 6]);

const config = loadConfig({
  GATEWAY_PORT: "0",
  PARTNER_PORTAL_PORT: "0",
  SUPPLIER_PORTAL_PORT: "0",
  REP_ALLOWLIST: REP,
  LOG_LEVEL: "silent",
});

describe("dev process in emulator mode (real HTTP)", () => {
  let dir: string;
  let dev: DevProcess;
  const emulator = () => {
    if (!dev.emulator) throw new Error("emulator mode expected");
    return dev.emulator;
  };
  const rowCount = (waId: string) =>
    (dev.db.raw.prepare("SELECT COUNT(*) AS n FROM messages WHERE wa_id = ?").get(waId) as { n: number }).n;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dockhand-gateway-"));
    dev = await startDevProcess({
      config,
      dbPath: join(dir, "dockhand.sqlite"),
      dataDir: dir,
      portals: false,
      log: createLogger({ level: "silent" }),
    });
  });
  afterAll(async () => {
    await dev?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("emulator -> signed webhook -> gateway -> placeholder echo in the emulator outbox", async () => {
    const waId = await emulator().control.send(REP, { text: "Oi, tudo bem?" });
    const echo = await emulator().control.waitFor((m) => m.to === REP && m.body === "Received text");
    expect(echo.type).toBe("text");
    expect(rowCount(waId)).toBe(1);
  });

  it("dedupes Meta's retry of the same signed payload", async () => {
    emulator().control.reset();
    const waId = await emulator().control.send(REP, { text: "duplicado?" });
    await emulator().control.waitFor((m) => m.body === "Received text");
    expect(await emulator().redeliver(waId)).toBe(200);
    expect(await emulator().redeliver(waId)).toBe(200);
    await dev.drain();
    expect(rowCount(waId)).toBe(1);
    expect(
      emulator()
        .control.outbox(REP)
        .filter((m) => m.body === "Received text"),
    ).toHaveLength(1);
  });

  it("answers 401 to a bad signature and stores nothing", async () => {
    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
    const res = await fetch(dev.urls.webhook, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signatureHeader(body, "wrong-secret"),
      },
      body,
    });
    expect(res.status).toBe(401);
    const unsigned = await fetch(dev.urls.webhook, { method: "POST", body });
    expect(unsigned.status).toBe(401);
  });

  it("refuses an unknown sender once and never stores their messages", async () => {
    emulator().control.reset();
    await emulator().control.send(STRANGER, { text: "quem é você?" });
    await emulator().control.send(STRANGER, { text: "alô?" });
    await dev.drain();
    expect(
      emulator()
        .control.outbox(STRANGER)
        .map((m) => m.body),
    ).toEqual([REFUSAL_TEXT]);
    const stored = dev.db.raw.prepare("SELECT COUNT(*) AS n FROM messages WHERE rep = ?").get(STRANGER);
    expect(stored).toEqual({ n: 0 });
  });

  it("serves inbound media through the mounted fake Graph API", async () => {
    emulator().control.reset();
    const path = join(dir, "nota.ogg");
    writeFileSync(path, OGG);
    const waId = await emulator().control.send(REP, { file: { path, mime: "audio/ogg", voice: true } });
    await emulator().control.waitFor((m) => m.body === "Received audio");
    const row = dev.db.raw.prepare("SELECT raw_json FROM messages WHERE wa_id = ?").get(waId) as {
      raw_json: string;
    };
    const mediaId = (JSON.parse(row.raw_json) as { audio: { id: string } }).audio.id;
    expect(await dev.whatsapp.downloadMedia(mediaId)).toEqual({ data: OGG, mime: "audio/ogg; codecs=opus" });
  });

  it("lets the orchestrator replace the handler through wire()", async () => {
    emulator().control.reset();
    const received: InboundMessage[] = [];
    dev.wire(async (messages) => {
      received.push(...messages);
      for (const m of messages) await dev.whatsapp.sendText(m.from, `handled ${m.kind}`);
    });
    await emulator().control.send(REP, { text: "novo handler" });
    await emulator().control.waitFor((m) => m.body === "handled text");
    expect(received.map((m) => m.text)).toEqual(["novo handler"]);
    expect(
      emulator()
        .control.outbox()
        .some((m) => m.body === "Received text"),
    ).toBe(false);
  });

  it("serves the verification handshake, health and the dev chat page", async () => {
    const verify = await fetch(
      `${dev.urls.webhook}?hub.mode=subscribe&hub.verify_token=${config.whatsapp.verifyToken}&hub.challenge=42`,
    );
    expect(await verify.text()).toBe("42");
    expect(await (await fetch(`${dev.urls.gateway}/__health`)).json()).toMatchObject({ ok: true });
    const page = await fetch(dev.urls.devChat ?? "");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Dockhand chat (emulator)");
  });
});

describe("dev process in cloud mode behind a tunnel", () => {
  // cloudflared connects from 127.0.0.1 and forwards the public Host plus Cloudflare's headers.
  const TUNNEL = {
    host: "demo-words.trycloudflare.com",
    "cf-connecting-ip": "203.0.113.9",
    "cf-ray": "8f00000000000000-GRU",
    "x-forwarded-for": "203.0.113.9",
  };
  const cloud = loadConfig({
    WHATSAPP_MODE: "cloud",
    WHATSAPP_TOKEN: "cloud-test-token",
    WHATSAPP_PHONE_NUMBER_ID: "109000000000002",
    WHATSAPP_APP_SECRET: "cloud-test-secret",
    WHATSAPP_VERIFY_TOKEN: "cloud-test-verify",
    REP_ALLOWLIST: REP,
    GATEWAY_PORT: "0",
    LOG_LEVEL: "silent",
  });
  let dir: string;
  let dev: DevProcess;
  const get = (path: string, headers: Record<string, string> = {}, method = "GET", body?: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const { port } = new URL(dev.urls.gateway);
      const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      });
      req.on("error", reject);
      req.end(body);
    });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dockhand-gateway-cloud-"));
    const tools = new Hono();
    tools.get("/__dev/crm", (c) => c.json({ deals: ["synthetic"] }));
    dev = await startDevProcess({
      config: cloud,
      dbPath: join(dir, "dockhand.sqlite"),
      dataDir: dir,
      portals: false,
      routes: tools,
      log: createLogger({ level: "silent" }),
      onMessages: () => {},
    });
  });
  afterAll(async () => {
    await dev?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the flight recorder and dev routes off the tunnel", async () => {
    for (const path of ["/recorder", "/recorder/runs/01ABC", "/recorder/a/01ABC", "/__dev/crm"]) {
      const res = await get(path, TUNNEL);
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
    }
    // cloudflared --http-host-header 127.0.0.1 rewrites Host but still adds Cloudflare's headers.
    const rewritten = await get("/recorder", { ...TUNNEL, host: "127.0.0.1" });
    expect(rewritten.status).toBe(404);
    // DNS rebinding: a page on another name that resolves to 127.0.0.1.
    expect((await get("/recorder", { host: "rebind.attacker.example:8787" })).status).toBe(404);
  });

  it("still serves the recorder and dev routes to a local browser", async () => {
    expect((await get("/recorder", { host: "localhost:8787" })).status).toBe(200);
    expect((await get("/__dev/crm", { host: "127.0.0.1:8787" })).body).toContain("synthetic");
  });

  it("serves the signed webhook, the handshake and health through the tunnel", async () => {
    const verify = await get(
      "/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=cloud-test-verify&hub.challenge=42",
      TUNNEL,
    );
    expect(verify).toEqual({ status: 200, body: "42" });
    expect((await get("/__health", TUNNEL)).status).toBe(200);
    const payload = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
    const signed = await get(
      "/webhook/whatsapp",
      {
        ...TUNNEL,
        "content-type": "application/json",
        "x-hub-signature-256": signatureHeader(payload, "cloud-test-secret"),
      },
      "POST",
      payload,
    );
    expect(signed.status).toBe(200);
  });

  it("answers /__health through the tunnel with liveness only; modes stay local", async () => {
    const remote = await get("/__health", TUNNEL);
    expect(JSON.parse(remote.body)).toEqual({ ok: true });
    const local = JSON.parse((await get("/__health", { host: "127.0.0.1:8787" })).body) as Record<
      string,
      unknown
    >;
    expect(local).toMatchObject({ ok: true, modes: { whatsapp: "cloud" }, pending: 0 });
  });
});

describe("dev process lifecycle", () => {
  it("starts the portals with the gateway and releases every port on close", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dockhand-gateway-full-"));
    const dev = await startDevProcess({
      config,
      dbPath: join(dir, "dockhand.sqlite"),
      dataDir: dir,
      log: createLogger({ level: "silent" }),
    });
    try {
      expect(dev.portals?.partner.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect((await fetch(dev.portals?.partner.url ?? "")).status).toBeLessThan(500);
      expect((await fetch(dev.portals?.supplier.url ?? "")).status).toBeLessThan(500);
      // An open /dev/chat event stream must not hold shutdown.
      const stream = await fetch(`${dev.urls.devChat}/events`);
      expect(stream.headers.get("content-type")).toContain("text/event-stream");
    } finally {
      await dev.close();
      rmSync(dir, { recursive: true, force: true });
    }
    await expect(fetch(`${dev.urls.gateway}/__health`)).rejects.toThrow();
  });

  it("does not let a handler that waits on a human hold shutdown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dockhand-gateway-hang-"));
    const dev = await startDevProcess({
      config,
      dbPath: join(dir, "dockhand.sqlite"),
      dataDir: dir,
      portals: false,
      drainTimeoutMs: 50,
      log: createLogger({ level: "silent" }),
      onMessages: () => new Promise<void>(() => {}), // e.g. awaiting an approval tap
    });
    try {
      await dev.emulator?.control.send(REP, { text: "aprovar depois" });
    } finally {
      await dev.close();
      rmSync(dir, { recursive: true, force: true });
    }
    await expect(fetch(`${dev.urls.gateway}/__health`)).rejects.toThrow();
  });
});

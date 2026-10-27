import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createFixedClock,
  createLogger,
  type Db,
  type InboundMessage,
  loadConfig,
  openDb,
  workspaceRoot,
} from "@dockhand/core";
import { signatureHeader } from "@dockhand/whatsapp";
import { afterEach, describe, expect, it } from "vitest";
import { createGatewayApp, REFUSAL_TEXT } from "./app.ts";

const REP = "5511999990000";
const OTHER = "5521988880000";
const fixture = (name: string) =>
  readFileSync(join(workspaceRoot(), "packages/whatsapp/src/__fixtures__", name), "utf8");

const dbs: Db[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

function setup(opts: { handler?: (m: InboundMessage[]) => Promise<void> } = {}) {
  const config = loadConfig({ REP_ALLOWLIST: REP, LOG_LEVEL: "silent" });
  const db = openDb(":memory:");
  dbs.push(db);
  const clock = createFixedClock(Date.UTC(2026, 9, 27, 15));
  const batches: InboundMessage[][] = [];
  const sent: { to: string; body: string }[] = [];
  const gateway = createGatewayApp({
    config,
    db,
    clock,
    log: createLogger({ level: "silent" }),
    onMessages:
      opts.handler ??
      (async (messages) => {
        batches.push(messages);
      }),
    sendText: async (to, body) => {
      sent.push({ to, body });
    },
  });
  const secret = config.whatsapp.appSecret ?? "";
  // signature null = send no header at all
  const post = (raw: string, signature: string | null = signatureHeader(raw, secret)) =>
    gateway.app.request("/webhook/whatsapp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(signature !== null ? { "x-hub-signature-256": signature } : {}),
      },
      body: raw,
    });
  const rows = () =>
    db.raw
      .prepare(
        "SELECT wa_id, direction, rep, kind, text, button_id, reply_to, raw_json, created_at FROM messages",
      )
      .all();
  return { config, db, clock, gateway, batches, sent, post, rows };
}

describe("GET /webhook/whatsapp (verification)", () => {
  it("echoes hub.challenge for the right verify token only", async () => {
    const { gateway, config } = setup();
    const query = (token: string, mode = "subscribe") =>
      `/webhook/whatsapp?hub.mode=${mode}&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=1158201444`;
    const ok = await gateway.app.request(query(config.whatsapp.verifyToken ?? ""));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("1158201444");
    expect((await gateway.app.request(query("wrong"))).status).toBe(403);
    expect((await gateway.app.request(query(config.whatsapp.verifyToken ?? "", "unsubscribe"))).status).toBe(
      403,
    );
    expect((await gateway.app.request("/webhook/whatsapp")).status).toBe(403);
  });
});

describe("POST /webhook/whatsapp", () => {
  it("rejects a missing or wrong signature with 401 and stores nothing", async () => {
    const s = setup();
    const raw = fixture("text.json");
    expect((await s.post(raw, null)).status).toBe(401);
    expect((await s.post(raw, "")).status).toBe(401);
    expect((await s.post(raw, signatureHeader(raw, "not-the-secret"))).status).toBe(401);
    expect(
      (await s.post(raw.replace("Oi!", "Oi?"), signatureHeader(raw, s.config.whatsapp.appSecret ?? "")))
        .status,
    ).toBe(401);
    await s.gateway.drain();
    expect(s.rows()).toEqual([]);
    expect(s.batches).toEqual([]);
  });

  it("stores a new message and hands it to onMessages", async () => {
    const s = setup();
    const res = await s.post(fixture("text.json"));
    expect(res.status).toBe(200);
    await s.gateway.drain();
    expect(s.batches).toHaveLength(1);
    expect(s.batches[0]?.map((m) => [m.kind, m.from])).toEqual([["text", REP]]);
    const [row] = s.rows() as Record<string, unknown>[];
    expect(row).toMatchObject({
      direction: "in",
      rep: REP,
      kind: "text",
      text: "Oi! Pode mandar o preço para 25 pessoas em São Paulo, começando em janeiro?",
      button_id: null,
      reply_to: null,
      created_at: s.clock.now(),
    });
    expect(JSON.parse(String(row?.raw_json))).toMatchObject({ type: "text", from: REP });
  });

  it("dedupes retries of the same payload by wamid", async () => {
    const s = setup();
    const raw = fixture("voice-note.json");
    expect((await s.post(raw)).status).toBe(200);
    expect((await s.post(raw)).status).toBe(200);
    await s.gateway.drain();
    expect(s.rows()).toHaveLength(1);
    expect(s.batches).toHaveLength(1);
  });

  it("stores button taps with the button id and the card they answer", async () => {
    const s = setup();
    await s.post(fixture("button-reply.json"));
    await s.gateway.drain();
    expect(s.rows()[0]).toMatchObject({
      kind: "button",
      text: null,
      button_id: "g:01JBGATE0000000000000000AA:a",
      reply_to: "wamid.HBgNNTUxMTk5OTk5MDAwMBUCABEYEkRPQ0tIQU5EUExBTkNBUkQwMQA=",
    });
  });

  it("answers 200 to statuses-only and to signed bodies that are not JSON", async () => {
    const s = setup();
    expect((await s.post(fixture("statuses-only.json"))).status).toBe(200);
    expect((await s.post("{not json")).status).toBe(200);
    await s.gateway.drain();
    expect(s.rows()).toEqual([]);
    expect(s.batches).toEqual([]);
  });

  it("refuses unknown senders once per day and stores nothing for them", async () => {
    const s = setup();
    const raw = fixture("multi-message.json"); // two messages from REP, one from OTHER
    await s.post(raw);
    await s.gateway.drain();
    expect((s.rows() as { rep: string }[]).map((r) => r.rep)).toEqual([REP, REP]);
    expect(s.sent).toEqual([{ to: OTHER, body: REFUSAL_TEXT }]);
    expect(s.db.raw.prepare("SELECT phone, allowed, refused_at FROM reps").all()).toEqual([
      { phone: OTHER, allowed: 0, refused_at: s.clock.now() },
    ]);

    const again = raw.replaceAll(
      "wamid.HBgNNTUyMTk4ODg4MDAwMBUCABIYFDNBMDFGQUtFMDAxMlRFWFQAAA==",
      "wamid.OTHER2",
    );
    await s.post(again);
    await s.gateway.drain();
    expect(s.sent).toHaveLength(1);

    s.clock.advance(24 * 60 * 60 * 1000);
    await s.post(
      raw.replaceAll("wamid.HBgNNTUyMTk4ODg4MDAwMBUCABIYFDNBMDFGQUtFMDAxMlRFWFQAAA==", "wamid.OTHER3"),
    );
    await s.gateway.drain();
    expect(s.sent).toHaveLength(2);
    expect(s.rows()).toHaveLength(2); // REP's messages were duplicates; OTHER's never stored
  });

  it("answers before onMessages starts, and drain() waits for it", async () => {
    const calls: InboundMessage[][] = [];
    let release: () => void = () => {};
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const s = setup({
      handler: (messages) => {
        calls.push(messages);
        markStarted();
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    expect((await s.post(fixture("text.json"))).status).toBe(200);
    expect(calls).toHaveLength(0); // the response went out first
    await started;
    const health = (await (await s.gateway.app.request("/__health")).json()) as { pending: number };
    expect(health.pending).toBe(1);
    let drained = false;
    const draining = s.gateway.drain().then(() => {
      drained = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);
    release();
    await draining;
    expect(calls).toHaveLength(1);
  });

  it("keeps answering 200 when onMessages throws", async () => {
    const s = setup({
      handler: async () => {
        throw new Error("orchestrator bug");
      },
    });
    expect((await s.post(fixture("text.json"))).status).toBe(200);
    await s.gateway.drain();
    expect(s.rows()).toHaveLength(1);
  });

  it("rejects oversized bodies", async () => {
    const s = setup();
    const res = await s.post(`{"pad":"${"x".repeat(5 * 1024 * 1024)}"}`, "sha256=0");
    expect(res.status).toBe(413);
  });
});

describe("GET /__health", () => {
  it("reports modes and db health", async () => {
    const { gateway } = setup();
    expect(await (await gateway.app.request("/__health")).json()).toEqual({
      ok: true,
      modes: { meta: "fake", whatsapp: "emulator", crm: "fake" },
      pending: 0,
    });
  });
});

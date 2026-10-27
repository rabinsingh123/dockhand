// Test-only wiring: the real client talking to the emulator in-process, with every request recorded.
import { type Clock, createFixedClock, createMemoryArtifactStore } from "@dockhand/core";
import { createWhatsAppClient } from "./client.ts";
import { createEmulator } from "./emulator.ts";

/** A nested value from parsed JSON, or undefined when any step is missing. */
export function dig(value: unknown, ...path: (string | number)[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

export const SECRET = "test-app-secret";
export const TOKEN = "test-token";
export const PHONE_ID = "109000000000001";
export const VERSION = "v26.0";
export const REP = "5511999990000";

export const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
]);
export const PDF = new TextEncoder().encode("%PDF-1.4\n% Tidewater Cloud quote Q-2026-0001\n%%EOF\n");
export const OGG = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4]);
export const MP4 = new Uint8Array([
  0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0, 0, 0, 0,
]);

export interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | null;
  json?: Record<string, unknown>;
  form?: Record<string, string | { name: string; type: string; size: number }>;
}

export interface Webhook {
  raw: string;
  signature: string | null;
  body: unknown;
}

export function createWorld(opts: { clock?: Clock; webhookStatus?: number; token?: string } = {}) {
  const clock = opts.clock ?? createFixedClock(Date.UTC(2026, 9, 27, 12, 0, 0));
  const webhooks: Webhook[] = [];
  const emulator = createEmulator({
    webhookUrl: "http://gateway.test/webhook/whatsapp",
    appSecret: SECRET,
    phoneNumberId: PHONE_ID,
    graphVersion: VERSION,
    token: TOKEN,
    clock,
    fetch: async (_url, init) => {
      const raw = String(init?.body);
      webhooks.push({
        raw,
        signature: new Headers(init?.headers).get("x-hub-signature-256"),
        body: JSON.parse(raw),
      });
      return new Response("EVENT_RECEIVED", { status: opts.webhookStatus ?? 200 });
    },
  });

  const requests: RecordedRequest[] = [];
  const graphFetch: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    const recorded: RecordedRequest = {
      method: req.method,
      url: req.url,
      authorization: req.headers.get("authorization"),
    };
    const type = req.headers.get("content-type") ?? "";
    if (type.includes("application/json"))
      recorded.json = (await req.clone().json()) as Record<string, unknown>;
    if (type.includes("multipart/form-data")) {
      recorded.form = {};
      for (const [key, value] of (await req.clone().formData()).entries()) {
        recorded.form[key] =
          typeof value === "string" ? value : { name: value.name, type: value.type, size: value.size };
      }
    }
    requests.push(recorded);
    return emulator.app.request(req);
  };

  const artifacts = createMemoryArtifactStore(clock);
  const client = createWhatsAppClient({
    baseUrl: "http://emulator.test/graph",
    graphVersion: VERSION,
    token: opts.token ?? TOKEN,
    phoneNumberId: PHONE_ID,
    artifacts,
    fetch: graphFetch,
  });
  return { clock, emulator, control: emulator.control, client, artifacts, webhooks, requests, graphFetch };
}

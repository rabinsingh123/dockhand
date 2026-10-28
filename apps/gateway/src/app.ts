import { timingSafeEqual } from "node:crypto";
import {
  type Clock,
  type Config,
  type Db,
  type InboundMessage,
  type Logger,
  systemClock,
} from "@dockhand/core";
import { parseWebhookEntries, verifySignature } from "@dockhand/whatsapp";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

/** Receives newly stored (deduplicated, allow-listed) inbound messages, after the webhook has answered. */
export type OnMessages = (messages: InboundMessage[]) => Promise<void> | void;

export interface GatewayDeps {
  config: Config;
  db: Db;
  log: Logger;
  onMessages: OnMessages;
  /** Sends the refusal to senders outside REP_ALLOWLIST (at most once per sender per 24 h). */
  sendText?: (to: string, body: string) => Promise<unknown>;
  clock?: Clock;
}

export interface GatewayApp {
  /** GET/POST /webhook/whatsapp and GET /__health. */
  app: Hono;
  /** Resolves when every background task started by a webhook (handlers, refusals) has settled. */
  drain(): Promise<void>;
}

export const REFUSAL_TEXT =
  "Olá! Este número executa os fluxos internos de vendas da Tidewater Cloud e só atende pessoas cadastradas da equipe. " +
  "Se você precisa de acesso, fale com seu contato na Tidewater Cloud.\n\n" +
  "Hi! This number runs Tidewater Cloud's internal sales workflows and only works for registered team members. " +
  "If you need access, ask your Tidewater Cloud contact.";

const REFUSAL_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_WEBHOOK_BYTES = 5 * 1024 * 1024; // Meta: "Webhook payloads can be up to 3 MB"

export function createGatewayApp(deps: GatewayDeps): GatewayApp {
  const { config, db, log } = deps;
  const clock = deps.clock ?? systemClock;
  const allowlist = new Set(config.reps.allowlist);
  const pending = new Set<Promise<unknown>>();

  const background = (what: string, task: () => Promise<unknown> | unknown) => {
    // setImmediate: even a handler's synchronous start runs after the 200 has been written.
    const run = new Promise<void>((resolve) => setImmediate(resolve))
      .then(task)
      .catch((err: unknown) => log.error(`${what} failed`, { err }));
    pending.add(run);
    void run.finally(() => pending.delete(run));
  };

  const insertMessage = db.raw.prepare(
    `INSERT INTO messages (wa_id, direction, rep, kind, text, button_id, reply_to, raw_json, created_at)
     VALUES (?, 'in', ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(wa_id) DO NOTHING`,
  );
  // One row per unknown sender; refused_at only moves when the last refusal is 24 h old.
  const claimRefusal = db.raw.prepare(
    `INSERT INTO reps (phone, allowed, refused_at) VALUES (?, 0, ?)
     ON CONFLICT(phone) DO UPDATE SET refused_at = excluded.refused_at
     WHERE reps.refused_at IS NULL OR reps.refused_at <= ?`,
  );

  const app = new Hono();

  app.get("/webhook/whatsapp", (c) => {
    const mode = c.req.query("hub.mode");
    const token = c.req.query("hub.verify_token");
    const challenge = c.req.query("hub.challenge");
    const expected = config.whatsapp.verifyToken;
    if (mode === "subscribe" && challenge !== undefined && token && expected && sameText(token, expected)) {
      log.info("webhook verification accepted");
      return c.text(challenge, 200);
    }
    log.warn("webhook verification refused", { mode });
    return c.text("Forbidden", 403);
  });

  app.post(
    "/webhook/whatsapp",
    bodyLimit({ maxSize: MAX_WEBHOOK_BYTES, onError: (c) => c.text("Payload Too Large", 413) }),
    async (c) => {
      // Read the body once, as bytes: the signature covers the exact bytes Meta sent.
      const raw = new Uint8Array(await c.req.arrayBuffer());
      if (!verifySignature(raw, c.req.header("x-hub-signature-256"), config.whatsapp.appSecret ?? "")) {
        log.warn("webhook signature rejected", { bytes: raw.byteLength });
        return c.text("Invalid signature", 401);
      }
      // Verified: always 200 from here on, or Meta retries the same payload for days.
      try {
        handleVerifiedPayload(raw);
      } catch (err) {
        log.error("webhook processing failed; answered 200 anyway", { err, bytes: raw.byteLength });
      }
      return c.text("OK", 200);
    },
  );

  app.get("/__health", (c) => {
    const dbOk = (db.raw.prepare("SELECT 1 AS ok").get() as { ok: number } | undefined)?.ok === 1;
    return c.json({
      ok: dbOk,
      modes: { meta: config.meta.mode, whatsapp: config.whatsapp.mode, crm: config.crm.mode },
      pending: pending.size,
    });
  });

  function handleVerifiedPayload(raw: Uint8Array): void {
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      log.warn("webhook body is not JSON", { bytes: raw.byteLength });
      return;
    }
    const { entries, ignored } = parseWebhookEntries(body);
    const now = clock.now();
    const fresh: InboundMessage[] = [];
    const refuse: string[] = [];
    let duplicates = 0;
    let silent = 0;

    db.tx(() => {
      for (const { message, raw: rawMessage } of entries) {
        if (!allowlist.has(message.from)) {
          // Nothing is stored or downloaded for unknown senders; at most one refusal per day.
          if (
            !refuse.includes(message.from) &&
            claimRefusal.run(message.from, now, now - REFUSAL_INTERVAL_MS).changes > 0
          ) {
            refuse.push(message.from);
          }
          continue;
        }
        const inserted = insertMessage.run(
          message.waId,
          message.from,
          message.kind,
          message.text ?? null,
          message.button?.id ?? null,
          message.replyTo ?? null,
          JSON.stringify(rawMessage),
          now,
        );
        if (inserted.changes === 0) duplicates++;
        else if (isSilent(rawMessage))
          silent++; // stored (deduped), never answered
        else fresh.push(message);
      }
    });

    log.info("webhook received", {
      messages: entries.length,
      fresh: fresh.length,
      duplicates,
      silent,
      refused: refuse.length,
      blocked: entries.length - fresh.length - duplicates - silent,
      ignored,
    });
    for (const to of refuse) {
      background("refusal", async () => {
        if (!deps.sendText) {
          log.warn("unknown sender; no sender function wired for the refusal", { to });
          return;
        }
        await deps.sendText(to, REFUSAL_TEXT);
        log.info("refused unknown sender", { to });
      });
    }
    if (fresh.length > 0) background("onMessages", () => deps.onMessages(fresh));
  }

  return {
    app,
    async drain() {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
  };
}

/** Reactions and stickers are a rep acknowledging something: no reply, no job. */
const SILENT_TYPES = new Set(["reaction", "sticker"]);

function isSilent(raw: unknown): boolean {
  return (
    typeof raw === "object" && raw !== null && SILENT_TYPES.has(String((raw as { type?: unknown }).type))
  );
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

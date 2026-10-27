import { createHmac, timingSafeEqual } from "node:crypto";
import type { InboundKind, InboundMessage, ParsedWebhook } from "@dockhand/core";

type JsonObject = Record<string, unknown>;

/** One parsed message plus the raw `messages[i]` object it came from (the gateway stores it). */
export interface ParsedEntry {
  message: InboundMessage;
  raw: unknown;
}

/**
 * Cloud API webhook payload -> messages. Never throws. Statuses, value-level errors, non-message
 * fields and malformed messages are counted in `ignored`; message types we do not handle come back
 * as kind "unsupported" so the caller can answer them.
 */
export function parseWebhook(body: unknown): ParsedWebhook {
  const { entries, ignored } = parseWebhookEntries(body);
  return { messages: entries.map((e) => e.message), ignored };
}

/** parseWebhook, keeping each message's raw JSON object. Never throws. */
export function parseWebhookEntries(body: unknown): { entries: ParsedEntry[]; ignored: number } {
  const entries: ParsedEntry[] = [];
  let ignored = 0;
  try {
    if (!isObject(body) || !Array.isArray(body.entry)) return { entries, ignored: 1 };
    for (const entry of body.entry) {
      if (!isObject(entry) || !Array.isArray(entry.changes)) {
        ignored++;
        continue;
      }
      for (const change of entry.changes) {
        if (!isObject(change) || change.field !== "messages" || !isObject(change.value)) {
          ignored++;
          continue;
        }
        const value = change.value;
        const statuses = list(value.statuses).length + list(value.errors).length;
        const messages = list(value.messages);
        ignored += statuses;
        if (statuses === 0 && messages.length === 0) ignored++;
        for (const raw of messages) {
          const message = parseMessage(raw);
          if (message) entries.push({ message, raw });
          else ignored++;
        }
      }
    }
  } catch {
    // Defensive only: the walk above checks every shape it touches.
  }
  return { entries, ignored };
}

function parseMessage(raw: unknown): InboundMessage | undefined {
  if (!isObject(raw)) return undefined;
  const waId = text(raw.id);
  const from = text(raw.from)?.replace(/^\+/, "");
  if (!waId || !from) return undefined;

  const seconds = Number(raw.timestamp);
  const base: InboundMessage = {
    waId,
    from,
    ts: Number.isFinite(seconds) ? seconds * 1000 : 0,
    kind: "unsupported",
  };
  if (isObject(raw.context)) {
    const replyTo = text(raw.context.id);
    if (replyTo) base.replyTo = replyTo;
    if (raw.context.forwarded === true || raw.context.frequently_forwarded === true) base.forwarded = true;
  }

  switch (raw.type) {
    case "text": {
      const body = isObject(raw.text) ? text(raw.text.body) : undefined;
      return { ...base, kind: "text", text: body ?? "" };
    }
    case "audio":
    case "image":
    case "video":
    case "document":
      return withMedia(base, raw.type, raw[raw.type]);
    case "interactive": {
      // Reply buttons; list replies are treated the same way (id + title).
      const interactive = isObject(raw.interactive) ? raw.interactive : {};
      const reply = isObject(interactive.button_reply)
        ? interactive.button_reply
        : isObject(interactive.list_reply)
          ? interactive.list_reply
          : undefined;
      const id = text(reply?.id);
      return id ? { ...base, kind: "button", button: { id, title: text(reply?.title) ?? "" } } : base;
    }
    case "button": {
      // Quick-reply button on a template message: { payload, text }.
      const button = isObject(raw.button) ? raw.button : {};
      const id = text(button.payload) ?? text(button.text);
      return id ? { ...base, kind: "button", button: { id, title: text(button.text) ?? "" } } : base;
    }
    default:
      return base;
  }
}

function withMedia(base: InboundMessage, kind: InboundKind, payload: unknown): InboundMessage {
  if (!isObject(payload)) return base;
  const mediaId = text(payload.id);
  if (!mediaId) return base;
  const media: NonNullable<InboundMessage["media"]> = {
    mediaId,
    mime: text(payload.mime_type) ?? "application/octet-stream",
  };
  if (kind === "document" && text(payload.filename)) media.filename = text(payload.filename);
  if (kind === "audio") media.voice = payload.voice === true;
  const message: InboundMessage = { ...base, kind, media };
  const caption = text(payload.caption);
  if (caption) message.text = caption;
  return message;
}

/**
 * Checks `X-Hub-Signature-256: sha256=<hex>`: HMAC-SHA256 of the raw body bytes with the app secret,
 * compared in constant time. False for a missing or malformed header or an empty secret.
 */
export function verifySignature(raw: Uint8Array, header: string | undefined, appSecret: string): boolean {
  if (!appSecret || typeof header !== "string") return false;
  const match = /^sha256=([0-9a-fA-F]{64})$/.exec(header.trim());
  if (!match?.[1]) return false;
  const expected = createHmac("sha256", appSecret).update(raw).digest();
  const given = Buffer.from(match[1], "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The header value Meta would send for this exact body. */
export function signatureHeader(raw: Uint8Array | string, appSecret: string): string {
  return `sha256=${createHmac("sha256", appSecret).update(raw).digest("hex")}`;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

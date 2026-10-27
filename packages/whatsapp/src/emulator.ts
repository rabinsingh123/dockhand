import { createHash, randomBytes, randomInt } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import {
  type Button,
  type Clock,
  type EmulatorControl,
  type OutboundRecord,
  systemClock,
  ulid,
} from "@dockhand/core";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { chatPage } from "./chat-page.ts";
import {
  baseMime,
  buttonProblems,
  captionProblems,
  mediaProblems,
  mediaTypeFor,
  textProblems,
} from "./limits.ts";
import { signatureHeader } from "./webhook.ts";

export interface EmulatorConfig {
  /** Where inbound webhooks are POSTed. A function when the URL is only known after listen (port 0). */
  webhookUrl: string | (() => string);
  appSecret: string;
  phoneNumberId: string;
  graphVersion: string;
  /** Bearer token the fake Graph API accepts. Omitted: any non-empty token. */
  token?: string;
  /** The business number: metadata.display_phone_number and context.from of replies. */
  displayPhoneNumber?: string;
  /** Prefilled sender on /dev/chat. */
  defaultFrom?: string;
  clock?: Clock;
  /** Delivers webhooks. Defaults to global fetch; tests can route to an in-process app. */
  fetch?: typeof fetch;
}

export interface Emulator {
  /**
   * Routes: POST /graph/{ver}/{phone-id}/messages, POST /graph/{ver}/{phone-id}/media,
   * GET /graph/{ver}/{media-id}, GET /lookaside/{media-id} (the short-lived download URL),
   * and the dev chat: GET /dev/chat (+ /events, /timeline, /send, /tap, /reset, /media/{id}).
   * The client's baseUrl is `<origin>/graph`.
   */
  app: Hono;
  control: EmulatorControl;
  /** Delivers the identical signed webhook for an inbound message again, as Meta's retries do. Returns the HTTP status. */
  redeliver(waId: string): Promise<number>;
  /** Ends /dev/chat event streams and rejects pending waitFor calls. Call before closing the HTTP server. */
  close(): void;
}

/** What the /dev/chat page renders. `in` = rep to Dockhand (webhook), `out` = Dockhand to rep (Graph API). */
export interface ChatEntry {
  seq: number;
  dir: "in" | "out";
  waId: string;
  peer: string; // the rep's number
  ts: number;
  type: "text" | "audio" | "image" | "video" | "document" | "interactive" | "button_reply";
  text?: string;
  caption?: string;
  media?: { id: string; mime: string; bytes: number; filename?: string; voice?: boolean };
  header?: { type: "image"; mediaId: string } | { type: "text"; text: string };
  footer?: string;
  buttons?: Button[];
  replyTo?: string;
  forwarded?: boolean;
  read?: boolean;
  failed?: string;
}

interface StoredMedia {
  id: string;
  data: Uint8Array;
  mime: string;
  sha256: string; // hex
  filename?: string;
}

interface Waiter {
  pred: (m: OutboundRecord) => boolean;
  resolve: (m: OutboundRecord) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type ChatEvent =
  | { type: "entry" | "update"; data: ChatEntry }
  | { type: "snapshot"; data: { entries: ChatEntry[] } };

type InboundFile = {
  data: Uint8Array;
  mime: string;
  filename?: string;
  voice?: boolean;
  asDocument?: boolean;
};
type InboundInput = {
  text?: string;
  caption?: string;
  replyTo?: string;
  forwarded?: boolean;
  file?: InboundFile;
};

type JsonObject = Record<string, unknown>;

const MEDIA_URL_TTL_MS = 5 * 60_000; // "Media URLs expire after 5 minutes"
const WABA_ID = "102000000000001";

export function createEmulator(cfg: EmulatorConfig): Emulator {
  const clock = cfg.clock ?? systemClock;
  const deliverFetch = cfg.fetch ?? globalThis.fetch;
  const business = cfg.displayPhoneNumber ?? "15550000000";
  const media = new Map<string, StoredMedia>();
  const outbox: OutboundRecord[] = [];
  const timeline: ChatEntry[] = [];
  const deliveries = new Map<string, string>(); // inbound wamid -> raw webhook body
  const waiters = new Set<Waiter>();
  const listeners = new Set<(event: ChatEvent) => void>();
  const streamClosers = new Set<() => void>();
  let seq = 0;

  const broadcast = (event: ChatEvent) => {
    for (const listener of listeners) listener(event);
  };

  const pushEntry = (entry: ChatEntry) => {
    timeline.push(entry);
    broadcast({ type: "entry", data: entry });
  };

  const updateEntry = (entry: ChatEntry) => broadcast({ type: "update", data: entry });

  function storeMedia(data: Uint8Array, mime: string, filename?: string): StoredMedia {
    let id: string;
    // 16 digits, like Cloud API media ids.
    do id = `${randomInt(10_000_000, 100_000_000)}${randomInt(10_000_000, 100_000_000)}`;
    while (media.has(id));
    const stored = { id, data, mime, sha256: createHash("sha256").update(data).digest("hex"), filename };
    media.set(id, stored);
    return stored;
  }

  // ---- inbound: the rep's phone -> signed webhook ----

  async function deliver(raw: string): Promise<Response> {
    const url = typeof cfg.webhookUrl === "function" ? cfg.webhookUrl() : cfg.webhookUrl;
    const res = await deliverFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signatureHeader(raw, cfg.appSecret),
      },
      body: raw,
    });
    await res.arrayBuffer().catch(() => undefined);
    return res;
  }

  async function sendInbound(from: string, message: JsonObject, entry: ChatEntry): Promise<string> {
    const raw = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: WABA_ID,
          changes: [
            {
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: business, phone_number_id: cfg.phoneNumberId },
                contacts: [{ profile: { name: `Rep ${from.slice(-4)}` }, wa_id: from }],
                messages: [message],
              },
              field: "messages",
            },
          ],
        },
      ],
    });
    deliveries.set(entry.waId, raw);
    pushEntry(entry);
    let res: Response;
    try {
      res = await deliver(raw);
    } catch (err) {
      entry.failed = `webhook unreachable: ${err instanceof Error ? err.message : String(err)}`;
      updateEntry(entry);
      throw new Error(`emulator: ${entry.failed}`);
    }
    if (!res.ok) {
      entry.failed = `webhook answered HTTP ${res.status}`;
      updateEntry(entry);
      throw new Error(`emulator: ${entry.failed}`);
    }
    return entry.waId;
  }

  async function send(fromRaw: string, input: InboundInput): Promise<string> {
    const from = phoneDigits(fromRaw);
    const waId = wamid(clock);
    const ts = clock.now();
    const message: JsonObject = { from, id: waId, timestamp: String(Math.floor(ts / 1000)) };
    const context: JsonObject = {};
    if (input.replyTo) Object.assign(context, { from: business, id: input.replyTo });
    if (input.forwarded) context.forwarded = true;
    if (Object.keys(context).length > 0) message.context = context;
    const entry: ChatEntry = { seq: ++seq, dir: "in", waId, peer: from, ts, type: "text" };
    if (input.replyTo) entry.replyTo = input.replyTo;
    if (input.forwarded) entry.forwarded = true;

    if (input.file) {
      const kind = inboundKind(input.file);
      const caption = input.caption ?? input.text;
      if (kind === "audio" && caption) {
        throw new Error(
          "emulator: WhatsApp audio messages have no caption; send the text as its own message",
        );
      }
      const voice = kind === "audio" && input.file.voice === true;
      const mime =
        voice && ["audio/ogg", "audio/opus"].includes(baseMime(input.file.mime))
          ? "audio/ogg; codecs=opus"
          : input.file.mime;
      const stored = storeMedia(input.file.data, mime, input.file.filename);
      const payload: JsonObject = {
        mime_type: mime,
        sha256: createHash("sha256").update(input.file.data).digest("base64"),
        id: stored.id,
      };
      if (kind === "audio") payload.voice = voice;
      if (kind === "document")
        payload.filename = input.file.filename ?? `document${extname(input.file.filename ?? "") || ".bin"}`;
      if (caption) payload.caption = caption;
      message.type = kind;
      message[kind] = payload;
      entry.type = kind;
      entry.media = { id: stored.id, mime, bytes: stored.data.byteLength };
      if (kind === "document") entry.media.filename = String(payload.filename);
      if (kind === "audio") entry.media.voice = voice;
      if (caption) entry.caption = caption;
    } else {
      const body = input.text ?? input.caption;
      if (!body) throw new Error("emulator: nothing to send (give text or a file)");
      message.type = "text";
      message.text = { body };
      entry.text = body;
    }
    return sendInbound(from, message, entry);
  }

  async function tap(fromRaw: string, interactiveWaId: string, buttonId: string): Promise<string> {
    const card = outbox.find((r) => r.waId === interactiveWaId && r.type === "interactive");
    if (!card) throw new Error(`emulator: no interactive message ${interactiveWaId} in the outbox`);
    const button = card.buttons?.find((b) => b.id === buttonId);
    if (!button) {
      const ids = card.buttons?.map((b) => b.id).join(", ") ?? "";
      throw new Error(`emulator: message ${interactiveWaId} has no button ${buttonId} (has: ${ids})`);
    }
    const from = phoneDigits(fromRaw);
    const waId = wamid(clock);
    const ts = clock.now();
    const message = {
      context: { from: business, id: interactiveWaId },
      from,
      id: waId,
      timestamp: String(Math.floor(ts / 1000)),
      type: "interactive",
      interactive: { type: "button_reply", button_reply: { id: button.id, title: button.title } },
    };
    const entry: ChatEntry = {
      seq: ++seq,
      dir: "in",
      waId,
      peer: from,
      ts,
      type: "button_reply",
      text: button.title,
      replyTo: interactiveWaId,
    };
    return sendInbound(from, message, entry);
  }

  // ---- outbound: the Graph API the client calls ----

  function recordOutbound(record: OutboundRecord, entry: ChatEntry): void {
    outbox.push(record);
    pushEntry(entry);
    for (const waiter of [...waiters]) {
      let matched = false;
      try {
        matched = waiter.pred(record);
      } catch {
        // a throwing predicate never matches
      }
      if (matched) {
        waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve({ ...record });
      }
    }
  }

  function buildOutbound(
    body: JsonObject,
    to: string,
  ): { record: OutboundRecord; entry: ChatEntry } | { problems: string[] } {
    const waId = wamid(clock);
    const ts = clock.now();
    const entry: ChatEntry = { seq: 0, dir: "out", waId, peer: to, ts, type: "text" };
    const replyTo = str(obj(body.context).message_id);
    if (replyTo) entry.replyTo = replyTo;

    switch (body.type) {
      case "text": {
        const text = str(obj(body.text).body) ?? "";
        const problems = textProblems(text);
        if (problems.length > 0) return { problems };
        entry.text = text;
        return { record: { waId, to, ts, type: "text", body: text }, entry };
      }
      case "interactive": {
        const interactive = obj(body.interactive);
        if (interactive.type !== "button")
          return { problems: ['this emulator supports interactive type "button" only'] };
        const text = str(obj(interactive.body).text) ?? "";
        const rawButtons = Array.isArray(obj(interactive.action).buttons)
          ? (obj(interactive.action).buttons as unknown[])
          : [];
        const buttons: Button[] = rawButtons.map((b) => ({
          id: str(obj(obj(b).reply).id) ?? "",
          title: str(obj(obj(b).reply).title) ?? "",
        }));
        const problems: string[] = [];
        if (rawButtons.some((b) => obj(b).type !== "reply")) problems.push('every button needs type "reply"');
        const header = obj(interactive.header);
        let headerImage: StoredMedia | undefined;
        let headerText: string | undefined;
        if (header.type === "image") {
          const id = str(obj(header.image).id);
          headerImage = id ? media.get(id) : undefined;
          if (!headerImage)
            problems.push(`header image ${id ?? "(no id)"} was not uploaded (send media by id)`);
          else problems.push(...mediaProblems("image", headerImage.mime, headerImage.data.byteLength));
        } else if (header.type === "text") {
          headerText = str(header.text);
        } else if (interactive.header !== undefined) {
          problems.push("this emulator supports image and text headers only");
        }
        const footer = str(obj(interactive.footer).text);
        problems.push(...buttonProblems(text, buttons, { headerText, footer }));
        if (problems.length > 0) return { problems };
        const record: OutboundRecord = { waId, to, ts, type: "interactive", body: text, buttons };
        if (headerImage) record.headerImagePath = artifactPath(headerImage);
        entry.type = "interactive";
        entry.text = text;
        entry.buttons = buttons;
        if (headerImage) entry.header = { type: "image", mediaId: headerImage.id };
        if (headerText) entry.header = { type: "text", text: headerText };
        if (footer) entry.footer = footer;
        return { record, entry };
      }
      case "image":
      case "document": {
        const kind = body.type;
        const payload = obj(body[kind]);
        if (payload.link !== undefined)
          return { problems: ["this emulator supports media by id only (upload first)"] };
        const id = str(payload.id);
        const stored = id ? media.get(id) : undefined;
        if (!stored) return { problems: [`media ${id ?? "(no id)"} was not uploaded`] };
        const caption = str(payload.caption);
        const filename = kind === "document" ? str(payload.filename) : undefined;
        const problems = [
          ...mediaProblems(kind, stored.mime, stored.data.byteLength),
          ...captionProblems(caption),
        ];
        if (problems.length > 0) return { problems };
        const record: OutboundRecord = {
          waId,
          to,
          ts,
          type: kind,
          media: { mime: stored.mime, bytes: stored.data.byteLength, artifactPath: artifactPath(stored) },
        };
        if (caption) record.caption = caption;
        if (filename && record.media) record.media.filename = filename;
        entry.type = kind;
        entry.media = { id: stored.id, mime: stored.mime, bytes: stored.data.byteLength };
        if (filename) entry.media.filename = filename;
        if (caption) entry.caption = caption;
        return { record, entry };
      }
      default:
        return {
          problems: [`type must be one of text, interactive, image, document (got ${String(body.type)})`],
        };
    }
  }

  function markRead(waId: string): boolean {
    const target = timeline.find((e) => e.dir === "in" && e.waId === waId);
    if (!target) return false;
    // "the API also marks earlier messages in the conversation as read"
    for (const entry of timeline) {
      if (entry.dir === "in" && entry.peer === target.peer && entry.seq <= target.seq && !entry.read) {
        entry.read = true;
        updateEntry(entry);
      }
    }
    return true;
  }

  // ---- HTTP ----

  const app = new Hono();
  const VER = ":ver{v[0-9]+[.][0-9]+}";

  const graphError = (c: Context, status: 400 | 401 | 404, code: number, message: string, details?: string) =>
    c.json(
      {
        error: {
          message,
          type: "OAuthException",
          code,
          ...(details ? { error_data: { messaging_product: "whatsapp", details } } : {}),
          fbtrace_id: randomBytes(9).toString("base64url"),
        },
      },
      status,
    );
  const invalidParameter = (c: Context, problems: string[]) =>
    graphError(c, 400, 131009, "(#131009) Parameter value is not valid", problems.join("; "));

  const authorized = (c: Context) => {
    const token = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
    return token !== undefined && (cfg.token === undefined || token === cfg.token);
  };

  /** Auth, version and (when given) phone-number-id checks shared by the Graph routes. */
  const guard = (c: Context, phoneId?: string): Response | undefined => {
    if (!authorized(c))
      return graphError(c, 401, 190, "Invalid OAuth access token - Cannot parse access token");
    const ver = c.req.param("ver");
    if (ver !== cfg.graphVersion) {
      return graphError(
        c,
        400,
        100,
        `Unsupported Graph API version ${ver} (this emulator speaks ${cfg.graphVersion})`,
      );
    }
    if (phoneId !== undefined && phoneId !== cfg.phoneNumberId) {
      return graphError(
        c,
        400,
        100,
        `Unsupported post request. Object with ID '${phoneId}' does not exist, cannot be loaded due to missing permissions, or does not support this operation.`,
      );
    }
    return undefined;
  };

  app.post(`/graph/${VER}/:phoneId/messages`, async (c) => {
    const denied = guard(c, c.req.param("phoneId"));
    if (denied) return denied;
    let body: JsonObject;
    try {
      body = obj(await c.req.json());
    } catch {
      return invalidParameter(c, ["request body is not valid JSON"]);
    }
    if (body.messaging_product !== "whatsapp") {
      return graphError(c, 400, 100, "(#100) The parameter messaging_product is required.");
    }
    if (body.status === "read") {
      const waId = str(body.message_id);
      if (!waId || !markRead(waId))
        return invalidParameter(c, [`message_id ${waId ?? "(none)"} is not an inbound message`]);
      return c.json({ success: true });
    }
    const to = phoneDigits(str(body.to) ?? "");
    if (!/^\d{6,15}$/.test(to)) return graphError(c, 400, 100, "(#100) The parameter to is required.");
    const built = buildOutbound(body, to);
    if ("problems" in built) return invalidParameter(c, built.problems);
    built.entry.seq = ++seq;
    recordOutbound(built.record, built.entry);
    return c.json({
      messaging_product: "whatsapp",
      contacts: [{ input: str(body.to), wa_id: to }],
      messages: [{ id: built.record.waId }],
    });
  });

  app.post(`/graph/${VER}/:phoneId/media`, async (c) => {
    const denied = guard(c, c.req.param("phoneId"));
    if (denied) return denied;
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return invalidParameter(c, ["expected multipart/form-data"]);
    }
    if (form.get("messaging_product") !== "whatsapp") {
      return graphError(c, 400, 100, "(#100) The parameter messaging_product is required.");
    }
    const file = form.get("file");
    if (!(file instanceof Blob)) return graphError(c, 400, 100, "(#100) The parameter file is required.");
    const typeField = form.get("type");
    const mime = (typeof typeField === "string" && typeField) || file.type;
    const type = mediaTypeFor(mime);
    if (!type) return invalidParameter(c, [`media type ${mime || "(none)"} is not supported`]);
    if (file.size > type.maxBytes)
      return invalidParameter(c, [`file is ${file.size} bytes (${type.kind} max ${type.maxBytes})`]);
    const name = file instanceof File && file.name ? file.name : undefined;
    const stored = storeMedia(new Uint8Array(await file.arrayBuffer()), mime, name);
    return c.json({ id: stored.id });
  });

  app.get(`/graph/${VER}/:mediaId`, (c) => {
    const denied = guard(c);
    if (denied) return denied;
    const id = c.req.param("mediaId");
    const stored = media.get(id);
    if (!stored) {
      return graphError(
        c,
        400,
        100,
        `Unsupported get request. Object with ID '${id}' does not exist, cannot be loaded due to missing permissions, or does not support this operation.`,
      );
    }
    const phoneNumberId = c.req.query("phone_number_id");
    if (phoneNumberId && phoneNumberId !== cfg.phoneNumberId) {
      return invalidParameter(c, [`media ${id} does not belong to phone number ${phoneNumberId}`]);
    }
    const url = new URL(c.req.url);
    const mountPrefix = url.pathname.slice(0, url.pathname.lastIndexOf("/graph/"));
    const expires = clock.now() + MEDIA_URL_TTL_MS;
    return c.json({
      messaging_product: "whatsapp",
      url: `${url.origin}${mountPrefix}/lookaside/${id}?expires=${expires}`,
      mime_type: stored.mime,
      sha256: stored.sha256,
      file_size: stored.data.byteLength,
      id,
    });
  });

  // The short-lived download URL: bearer token required, 404 once expired (the client then looks the id up again).
  app.get("/lookaside/:mediaId", (c) => {
    if (!authorized(c)) return c.text("Unauthorized", 401);
    const stored = media.get(c.req.param("mediaId"));
    const expires = Number(c.req.query("expires"));
    if (!stored || !Number.isFinite(expires) || clock.now() > expires) return c.text("Not Found", 404);
    return c.body(toArrayBuffer(stored.data), 200, { "content-type": stored.mime });
  });

  // ---- /dev/chat ----

  app.get("/dev/chat", (c) =>
    c.html(chatPage({ base: c.req.path.replace(/\/+$/, ""), defaultFrom: cfg.defaultFrom ?? "", business })),
  );

  app.get("/dev/chat/timeline", (c) => c.json({ entries: timeline }));

  app.get("/dev/chat/media/:mediaId", (c) => {
    const stored = media.get(c.req.param("mediaId"));
    if (!stored) return c.text("Not Found", 404);
    const headers: Record<string, string> = { "content-type": stored.mime, "cache-control": "no-store" };
    if (stored.filename)
      headers["content-disposition"] = `inline; filename*=UTF-8''${encodeURIComponent(stored.filename)}`;
    return c.body(toArrayBuffer(stored.data), 200, headers);
  });

  app.get("/dev/chat/events", (c) =>
    streamSSE(c, async (stream) => {
      const write = (event: ChatEvent) =>
        void stream.writeSSE({ event: event.type, data: JSON.stringify(event.data) });
      write({ type: "snapshot", data: { entries: timeline } });
      await new Promise<void>((resolve) => {
        const ping = setInterval(() => void stream.writeSSE({ event: "ping", data: "" }), 15_000);
        const done = () => {
          clearInterval(ping);
          listeners.delete(write);
          streamClosers.delete(done);
          resolve();
        };
        listeners.add(write);
        streamClosers.add(done);
        stream.onAbort(done);
      });
    }),
  );

  app.post("/dev/chat/send", async (c) => {
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ error: "expected multipart/form-data" }, 400);
    }
    const from = phoneDigits(String(form.get("from") ?? "").trim());
    if (!/^\d{6,15}$/.test(from))
      return c.json({ error: "From must be a phone number (digits, E.164)" }, 400);
    const text = String(form.get("text") ?? "").trim() || undefined;
    const replyTo = String(form.get("replyTo") ?? "").trim() || undefined;
    const forwarded = isChecked(form.get("forwarded"));
    const file = form.get("file");
    try {
      const waIds: string[] = [];
      if (file instanceof Blob && file.size > 0) {
        const filename = file instanceof File && file.name ? file.name : undefined;
        const mime = file.type || mimeFromName(filename);
        const isAudio = baseMime(mime).startsWith("audio/") && !isChecked(form.get("asDocument"));
        const data = new Uint8Array(await file.arrayBuffer());
        const fileInput: InboundFile = {
          data,
          mime,
          filename,
          voice: isChecked(form.get("voice")),
          asDocument: isChecked(form.get("asDocument")),
        };
        waIds.push(
          await send(from, { caption: isAudio ? undefined : text, replyTo, forwarded, file: fileInput }),
        );
        if (isAudio && text) waIds.push(await send(from, { text }));
      } else if (text) {
        waIds.push(await send(from, { text, replyTo, forwarded }));
      } else {
        return c.json({ error: "Type a message or attach a file" }, 400);
      }
      return c.json({ waIds });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  app.post("/dev/chat/tap", async (c) => {
    let body: JsonObject;
    try {
      body = obj(await c.req.json());
    } catch {
      return c.json({ error: "expected JSON" }, 400);
    }
    try {
      const waId = await tap(str(body.from) ?? "", str(body.waId) ?? "", str(body.buttonId) ?? "");
      return c.json({ waId });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/dev/chat/reset", (c) => {
    control.reset();
    return c.json({ ok: true });
  });

  // ---- control surface ----

  const control: EmulatorControl = {
    async send(from, msg) {
      const file = msg.file
        ? {
            data: new Uint8Array(await readFile(msg.file.path)),
            mime: msg.file.mime,
            filename: msg.file.filename ?? basename(msg.file.path),
            voice: msg.file.voice,
            asDocument: msg.file.asDocument,
          }
        : undefined;
      return send(from, {
        text: msg.text,
        caption: msg.caption,
        replyTo: msg.replyTo,
        forwarded: msg.forwarded,
        file,
      });
    },
    tap,
    outbox: (to) => outbox.filter((r) => to === undefined || r.to === phoneDigits(to)).map((r) => ({ ...r })),
    waitFor(pred, timeoutMs = 5_000) {
      const existing = outbox.find((r) => {
        try {
          return pred(r);
        } catch {
          return false;
        }
      });
      if (existing) return Promise.resolve({ ...existing });
      return new Promise<OutboundRecord>((resolve, reject) => {
        const waiter: Waiter = {
          pred,
          resolve,
          reject,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            const seen = outbox
              .map((r) => `${r.type}:${(r.body ?? r.caption ?? "").slice(0, 40)}`)
              .join(" | ");
            reject(new Error(`emulator.waitFor timed out after ${timeoutMs} ms; outbox: [${seen}]`));
          }, timeoutMs),
        };
        waiters.add(waiter);
      });
    },
    reset() {
      outbox.length = 0;
      timeline.length = 0;
      media.clear();
      deliveries.clear();
      broadcast({ type: "snapshot", data: { entries: [] } });
    },
  };

  return {
    app,
    control,
    async redeliver(waId) {
      const raw = deliveries.get(waId);
      if (!raw) throw new Error(`emulator: no delivered webhook for ${waId}`);
      return (await deliver(raw)).status;
    },
    close() {
      for (const done of [...streamClosers]) done();
      for (const waiter of [...waiters]) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("emulator closed"));
      }
      waiters.clear();
    },
  };
}

/** Inbound message type for a file, as WhatsApp classifies it (documents keep their quality). */
function inboundKind(file: InboundFile): "audio" | "image" | "video" | "document" {
  if (file.asDocument) return "document";
  const mime = baseMime(file.mime);
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "image/jpeg" || mime === "image/png" || mime === "image/webp") return "image";
  if (mime.startsWith("video/")) return "video";
  return "document";
}

// Mirrors @dockhand/core's content-addressed layout (artifacts/ab/<sha256>.<ext>), so OutboundRecord paths
// equal the ArtifactRef.relPath of the bytes that were sent.
const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/amr": "amr",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
};

function artifactPath(m: StoredMedia): string {
  return `artifacts/${m.sha256.slice(0, 2)}/${m.sha256}.${EXTENSIONS[baseMime(m.mime)] ?? "bin"}`;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
};

function mimeFromName(filename: string | undefined): string {
  return MIME_BY_EXTENSION[extname(filename ?? "").toLowerCase()] ?? "application/octet-stream";
}

function wamid(clock: Clock): string {
  return `wamid.${Buffer.from(`HBgL${ulid(clock)}`).toString("base64")}`;
}

function phoneDigits(value: string): string {
  return value.replace(/^\+/, "");
}

function obj(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function isChecked(value: FormDataEntryValue | null): boolean {
  return value === "on" || value === "true" || value === "1";
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

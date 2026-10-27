import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixedClock, createMemoryArtifactStore, DockhandError } from "@dockhand/core";
import { afterAll, describe, expect, it } from "vitest";
import { createWhatsAppClient } from "./client.ts";
import { createWorld, dig, OGG, PDF, PHONE_ID, PNG, REP, TOKEN, VERSION } from "./test-helpers.ts";
import { parseWebhook } from "./webhook.ts";

const dir = mkdtempSync(join(tmpdir(), "dockhand-wa-client-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function expectToolError(promise: Promise<unknown>, pattern: RegExp): Promise<DockhandError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DockhandError);
  expect((err as DockhandError).code).toBe("TOOL_ERROR");
  expect((err as DockhandError).message).toMatch(pattern);
  return err as DockhandError;
}

describe("createWhatsAppClient request shapes", () => {
  it("sends text with bearer auth, optionally as a reply", async () => {
    const w = createWorld();
    const waId = await w.client.sendText(REP, "Olá! Segue a proposta.");
    const reply = await w.client.sendText(`+${REP}`, "Pronto", { replyTo: "wamid.IN1" });

    expect(waId).toMatch(/^wamid\./);
    expect(w.requests[0]).toEqual({
      method: "POST",
      url: `http://emulator.test/graph/${VERSION}/${PHONE_ID}/messages`,
      authorization: `Bearer ${TOKEN}`,
      json: {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: REP,
        type: "text",
        text: { preview_url: false, body: "Olá! Segue a proposta." },
      },
    });
    expect(w.requests[1]?.json).toMatchObject({ to: REP, context: { message_id: "wamid.IN1" } });
    expect(w.control.outbox(REP)).toEqual([
      { waId, to: REP, ts: w.clock.now(), type: "text", body: "Olá! Segue a proposta." },
      { waId: reply, to: REP, ts: w.clock.now(), type: "text", body: "Pronto" },
    ]);
  });

  it("sends reply buttons with text header and footer", async () => {
    const w = createWorld();
    const buttons = [
      { id: "g:01GATE:a", title: "Approve" },
      { id: "g:01GATE:e", title: "Edit" },
      { id: "g:01GATE:r", title: "Cancel" },
    ];
    const waId = await w.client.sendButtons(REP, "Criar deal Acme Group (25 seats)?", buttons, {
      headerText: "Plan",
      footer: "Dockhand",
    });
    expect(w.requests[0]?.json).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: REP,
      type: "interactive",
      interactive: {
        type: "button",
        header: { type: "text", text: "Plan" },
        body: { text: "Criar deal Acme Group (25 seats)?" },
        footer: { text: "Dockhand" },
        action: { buttons: buttons.map((b) => ({ type: "reply", reply: b })) },
      },
    });
    expect(w.control.outbox()[0]).toMatchObject({
      waId,
      type: "interactive",
      body: "Criar deal Acme Group (25 seats)?",
      buttons,
    });
  });

  it("uploads a header image as multipart and references it by id", async () => {
    const w = createWorld();
    const shot = await w.artifacts.put(PNG, "image/png", { kind: "screenshot" });
    await w.client.sendButtons(REP, "Submit this registration?", [{ id: "g:1:a", title: "Approve" }], {
      headerImage: shot,
      headerText: "ignored when an image is given",
    });
    const [upload, message] = w.requests;
    expect(upload?.url).toBe(`http://emulator.test/graph/${VERSION}/${PHONE_ID}/media`);
    expect(upload?.form).toEqual({
      messaging_product: "whatsapp",
      type: "image/png",
      file: { name: `${shot.sha256}.png`, type: "image/png", size: PNG.byteLength },
    });
    expect(dig(message?.json, "interactive", "header", "type")).toBe("image");
    expect(dig(message?.json, "interactive", "header", "image", "id")).toMatch(/^\d{16}$/);
    expect(w.control.outbox()[0]?.headerImagePath).toBe(shot.relPath);
  });

  it("sends images and documents by uploaded media id", async () => {
    const w = createWorld();
    const image = await w.artifacts.put(PNG, "image/png", { kind: "receipt" });
    const quote = await w.artifacts.put(PDF, "application/pdf", { kind: "quote_pdf" });
    await w.client.sendImage(REP, image, "Registro CRV-2026-0042 concluído");
    await w.client.sendDocument(REP, quote, "Proposta Tidewater Cloud.pdf", "Proposta para Acme Group");

    const messages = w.requests.filter((r) => r.url.endsWith("/messages"));
    expect(messages[0]?.json).toMatchObject({
      type: "image",
      image: { id: expect.stringMatching(/^\d{16}$/), caption: "Registro CRV-2026-0042 concluído" },
    });
    expect(messages[1]?.json).toMatchObject({
      type: "document",
      document: { filename: "Proposta Tidewater Cloud.pdf", caption: "Proposta para Acme Group" },
    });
    expect(w.control.outbox()).toMatchObject([
      {
        type: "image",
        caption: "Registro CRV-2026-0042 concluído",
        media: { mime: "image/png", bytes: PNG.byteLength, artifactPath: image.relPath },
      },
      {
        type: "document",
        caption: "Proposta para Acme Group",
        media: {
          mime: "application/pdf",
          filename: "Proposta Tidewater Cloud.pdf",
          artifactPath: quote.relPath,
        },
      },
    ]);
  });

  it("marks an inbound message as read", async () => {
    const w = createWorld();
    const first = await w.control.send(REP, { text: "um" });
    const second = await w.control.send(REP, { text: "dois" });
    await w.client.markRead(second);
    expect(w.requests[0]?.json).toEqual({
      messaging_product: "whatsapp",
      status: "read",
      message_id: second,
    });
    const res = await w.emulator.app.request("/dev/chat/timeline");
    const { entries } = (await res.json()) as { entries: { waId: string; read?: boolean }[] };
    expect(entries.filter((e) => e.read).map((e) => e.waId)).toEqual([first, second]);
  });
});

describe("createWhatsAppClient limits", () => {
  const ok = { id: "g:1:a", title: "Approve" };

  it("rejects bad interactive messages before any request", async () => {
    const w = createWorld();
    const four = [1, 2, 3, 4].map((n) => ({ id: `g:1:${n}`, title: `Option ${n}` }));
    const cases: [string, () => Promise<unknown>, RegExp][] = [
      ["4 buttons", () => w.client.sendButtons(REP, "body", four), /4 buttons \(allowed: 1 to 3\)/],
      ["no buttons", () => w.client.sendButtons(REP, "body", []), /0 buttons/],
      [
        "long title",
        () => w.client.sendButtons(REP, "body", [{ id: "x", title: "Approve and submit it" }]),
        /has 21 characters/,
      ],
      [
        "long body",
        () => w.client.sendButtons(REP, "x".repeat(1025), [ok]),
        /body has 1025 characters \(max 1024\)/,
      ],
      [
        "long id",
        () => w.client.sendButtons(REP, "body", [{ id: "g".repeat(257), title: "Ok" }]),
        /button id has 257/,
      ],
      [
        "dup titles",
        () => w.client.sendButtons(REP, "body", [ok, { id: "g:1:b", title: "Approve" }]),
        /titles must be unique/,
      ],
      [
        "long footer",
        () => w.client.sendButtons(REP, "body", [ok], { footer: "f".repeat(61) }),
        /footer has 61/,
      ],
      ["empty text", () => w.client.sendText(REP, "   "), /text body is empty/],
      ["long text", () => w.client.sendText(REP, "x".repeat(4097)), /4097 characters \(max 4096\)/],
    ];
    for (const [, run, pattern] of cases) await expectToolError(run(), pattern);
    expect(w.requests).toEqual([]);
  });

  it("counts characters, not UTF-16 units, for titles", async () => {
    const w = createWorld();
    const title = `Aprovar ${"\u{1F44D}".repeat(7)}`; // 15 characters, 22 UTF-16 units
    expect(title.length).toBe(22);
    await w.client.sendButtons(REP, "Tudo certo?", [{ id: "g:1:a", title }]);
    expect(w.control.outbox()).toHaveLength(1);
  });

  it("rejects unsupported or oversized media before uploading", async () => {
    const w = createWorld();
    const webp = await w.artifacts.put(new Uint8Array([1, 2, 3]), "image/webp", { kind: "screenshot" });
    const ts = await w.artifacts.put(new TextEncoder().encode("export {}"), "text/typescript", {
      kind: "skill_export",
    });
    const huge = {
      ...(await w.artifacts.put(PNG, "image/png", { kind: "screenshot" })),
      bytes: 6 * 1024 * 1024,
    };
    await expectToolError(w.client.sendImage(REP, webp), /image MIME type image\/webp is not supported/);
    await expectToolError(w.client.sendDocument(REP, ts, "skill.ts"), /document MIME type text\/typescript/);
    await expectToolError(w.client.sendImage(REP, huge), /image is 6291456 bytes \(max 5242880\)/);
    await expectToolError(w.client.sendImage(REP, webp, "c".repeat(1025)), /caption has 1025 characters/);
    expect(w.requests).toEqual([]);
  });
});

describe("createWhatsAppClient errors", () => {
  it("maps Graph errors to TOOL_ERROR with the Graph message and never echoes the token", async () => {
    const w = createWorld({ token: "wrong-token-SECRET" });
    const err = await expectToolError(w.client.sendText(REP, "oi"), /HTTP 401.*Invalid OAuth access token/);
    expect(err.detail).toMatchObject({ status: 401, code: 190, type: "OAuthException" });
    expect(err.message).not.toContain("SECRET");
  });

  it("includes Graph error details", async () => {
    const w = createWorld();
    const res = await w.graphFetch(`http://emulator.test/graph/${VERSION}/${PHONE_ID}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: REP, type: "sticker", sticker: { id: "1" } }),
    });
    expect(res.status).toBe(400);
    const client = createWhatsAppClient({
      baseUrl: "http://emulator.test/graph",
      graphVersion: VERSION,
      token: TOKEN,
      phoneNumberId: "999",
      artifacts: w.artifacts,
      fetch: w.graphFetch,
    });
    await expectToolError(client.sendText(REP, "oi"), /HTTP 400.*Object with ID '999' does not exist/);
    const wrongVersion = createWhatsAppClient({
      baseUrl: "http://emulator.test/graph",
      graphVersion: "v19.0",
      token: TOKEN,
      phoneNumberId: PHONE_ID,
      artifacts: w.artifacts,
      fetch: w.graphFetch,
    });
    await expectToolError(wrongVersion.sendText(REP, "oi"), /Unsupported Graph API version v19\.0/);
  });

  it("reports network failures as TOOL_ERROR", async () => {
    const client = createWhatsAppClient({
      baseUrl: "http://emulator.test/graph",
      graphVersion: VERSION,
      token: TOKEN,
      phoneNumberId: PHONE_ID,
      artifacts: createMemoryArtifactStore(),
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expectToolError(
      client.sendText(REP, "oi"),
      /send text: request failed \(TypeError: fetch failed\)/,
    );
  });
});

describe("media round trip", () => {
  it("downloads inbound media: webhook media id -> Graph lookup -> short-lived URL with bearer", async () => {
    const w = createWorld();
    const path = join(dir, "nota.ogg");
    writeFileSync(path, OGG);
    await w.control.send(REP, { file: { path, mime: "audio/ogg", voice: true } });

    const [message] = parseWebhook(w.webhooks[0]?.body).messages;
    expect(message?.media).toMatchObject({ mime: "audio/ogg; codecs=opus", voice: true });
    const media = await w.client.downloadMedia(message?.media?.mediaId ?? "");
    expect(media).toEqual({ data: OGG, mime: "audio/ogg; codecs=opus" });

    const [lookup, download] = w.requests;
    expect(lookup?.url).toBe(
      `http://emulator.test/graph/${VERSION}/${message?.media?.mediaId}?phone_number_id=${PHONE_ID}`,
    );
    expect(download?.url).toMatch(/^http:\/\/emulator\.test\/lookaside\/\d{16}\?expires=\d+$/);
    expect(download?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("uploads, sends and downloads the same bytes back", async () => {
    const w = createWorld();
    const receipt = await w.artifacts.put(PNG, "image/png", { kind: "receipt" });
    await w.client.sendImage(REP, receipt);
    const sentId = String(dig(w.requests[1]?.json, "image", "id"));
    expect(await w.client.downloadMedia(sentId)).toEqual({ data: PNG, mime: "image/png" });
  });

  it("expires download URLs after 5 minutes and retries once with a fresh URL", async () => {
    const clock = createFixedClock(Date.UTC(2026, 9, 27, 12));
    const w = createWorld({ clock });
    const image = await w.artifacts.put(PNG, "image/png", { kind: "receipt" });
    await w.client.sendImage(REP, image);
    const mediaId = String(dig(w.requests[1]?.json, "image", "id"));

    const lookup = await w.graphFetch(`http://emulator.test/graph/${VERSION}/${mediaId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const { url } = (await lookup.json()) as { url: string };
    const auth = { headers: { authorization: `Bearer ${TOKEN}` } };
    expect((await w.graphFetch(url, auth)).status).toBe(200);
    expect((await w.graphFetch(url, {})).status).toBe(401);
    clock.advance(5 * 60_000 + 1);
    expect((await w.graphFetch(url, auth)).status).toBe(404);

    // A URL that expires between lookup and download: the client looks the media up again once.
    let lookups = 0;
    const client = createWhatsAppClient({
      baseUrl: "http://emulator.test/graph",
      graphVersion: VERSION,
      token: TOKEN,
      phoneNumberId: PHONE_ID,
      artifacts: w.artifacts,
      fetch: async (input, init) => {
        const target = String(input instanceof Request ? input.url : input);
        if (target.includes("/graph/")) {
          lookups++;
          const res = await w.graphFetch(input, init);
          if (lookups === 1) clock.advance(5 * 60_000 + 1);
          return res;
        }
        return w.graphFetch(input, init);
      },
    });
    expect(await client.downloadMedia(mediaId)).toEqual({ data: PNG, mime: "image/png" });
    expect(lookups).toBe(2);
  });

  it("fails clearly for an unknown media id", async () => {
    const w = createWorld();
    await expectToolError(w.client.downloadMedia("1234567890123456"), /media lookup failed \(HTTP 400\)/);
  });
});

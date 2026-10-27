import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  createWorld,
  dig,
  MP4,
  OGG,
  PDF,
  PHONE_ID,
  PNG,
  REP,
  SECRET,
  TOKEN,
  VERSION,
} from "./test-helpers.ts";
import { parseWebhook, verifySignature } from "./webhook.ts";

const dir = mkdtempSync(join(tmpdir(), "dockhand-wa-emulator-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const file = (name: string, data: Uint8Array) => {
  const path = join(dir, name);
  writeFileSync(path, data);
  return path;
};

describe("EmulatorControl.send", () => {
  it("delivers a signed Cloud API payload that parses back to the message", async () => {
    const w = createWorld();
    const waId = await w.control.send(REP, { text: "Oi, preciso de uma cotação" });
    const hook = w.webhooks[0];
    expect(verifySignature(new TextEncoder().encode(hook?.raw), hook?.signature ?? undefined, SECRET)).toBe(
      true,
    );
    expect(hook?.body).toMatchObject({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { phone_number_id: PHONE_ID },
                contacts: [{ wa_id: REP }],
              },
            },
          ],
        },
      ],
    });
    expect(parseWebhook(hook?.body)).toEqual({
      messages: [
        {
          waId,
          from: REP,
          ts: Math.floor(w.clock.now() / 1000) * 1000,
          kind: "text",
          text: "Oi, preciso de uma cotação",
        },
      ],
      ignored: 0,
    });
  });

  it("builds every media kind like WhatsApp does", async () => {
    const w = createWorld();
    await w.control.send(REP, { file: { path: file("nota.ogg", OGG), mime: "audio/ogg", voice: true } });
    await w.control.send(REP, {
      caption: "Formulário",
      forwarded: true,
      file: { path: file("form.png", PNG), mime: "image/png" },
    });
    await w.control.send(REP, {
      text: "Pedido da Acme",
      file: { path: file("acme.pdf", PDF), mime: "application/pdf" },
    });
    await w.control.send(REP, { file: { path: file("teach.mp4", MP4), mime: "video/mp4" } });
    await w.control.send(REP, {
      replyTo: "wamid.CARD",
      file: { path: file("teach2.mp4", MP4), mime: "video/mp4", asDocument: true, filename: "registro.mp4" },
    });

    const parsed = w.webhooks.map((h) => parseWebhook(h.body).messages[0]);
    expect(parsed.map((m) => m?.kind)).toEqual(["audio", "image", "document", "video", "document"]);
    expect(parsed[0]?.media).toMatchObject({ mime: "audio/ogg; codecs=opus", voice: true });
    expect(parsed[1]).toMatchObject({ text: "Formulário", forwarded: true, media: { mime: "image/png" } });
    expect(parsed[2]).toMatchObject({
      text: "Pedido da Acme",
      media: { mime: "application/pdf", filename: "acme.pdf" },
    });
    expect(parsed[3]?.media?.mime).toBe("video/mp4");
    expect(parsed[4]).toMatchObject({
      replyTo: "wamid.CARD",
      media: { mime: "video/mp4", filename: "registro.mp4" },
    });
    const sha256 = dig(
      w.webhooks[0]?.body,
      "entry",
      0,
      "changes",
      0,
      "value",
      "messages",
      0,
      "audio",
      "sha256",
    );
    expect(sha256).toMatch(/^[A-Za-z0-9+/]+=*$/); // base64, as in Meta's examples
  });

  it("refuses an audio caption and an empty message", async () => {
    const w = createWorld();
    await expect(
      w.control.send(REP, { text: "oi", file: { path: file("n.ogg", OGG), mime: "audio/ogg" } }),
    ).rejects.toThrow(/audio messages have no caption/);
    await expect(w.control.send(REP, {})).rejects.toThrow(/nothing to send/);
    expect(w.webhooks).toEqual([]);
  });

  it("throws and marks the entry when the webhook does not answer 2xx", async () => {
    const w = createWorld({ webhookStatus: 401 });
    await expect(w.control.send(REP, { text: "oi" })).rejects.toThrow(/webhook answered HTTP 401/);
    const res = await w.emulator.app.request("/dev/chat/timeline");
    expect(((await res.json()) as { entries: { failed?: string }[] }).entries[0]?.failed).toBe(
      "webhook answered HTTP 401",
    );
  });

  it("redelivers the identical signed payload, as Meta retries do", async () => {
    const w = createWorld();
    const waId = await w.control.send(REP, { text: "oi" });
    expect(await w.emulator.redeliver(waId)).toBe(200);
    expect(w.webhooks[1]?.raw).toBe(w.webhooks[0]?.raw);
    expect(w.webhooks[1]?.signature).toBe(w.webhooks[0]?.signature);
    await expect(w.emulator.redeliver("wamid.nope")).rejects.toThrow(/no delivered webhook/);
  });
});

describe("EmulatorControl.tap, outbox, waitFor, reset", () => {
  it("taps a button on an interactive message", async () => {
    const w = createWorld();
    const card = await w.client.sendButtons(REP, "Aprovar?", [
      { id: "g:G1:a", title: "Approve" },
      { id: "g:G1:r", title: "Cancel" },
    ]);
    const tapId = await w.control.tap(REP, card, "g:G1:a");
    expect(parseWebhook(w.webhooks[0]?.body).messages).toEqual([
      {
        waId: tapId,
        from: REP,
        ts: expect.any(Number),
        kind: "button",
        button: { id: "g:G1:a", title: "Approve" },
        replyTo: card,
      },
    ]);
    await expect(w.control.tap(REP, card, "g:G1:x")).rejects.toThrow(
      /has no button g:G1:x \(has: g:G1:a, g:G1:r\)/,
    );
    await expect(w.control.tap(REP, "wamid.missing", "g:G1:a")).rejects.toThrow(/no interactive message/);
  });

  it("filters the outbox by recipient and returns copies", async () => {
    const w = createWorld();
    await w.client.sendText(REP, "para a Ana");
    await w.client.sendText("5521988880000", "para o Bruno");
    expect(w.control.outbox().map((r) => r.body)).toEqual(["para a Ana", "para o Bruno"]);
    expect(w.control.outbox(`+${REP}`).map((r) => r.body)).toEqual(["para a Ana"]);
    const copy = w.control.outbox()[0];
    if (copy) copy.body = "changed";
    expect(w.control.outbox()[0]?.body).toBe("para a Ana");
  });

  it("waitFor resolves with an existing or a future record, and times out with the outbox listed", async () => {
    const w = createWorld();
    await w.client.sendText(REP, "primeira");
    expect((await w.control.waitFor((m) => m.body === "primeira")).body).toBe("primeira");
    const later = w.control.waitFor((m) => m.body === "segunda", 1_000);
    await w.client.sendText(REP, "segunda");
    expect((await later).body).toBe("segunda");
    await expect(w.control.waitFor((m) => m.body === "never", 20)).rejects.toThrow(
      /timed out after 20 ms; outbox: \[text:primeira \| text:segunda\]/,
    );
  });

  it("reset clears the outbox, the timeline and stored media", async () => {
    const w = createWorld();
    const image = await w.artifacts.put(PNG, "image/png", { kind: "receipt" });
    await w.client.sendImage(REP, image);
    const mediaId = String(dig(w.requests[1]?.json, "image", "id"));
    w.control.reset();
    expect(w.control.outbox()).toEqual([]);
    const timeline = await (await w.emulator.app.request("/dev/chat/timeline")).json();
    expect(timeline).toEqual({ entries: [] });
    await expect(w.client.downloadMedia(mediaId)).rejects.toThrow(/HTTP 400/);
  });

  it("close() rejects pending waitFor calls", async () => {
    const w = createWorld();
    const pending = w.control.waitFor(() => false, 60_000);
    w.emulator.close();
    await expect(pending).rejects.toThrow("emulator closed");
  });
});

describe("fake Graph API", () => {
  const post = (w: ReturnType<typeof createWorld>, path: string, body: unknown, token = TOKEN) =>
    w.emulator.app.request(`http://emulator.test/graph/${VERSION}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("answers like Graph for auth, path and payload errors", async () => {
    const w = createWorld();
    const text = { messaging_product: "whatsapp", to: REP, type: "text", text: { body: "oi" } };
    expect((await post(w, `/${PHONE_ID}/messages`, text, "bad")).status).toBe(401);
    const noAuth = await w.emulator.app.request(`/graph/${VERSION}/${PHONE_ID}/messages`, { method: "POST" });
    expect(await noAuth.json()).toMatchObject({ error: { code: 190, type: "OAuthException" } });

    const missingProduct = await post(w, `/${PHONE_ID}/messages`, {
      to: REP,
      type: "text",
      text: { body: "oi" },
    });
    expect(await missingProduct.json()).toMatchObject({
      error: { message: "(#100) The parameter messaging_product is required." },
    });

    const sticker = await post(w, `/${PHONE_ID}/messages`, {
      messaging_product: "whatsapp",
      to: REP,
      type: "sticker",
    });
    expect(sticker.status).toBe(400);
    expect(await sticker.json()).toMatchObject({
      error: { code: 131009, error_data: { details: expect.stringContaining("type must be one of") } },
    });

    const fourButtons = await post(w, `/${PHONE_ID}/messages`, {
      messaging_product: "whatsapp",
      to: REP,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: "x" },
        action: {
          buttons: [1, 2, 3, 4].map((n) => ({ type: "reply", reply: { id: `b${n}`, title: `B${n}` } })),
        },
      },
    });
    expect(await fourButtons.json()).toMatchObject({
      error: { error_data: { details: "4 buttons (allowed: 1 to 3)" } },
    });

    const byLink = await post(w, `/${PHONE_ID}/messages`, {
      messaging_product: "whatsapp",
      to: REP,
      type: "image",
      image: { link: "https://example.com/a.png" },
    });
    expect(await byLink.json()).toMatchObject({
      error: { error_data: { details: expect.stringContaining("by id only") } },
    });

    const badJson = await w.emulator.app.request(`/graph/${VERSION}/${PHONE_ID}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: "{",
    });
    expect(badJson.status).toBe(400);
    expect(w.control.outbox()).toEqual([]);
  });

  it("validates uploads by media type and size", async () => {
    const w = createWorld();
    const upload = (blob: Blob, type?: string) => {
      const form = new FormData();
      form.append("messaging_product", "whatsapp");
      if (type) form.append("type", type);
      form.append("file", blob, "f");
      return w.emulator.app.request(`/graph/${VERSION}/${PHONE_ID}/media`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: form,
      });
    };
    expect((await upload(new Blob([PNG], { type: "image/png" }))).status).toBe(200);
    const gif = await upload(new Blob([PNG], { type: "image/gif" }));
    expect(await gif.json()).toMatchObject({
      error: { error_data: { details: "media type image/gif is not supported" } },
    });
    const big = await upload(new Blob([new Uint8Array(5 * 1024 * 1024 + 1)]), "image/jpeg");
    expect(await big.json()).toMatchObject({
      error: { error_data: { details: expect.stringContaining("image max 5242880") } },
    });
  });

  it("serves media metadata only for known ids and matching phone numbers", async () => {
    const w = createWorld();
    const image = await w.artifacts.put(PNG, "image/png", { kind: "receipt" });
    await w.client.sendImage(REP, image);
    const mediaId = String(dig(w.requests[1]?.json, "image", "id"));
    const get = (path: string) =>
      w.emulator.app.request(`http://emulator.test/graph/${VERSION}/${path}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
    expect(await (await get(mediaId)).json()).toMatchObject({
      messaging_product: "whatsapp",
      mime_type: "image/png",
      sha256: image.sha256,
      file_size: PNG.byteLength,
      id: mediaId,
      url: expect.stringMatching(/^http:\/\/emulator\.test\/lookaside\//),
    });
    expect((await get(`${mediaId}?phone_number_id=999`)).status).toBe(400);
    expect((await get("1111222233334444")).status).toBe(400);
  });
});

describe("/dev/chat", () => {
  it("serves the page with its base path and the default sender", async () => {
    const w = createWorld();
    const res = await w.emulator.app.request("/dev/chat");
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain('"base":"/dev/chat"');
    expect(html).toContain("EventSource");
  });

  it("sends text and files from the composer and taps buttons", async () => {
    const w = createWorld();
    const form = new FormData();
    form.append("from", `+${REP}`);
    form.append("text", "segue a nota");
    form.append("voice", "on");
    form.append("file", new Blob([OGG], { type: "audio/ogg" }), "nota.ogg");
    const sent = await w.emulator.app.request("/dev/chat/send", { method: "POST", body: form });
    expect(sent.status).toBe(200);
    const { waIds } = (await sent.json()) as { waIds: string[] };
    expect(waIds).toHaveLength(2); // the voice note, then the text as its own message
    expect(w.webhooks.map((h) => parseWebhook(h.body).messages[0]?.kind)).toEqual(["audio", "text"]);

    const card = await w.client.sendButtons(REP, "Aprovar?", [{ id: "g:G2:a", title: "Approve" }]);
    const tapped = await w.emulator.app.request("/dev/chat/tap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: REP, waId: card, buttonId: "g:G2:a" }),
    });
    expect(tapped.status).toBe(200);
    expect(parseWebhook(w.webhooks[2]?.body).messages[0]).toMatchObject({ kind: "button", replyTo: card });

    const bad = new FormData();
    bad.append("from", "abc");
    bad.append("text", "x");
    expect((await w.emulator.app.request("/dev/chat/send", { method: "POST", body: bad })).status).toBe(400);
  });

  it("serves stored media to the page without auth", async () => {
    const w = createWorld();
    await w.control.send(REP, { file: { path: file("contrato.pdf", PDF), mime: "application/pdf" } });
    const { entries } = (await (await w.emulator.app.request("/dev/chat/timeline")).json()) as {
      entries: { media: { id: string } }[];
    };
    const res = await w.emulator.app.request(`/dev/chat/media/${entries[0]?.media.id}`);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain("contrato.pdf");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF);
  });

  it("streams a snapshot, then live entries, over SSE", async () => {
    const w = createWorld();
    await w.control.send(REP, { text: "antes" });
    const res = await w.emulator.app.request("/dev/chat/events");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const readUntil = async (marker: string) => {
      while (!buffer.includes(marker)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`stream ended before ${marker}`);
        buffer += decoder.decode(value);
      }
    };
    await readUntil("event: snapshot");
    await readUntil("\n\n");
    expect(buffer).toContain('"text":"antes"');
    await w.client.sendText(REP, "depois");
    await readUntil("event: entry");
    await readUntil('"text":"depois"');
    await reader.cancel();
    w.emulator.close();
  });
});

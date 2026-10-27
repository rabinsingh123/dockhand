import { readFileSync } from "node:fs";
import type { InboundMessage } from "@dockhand/core";
import { describe, expect, it } from "vitest";
import { parseWebhook, parseWebhookEntries, signatureHeader, verifySignature } from "./webhook.ts";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8"));
const only = (name: string): InboundMessage => {
  const parsed = parseWebhook(fixture(name));
  expect(parsed.messages).toHaveLength(1);
  return parsed.messages[0] as InboundMessage;
};

const REP = "5511999990000";
const PLAN_CARD = "wamid.HBgNNTUxMTk5OTk5MDAwMBUCABEYEkRPQ0tIQU5EUExBTkNBUkQwMQA=";

describe("parseWebhook", () => {
  it("parses a text message", () => {
    expect(only("text.json")).toEqual({
      waId: expect.stringMatching(/^wamid\./),
      from: REP,
      ts: 1761573660_000,
      kind: "text",
      text: "Oi! Pode mandar o preço para 25 pessoas em São Paulo, começando em janeiro?",
    });
  });

  it("maps context.id to replyTo", () => {
    expect(only("text-reply.json")).toMatchObject({
      kind: "text",
      text: "Na verdade são 30 pessoas",
      replyTo: PLAN_CARD,
    });
  });

  it("parses a voice note with its voice flag and codec MIME", () => {
    const m = only("voice-note.json");
    expect(m.kind).toBe("audio");
    expect(m.media).toEqual({ mediaId: "1908600000000001", mime: "audio/ogg; codecs=opus", voice: true });
    expect(m.text).toBeUndefined();
  });

  it("parses a forwarded image with its caption", () => {
    expect(only("image-forwarded.json")).toMatchObject({
      kind: "image",
      text: "Formulário de indicação assinado - Caravela",
      media: { mediaId: "1003300000000002", mime: "image/jpeg" },
      forwarded: true,
    });
    expect(only("image-forwarded.json").replyTo).toBeUndefined();
  });

  it("parses a PDF document with filename and caption", () => {
    expect(only("document-pdf.json")).toMatchObject({
      kind: "document",
      text: "Acme Group pede cadastro como fornecedor",
      media: { mediaId: "6226800000000003", mime: "application/pdf", filename: "acme-supplier-request.pdf" },
    });
  });

  it("parses a video, and an MP4 sent as a document keeps kind document with the video MIME", () => {
    expect(only("video.json")).toMatchObject({
      kind: "video",
      text: "Como registro um deal no portal da Caravela",
      media: { mediaId: "7316700000000004", mime: "video/mp4" },
    });
    expect(only("document-video.json")).toMatchObject({
      kind: "document",
      media: { mime: "video/mp4", filename: "screen-recording-partner-portal.mp4" },
    });
  });

  it("parses a reply-button tap with the card it answers", () => {
    expect(only("button-reply.json")).toMatchObject({
      kind: "button",
      button: { id: "g:01JBGATE0000000000000000AA:a", title: "Approve" },
      replyTo: PLAN_CARD,
    });
  });

  it("treats a list reply as a button", () => {
    expect(only("list-reply.json")).toMatchObject({
      kind: "button",
      button: { id: "skill:register_partner_deal", title: "Register deal" },
    });
  });

  it("counts statuses as ignored", () => {
    expect(parseWebhook(fixture("statuses-only.json"))).toEqual({ messages: [], ignored: 3 });
  });

  it("loops over every entry, change and message", () => {
    const parsed = parseWebhook(fixture("multi-message.json"));
    expect(parsed.messages.map((m) => [m.from, m.kind])).toEqual([
      [REP, "text"],
      [REP, "image"],
      ["5521988880000", "text"],
    ]);
    expect(parsed.ignored).toBe(2); // one status + one account_update change
  });

  it("returns unknown types as unsupported and template quick replies as buttons", () => {
    const parsed = parseWebhook(fixture("unsupported-and-quick-reply.json"));
    expect(parsed.messages.map((m) => m.kind)).toEqual([
      "unsupported",
      "unsupported",
      "unsupported",
      "unsupported",
      "button",
    ]);
    expect(parsed.messages[0]?.media).toBeUndefined();
    expect(parsed.messages[4]?.button).toEqual({ id: "talk_to_person", title: "Talk to a person" });
    expect(parsed.ignored).toBe(0);
  });

  it("keeps each message's raw object for storage", () => {
    const { entries } = parseWebhookEntries(fixture("multi-message.json"));
    expect(entries).toHaveLength(3);
    expect(entries[1]?.raw).toMatchObject({ type: "image", image: { id: "1003300000000007" } });
  });

  it("normalizes odd but valid fields", () => {
    const parsed = parseWebhook({
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                messages: [
                  { id: "wamid.A", from: "+5511999990000", type: "text", text: { body: "oi" } },
                  {
                    id: "wamid.B",
                    from: REP,
                    timestamp: "1761573600",
                    type: "text",
                    context: { frequently_forwarded: true },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(parsed.messages).toEqual([
      { waId: "wamid.A", from: REP, ts: 0, kind: "text", text: "oi" },
      { waId: "wamid.B", from: REP, ts: 1761573600_000, kind: "text", text: "", forwarded: true },
    ]);
  });

  it("never throws on malformed input", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("boom");
        },
      },
    );
    const inputs: unknown[] = [
      undefined,
      null,
      "not json",
      42,
      [],
      {},
      { entry: "x" },
      { entry: [null, 1, "x", { changes: "x" }] },
      { entry: [{ changes: [null, { field: "messages" }, { field: "statuses", value: {} }] }] },
      {
        entry: [
          {
            changes: [
              {
                field: "messages",
                value: { messages: [null, {}, { id: "x" }, { from: "1" }, { id: 7, from: 8 }, "msg"] },
              },
            ],
          },
        ],
      },
      {
        entry: [
          {
            changes: [
              { field: "messages", value: { messages: [{ id: "w", from: "1", type: "image", image: "x" }] } },
            ],
          },
        ],
      },
      {
        entry: [
          {
            changes: [
              { field: "messages", value: { messages: [{ id: "w", from: "1", type: "interactive" }] } },
            ],
          },
        ],
      },
      hostile,
      { entry: [hostile] },
    ];
    for (const input of inputs) {
      const parsed = parseWebhook(input);
      expect(Array.isArray(parsed.messages)).toBe(true);
      expect(parsed.ignored).toBeGreaterThanOrEqual(0);
    }
    expect(
      parseWebhook({
        entry: [
          {
            changes: [
              { field: "messages", value: { messages: [{ id: "w", from: "1", type: "image", image: "x" }] } },
            ],
          },
        ],
      }).messages[0]?.kind,
    ).toBe("unsupported");
    expect(parseWebhook(undefined)).toEqual({ messages: [], ignored: 1 });
  });
});

describe("verifySignature", () => {
  const secret = "test-app-secret";
  const raw = new TextEncoder().encode(JSON.stringify(fixture("text.json")));

  it("accepts the HMAC-SHA256 of the raw bytes", () => {
    const header = signatureHeader(raw, secret);
    expect(header).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifySignature(raw, header, secret)).toBe(true);
    expect(verifySignature(raw, header.toUpperCase().replace("SHA256=", "sha256="), secret)).toBe(true);
  });

  it("rejects a wrong secret, a changed body and a re-serialized body", () => {
    const header = signatureHeader(raw, secret);
    expect(verifySignature(raw, header, "other-secret")).toBe(false);
    const changed = raw.slice();
    changed[10] = (changed[10] ?? 0) ^ 1;
    expect(verifySignature(changed, header, secret)).toBe(false);
    const reserialized = new TextEncoder().encode(
      JSON.stringify(JSON.parse(new TextDecoder().decode(raw)), null, 2),
    );
    expect(verifySignature(reserialized, header, secret)).toBe(false);
  });

  it("rejects missing or malformed headers and an empty secret", () => {
    const hex = signatureHeader(raw, secret).slice("sha256=".length);
    for (const header of [
      undefined,
      "",
      hex,
      `sha1=${hex}`,
      "sha256=",
      "sha256=zz",
      `sha256=${hex}00`,
      `sha256=${hex.slice(2)}`,
    ]) {
      expect(verifySignature(raw, header, secret)).toBe(false);
    }
    expect(verifySignature(raw, signatureHeader(raw, ""), "")).toBe(false);
  });
});

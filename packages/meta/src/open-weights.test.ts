import type { InputPart } from "@dockhand/core";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { toWireSchema } from "./schema.ts";
import {
  BASETEN_KEY,
  b64,
  ctx,
  docFixture,
  makeWorld,
  OPEN_WEIGHTS_MODEL,
  pdfBytes,
  pngBytes,
  type World,
} from "./test-support/world.ts";

const HealPick = z.object({
  index: z.number().int(),
  reason: z.string(),
  confidence: z.number().optional(),
});
const PATH = "/baseten/v1/chat/completions";
const USAGE = {
  prompt_tokens: 1000,
  completion_tokens: 200,
  total_tokens: 1200,
  completion_tokens_details: { reasoning_tokens: 150 },
  prompt_tokens_details: { cached_tokens: 0 },
};

/** The documented Baseten body (reasoning page) with our content and usage. */
function chatBody(content: string, o: { finish?: string; usage?: unknown } = {}) {
  const documented = docFixture<{ choices: Record<string, unknown>[] }>(
    "baseten.chat-completion-response.json",
  );
  const choice = documented.choices[0] ?? {};
  return {
    id: "chatcmpl-1",
    ...documented,
    choices: [
      { ...choice, message: { ...(choice.message as object), content }, finish_reason: o.finish ?? "stop" },
    ],
    usage: o.usage ?? USAGE,
  };
}

function healRequest(
  input: InputPart[] = [
    { type: "text", text: "Step intent: click Submit registration. Elements: [3] button 'Register deal'" },
  ],
) {
  return {
    model: OPEN_WEIGHTS_MODEL,
    instructions: "Pick the element that matches the step intent.",
    input,
    schemaName: "HealPick",
    schema: HealPick,
  };
}

let world: World;
afterEach(async () => {
  await world?.close();
});

describe("open weights (Muse Spark Open on Baseten)", () => {
  it("routes the configured model to Baseten chat completions with json_schema, the schema in the prompt and low effort", async () => {
    world = await makeWorld();
    world.server.on(PATH, {
      json: chatBody('```json\n{"index": 3, "reason": "same label", "confidence": null}\n```'),
    });

    const pick = await world.gateway.structured(healRequest(), ctx("heal_match"));

    expect(pick).toEqual({ index: 3, reason: "same label" });
    expect(world.server.requestsTo("/v1/responses")).toHaveLength(0);
    const [req] = world.server.requestsTo(PATH);
    expect(req?.headers.authorization).toBe(`Bearer ${BASETEN_KEY}`);
    const wire = toWireSchema(HealPick).schema;
    const body = req?.json as Record<string, unknown>;
    expect(body).toEqual({
      model: OPEN_WEIGHTS_MODEL,
      messages: [
        {
          role: "system",
          content: `Pick the element that matches the step intent.\n\nReply with only a JSON object (no prose, no code fences) that matches this JSON Schema:\n${JSON.stringify(wire)}`,
        },
        {
          role: "user",
          content: "Step intent: click Submit registration. Elements: [3] button 'Register deal'",
        },
      ],
      response_format: { type: "json_schema", json_schema: { name: "HealPick", schema: wire } },
      reasoning_effort: "low",
      max_tokens: 4096,
    });
    // response_format matches Baseten's OpenAPI ResponseFormatJson / JsonSchema.
    const api = docFixture<Record<string, { required: string[]; properties: Record<string, unknown> }>>(
      "baseten.openapi-components.json",
    );
    const format = body.response_format as Record<string, Record<string, unknown>>;
    expect(Object.keys(format).sort()).toEqual([...(api.ResponseFormatJson?.required ?? [])].sort());
    for (const key of api.JsonSchema?.required ?? []) expect(format.json_schema).toHaveProperty(key);
    for (const key of Object.keys(format.json_schema ?? {}))
      expect(api.JsonSchema?.properties).toHaveProperty(key);
  });

  it("records a baseten ledger row priced from OPEN_WEIGHTS_PRICE_IN/OUT", async () => {
    world = await makeWorld();
    world.server.on(PATH, { json: chatBody('{"index":1,"reason":"r"}') });

    await world.gateway.structured(healRequest(), ctx("heal_match", { runId: "run-1", stepIdx: 5 }));

    expect(world.ledger.rows[0]).toMatchObject({
      purpose: "heal_match",
      provider: "baseten",
      model: OPEN_WEIGHTS_MODEL,
      responseId: "chatcmpl-1",
      inputTokens: 1000,
      cachedInputTokens: 0,
      outputTokens: 200,
      reasoningTokens: 150,
      status: "ok",
    });
    // 1000 * 1.25 + 200 * 4.25 = 2100 per 1M tokens
    expect(world.ledger.rows[0]?.costUsd).toBeCloseTo(0.0021, 12);
  });

  it("validates with zod and retries once with the error, since Baseten does not enforce the schema", async () => {
    world = await makeWorld();
    world.server.on(
      PATH,
      { json: chatBody("I think it is element three.") },
      { json: chatBody('{"index":3,"reason":"label"}') },
    );

    const pick = await world.gateway.structured(healRequest(), ctx("heal_match"));

    expect(pick).toEqual({ index: 3, reason: "label" });
    const retry = world.server.requestsTo(PATH)[1]?.json as { messages: Record<string, unknown>[] };
    expect(retry.messages).toHaveLength(4);
    expect(retry.messages[2]).toEqual({ role: "assistant", content: "I think it is element three." });
    expect(retry.messages[3]?.role).toBe("user");
    expect(String(retry.messages[3]?.content)).toContain("not valid JSON");
    expect(world.ledger.rows.map((r) => [r.provider, r.status, r.errorCode])).toEqual([
      ["baseten", "error", "MODEL_INVALID_OUTPUT"],
      ["baseten", "ok", undefined],
    ]);
  });

  it("sends images as image_url data URLs and enforces Baseten's media limits before any request", async () => {
    world = await makeWorld();
    const png = pngBytes(5);
    const image = await world.put(png, "image/png");
    const pdf = await world.put(pdfBytes(), "application/pdf");
    world.server.on(PATH, { json: chatBody('{"index":0,"reason":"r"}') });

    await world.gateway.structured(
      healRequest([
        { type: "text", text: "Which one?" },
        { type: "image", image },
      ]),
      ctx("heal_match"),
    );
    const body = world.server.requestsTo(PATH)[0]?.json as { messages: { content: unknown }[] };
    expect(body.messages[1]?.content).toEqual([
      { type: "text", text: "Which one?" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${b64(png)}` } },
    ]);
    expect(world.ledger.rows[0]?.images).toBe(1);

    const nine: InputPart[] = Array.from({ length: 9 }, () => ({ type: "image", image }));
    await expect(world.gateway.structured(healRequest(nine), ctx("heal_match"))).rejects.toMatchObject({
      code: "TOO_MANY_IMAGES",
    });
    await expect(
      world.gateway.structured(healRequest([{ type: "pdf", file: pdf }]), ctx("heal_match")),
    ).rejects.toMatchObject({
      code: "MEDIA_UNSUPPORTED",
    });
    expect(world.server.requestsTo(PATH)).toHaveLength(1);
  });

  it("maps finish_reason length to MODEL_INCOMPLETE after one retry with a doubled max_tokens", async () => {
    world = await makeWorld();
    const cut = { json: chatBody('{"index":', { finish: "length" }) };
    world.server.on(PATH, cut, cut);
    await expect(world.gateway.structured(healRequest(), ctx("heal_match"))).rejects.toMatchObject({
      code: "MODEL_INCOMPLETE",
    });
    expect(world.server.requestsTo(PATH).map((r) => (r.json as { max_tokens: number }).max_tokens)).toEqual([
      4096, 8192,
    ]);
    expect(world.ledger.rows[0]).toMatchObject({ provider: "baseten", status: "incomplete" });
  });

  it("hasOpenWeights reflects the Baseten key; without it the open-weights model is refused", async () => {
    world = await makeWorld();
    expect(world.gateway.hasOpenWeights()).toBe(true);
    await world.close();

    world = await makeWorld({ openWeights: { apiKey: undefined } });
    expect(world.gateway.hasOpenWeights()).toBe(false);
    await expect(world.gateway.structured(healRequest(), ctx("heal_match"))).rejects.toMatchObject({
      code: "MODEL_ERROR",
    });
    expect(world.server.requests).toHaveLength(0);
  });

  it("records $0 and warns at startup while the Baseten price is not configured", async () => {
    world = await makeWorld({ openWeights: { priceInPerM: undefined, priceOutPerM: undefined } });
    expect(world.logs.some((l) => l.includes("OPEN_WEIGHTS_PRICE_IN/OUT unset"))).toBe(true);
    world.server.on(PATH, { json: chatBody('{"index":2,"reason":"r"}') });

    await world.gateway.structured(healRequest(), ctx("heal_match"));

    expect(world.ledger.rows[0]).toMatchObject({ provider: "baseten", costUsd: 0, inputTokens: 1000 });
  });
});

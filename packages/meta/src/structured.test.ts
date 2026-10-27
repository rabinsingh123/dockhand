import { DockhandError, type InputPart } from "@dockhand/core";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  b64,
  ctx,
  docFixture,
  META_KEY,
  makeWorld,
  messageItem,
  mp4Bytes,
  must,
  pdfBytes,
  pngBytes,
  reasoningItem,
  responseBody,
  shapeOf,
  type World,
} from "./test-support/world.ts";

const Extraction = z.object({
  company: z.string().nullable(),
  seats: z.number(),
  note: z.string().optional(),
});

const EXPECTED_WIRE_SCHEMA = {
  type: "object",
  properties: {
    company: { type: ["string", "null"] },
    seats: { type: "number" },
    note: { type: ["string", "null"] },
  },
  required: ["company", "seats", "note"],
  additionalProperties: false,
};

let world: World;
afterEach(async () => {
  await world?.close();
});

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof DockhandError) return err.code;
    throw err;
  }
  throw new Error("expected the call to fail");
}

describe("structured (Responses API)", () => {
  it("sends the documented request: user message parts, json_schema text.format, effort, max tokens", async () => {
    world = await makeWorld();
    const png = pngBytes();
    const image = await world.put(png, "image/png");
    world.server.on("/v1/responses", {
      json: responseBody([reasoningItem(), messageItem('{"company":"Acme Group","seats":25,"note":null}')]),
    });

    const result = await world.gateway.structured(
      {
        model: "muse-spark-1.3",
        instructions: "Extract the referral form fields.",
        input: [
          { type: "text", text: "Referral form from Caravela" },
          { type: "image", image },
        ],
        schemaName: "Extraction",
        schema: Extraction,
        effort: "low",
        maxOutputTokens: 2048,
      },
      ctx("extract"),
    );

    expect(result).toEqual({ company: "Acme Group", seats: 25 });
    expect("note" in result).toBe(false);

    const [req] = world.server.requestsTo("/v1/responses");
    expect(req?.method).toBe("POST");
    expect(req?.headers.authorization).toBe(`Bearer ${META_KEY}`);
    expect(req?.json).toEqual({
      model: "muse-spark-1.3",
      instructions: "Extract the referral form fields.",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Referral form from Caravela" },
            { type: "input_image", image_url: `data:image/png;base64,${b64(png)}` },
          ],
        },
      ],
      text: {
        format: { type: "json_schema", name: "Extraction", schema: EXPECTED_WIRE_SCHEMA, strict: false },
      },
      reasoning: { effort: "low" },
      max_output_tokens: 2048,
      store: false,
    });
    // Same message structure as the documented Responses input (file-handling page).
    const documented = docFixture<{ input: unknown[] }>("responses.input-file-request.json").input[0];
    const sent = (must(req).json as { input: Record<string, unknown>[] }).input[0];
    expect(Object.keys(sent ?? {}).sort()).toEqual(Object.keys(documented as object).sort());
  });

  it("records one ledger row with tokens (cached, reasoning), images and the Standard-price cost", async () => {
    world = await makeWorld();
    const image = await world.put(pngBytes(), "image/png");
    world.server.on("/v1/responses", {
      json: responseBody([messageItem('{"company":null,"seats":3}')], { id: "resp_42" }),
    });

    await world.gateway.structured(
      {
        model: "muse-spark-1.3",
        instructions: "x",
        input: [{ type: "image", image }],
        schemaName: "Extraction",
        schema: Extraction,
      },
      ctx("extract", { runId: "run-7", stepIdx: 2 }),
    );

    expect(world.ledger.rows).toHaveLength(1);
    const row = world.ledger.rows[0];
    expect(row).toMatchObject({
      purpose: "extract",
      provider: "meta",
      model: "muse-spark-1.3",
      jobId: "job-1",
      runId: "run-7",
      stepIdx: 2,
      responseId: "resp_42",
      inputTokens: 1200,
      cachedInputTokens: 200,
      outputTokens: 300,
      reasoningTokens: 100,
      images: 1,
      status: "ok",
    });
    // (1200 - 200) * 1.25 + 200 * 0.15 + 300 * 4.25 = 2555 per 1M tokens
    expect(row?.costUsd).toBeCloseTo(0.002555, 12);
    expect(row?.errorCode).toBeUndefined();
  });

  it("prices a contributor-mode call at the Standard list price and maps max effort to xhigh", async () => {
    world = await makeWorld();
    world.server.on("/v1/responses", { json: responseBody([messageItem('{"company":null,"seats":1}')]) });

    await world.gateway.structured(
      {
        model: "muse-spark-1.3-contributor",
        instructions: "x",
        input: [{ type: "text", text: "one seat" }],
        schemaName: "Extraction",
        schema: Extraction,
        effort: "max",
      },
      ctx(),
    );

    expect(
      (must(world.server.requestsTo("/v1/responses")[0]).json as { reasoning: unknown }).reasoning,
    ).toEqual({
      effort: "xhigh",
    });
    expect(world.ledger.rows[0]?.costUsd).toBeCloseTo(0.002555, 12);
  });

  it("parses the documented example response (usage without details)", async () => {
    world = await makeWorld();
    const documented = docFixture("responses.basic-response.json");
    const output = [messageItem('{"company":"Globex Industrial","seats":40}')];
    world.server.on("/v1/responses", { json: { ...documented, output } });

    const result = await world.gateway.structured(
      { model: "muse-spark-1.3", instructions: "x", input: [], schemaName: "Extraction", schema: Extraction },
      ctx(),
    );

    expect(result).toEqual({ company: "Globex Industrial", seats: 40 });
    expect(world.ledger.rows[0]).toMatchObject({ inputTokens: 69, cachedInputTokens: 0, outputTokens: 163 });
    expect(world.ledger.rows[0]?.reasoningTokens).toBeUndefined();
  });

  it("uploads a PDF once with the Files API (purpose before file) and references it as input_file", async () => {
    world = await makeWorld();
    const bytes = pdfBytes();
    const pdf = await world.put(bytes, "application/pdf");
    world.server.on("/v1/files", { json: docFixture("files.upload-response.json") });
    const reply = { json: responseBody([messageItem('{"company":"Acme Group","seats":12}')]) };
    world.server.on("/v1/responses", reply, reply);
    const req = {
      model: "muse-spark-1.3",
      instructions: "Read the procurement PDF.",
      input: [
        { type: "text", text: "Supplier onboarding request" },
        { type: "pdf", file: pdf },
      ] as InputPart[],
      schemaName: "Extraction",
      schema: Extraction,
    };

    await world.gateway.structured(req, ctx());
    await world.gateway.structured(req, ctx());

    const uploads = world.server.requestsTo("/v1/files");
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.headers.authorization).toBe(`Bearer ${META_KEY}`);
    const parts = uploads[0]?.parts ?? [];
    expect(parts.map((p) => p.name)).toEqual(["purpose", "file"]);
    expect(parts[0]).toMatchObject({ name: "purpose", text: "user_data" });
    expect(parts[0]?.filename).toBeUndefined();
    expect(parts[1]?.contentType).toBe("application/pdf");
    expect(parts[1]?.filename).toMatch(/\.pdf$/);
    expect(new Uint8Array(parts[1]?.data ?? [])).toEqual(bytes);

    const documentedPart = docFixture<{ input: { content: unknown[] }[] }>(
      "responses.input-file-request.json",
    ).input[0]?.content[1];
    for (const call of world.server.requestsTo("/v1/responses")) {
      const content = (call.json as { input: { content: unknown[] }[] }).input[0]?.content;
      expect(content?.[1]).toEqual({ type: "input_file", file_id: "file-842549258569145" });
      expect(shapeOf(content?.[1])).toEqual(shapeOf(documentedPart));
    }
  });

  it("uploads an mp4 and references it as input_file, or input_video when fps is set", async () => {
    world = await makeWorld();
    const video = await world.put(mp4Bytes(), "video/mp4");
    world.server.on("/v1/files", { json: { id: "file-777", object: "file" } });
    const reply = { json: responseBody([messageItem('{"company":null,"seats":0}')]) };
    world.server.on("/v1/responses", reply, reply);
    const base = {
      model: "muse-spark-1.3",
      instructions: "Watch the screen recording.",
      schemaName: "Extraction",
      schema: Extraction,
    };

    await world.gateway.structured({ ...base, input: [{ type: "video", video }] }, ctx("teach"));
    await world.gateway.structured({ ...base, input: [{ type: "video", video, fps: 2 }] }, ctx("teach"));

    const [first, second] = world.server
      .requestsTo("/v1/responses")
      .map((r) => (r.json as { input: { content: unknown[] }[] }).input[0]?.content[0]);
    expect(first).toEqual({ type: "input_file", file_id: "file-777" });
    expect(second).toEqual({ type: "input_video", file_id: "file-777", fps: 2 });
    expect(world.server.requestsTo("/v1/files")).toHaveLength(1);
    // Same block the video-understanding page sends for an uploaded video.
    const documented = docFixture<{ input: { content: unknown[] }[] }>("video.input-file-request.json")
      .input[0]?.content[1];
    expect(shapeOf(first)).toEqual(shapeOf(documented));
  });

  it("sends an image too large for an inline data URL through the Files API as input_image file_id", async () => {
    world = await makeWorld();
    const big = new Uint8Array(15_800_000); // base64 data URL > 20,971,520 chars (image_url maxLength)
    big.set(pngBytes(), 0);
    const image = await world.put(big, "image/png");
    world.server.on("/v1/files", { json: { id: "file-big-1", object: "file" } });
    world.server.on("/v1/responses", { json: responseBody([messageItem('{"company":null,"seats":1}')]) });

    await world.gateway.structured(
      {
        model: "muse-spark-1.3",
        instructions: "x",
        input: [{ type: "image", image }],
        schemaName: "Extraction",
        schema: Extraction,
      },
      ctx(),
    );

    const upload = must(world.server.requestsTo("/v1/files")[0]);
    expect(upload.parts?.[1]?.contentType).toBe("image/png");
    expect(upload.parts?.[1]?.data.byteLength).toBe(big.byteLength);
    const content = (
      must(world.server.requestsTo("/v1/responses")[0]).json as { input: { content: unknown[] }[] }
    ).input[0]?.content;
    expect(content).toEqual([{ type: "input_image", file_id: "file-big-1" }]);
    expect(world.ledger.rows[0]?.images).toBe(1);
  });

  it("rejects non-mp4 video and mislabeled media before any request", async () => {
    world = await makeWorld();
    const mov = await world.put(mp4Bytes(), "video/quicktime");
    const fakeMp4 = await world.put(pdfBytes(), "video/mp4");
    const heic = await world.put(pngBytes(), "image/heic");
    const base = { model: "muse-spark-1.3", instructions: "x", schemaName: "Extraction", schema: Extraction };

    expect(
      await codeOf(world.gateway.structured({ ...base, input: [{ type: "video", video: mov }] }, ctx())),
    ).toBe("MEDIA_UNSUPPORTED");
    expect(
      await codeOf(world.gateway.structured({ ...base, input: [{ type: "video", video: fakeMp4 }] }, ctx())),
    ).toBe("MEDIA_UNSUPPORTED");
    expect(
      await codeOf(world.gateway.structured({ ...base, input: [{ type: "image", image: heic }] }, ctx())),
    ).toBe("MEDIA_UNSUPPORTED");
    expect(world.server.requests).toHaveLength(0);
  });

  it("rejects more than 50 images with TOO_MANY_IMAGES before sending", async () => {
    world = await makeWorld();
    const image = await world.put(pngBytes(), "image/png");
    const input: InputPart[] = Array.from({ length: 51 }, () => ({ type: "image", image }));

    const code = await codeOf(
      world.gateway.structured(
        { model: "muse-spark-1.3", instructions: "x", input, schemaName: "Extraction", schema: Extraction },
        ctx(),
      ),
    );

    expect(code).toBe("TOO_MANY_IMAGES");
    expect(world.server.requests).toHaveLength(0);
  });

  it("retries once with the validation error appended, then returns the valid output", async () => {
    world = await makeWorld();
    world.server.on(
      "/v1/responses",
      { json: responseBody([messageItem("Sure! The company is Acme.")]) },
      { json: responseBody([messageItem('{"company":"Acme Group","seats":25}')]) },
    );

    const result = await world.gateway.structured(
      {
        model: "muse-spark-1.3",
        instructions: "x",
        input: [{ type: "text", text: "25 seats for Acme" }],
        schemaName: "Extraction",
        schema: Extraction,
      },
      ctx("understand"),
    );

    expect(result).toEqual({ company: "Acme Group", seats: 25 });
    const calls = world.server.requestsTo("/v1/responses");
    expect(calls).toHaveLength(2);
    const retryInput = (must(calls[1]).json as { input: Record<string, unknown>[] }).input;
    expect(retryInput).toHaveLength(3);
    expect(retryInput[0]).toEqual((must(calls[0]).json as { input: unknown[] }).input[0]);
    expect(retryInput[1]).toEqual({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Sure! The company is Acme." }],
    });
    expect(retryInput[2]).toMatchObject({ type: "message", role: "user" });
    expect(JSON.stringify(retryInput[2])).toContain("not valid JSON");

    expect(world.ledger.rows.map((r) => [r.status, r.errorCode])).toEqual([
      ["error", "MODEL_INVALID_OUTPUT"],
      ["ok", undefined],
    ]);
  });

  it("throws MODEL_INVALID_OUTPUT when the retry is invalid too (zod errors are fed back)", async () => {
    world = await makeWorld();
    world.server.on(
      "/v1/responses",
      { json: responseBody([messageItem('{"company":"Acme Group","seats":"many"}')]) },
      { json: responseBody([messageItem('{"company":"Acme Group"}')]) },
    );

    const code = await codeOf(
      world.gateway.structured(
        {
          model: "muse-spark-1.3",
          instructions: "x",
          input: [],
          schemaName: "Extraction",
          schema: Extraction,
        },
        ctx(),
      ),
    );

    expect(code).toBe("MODEL_INVALID_OUTPUT");
    const second = world.server.requestsTo("/v1/responses")[1]?.json as { input: unknown[] };
    expect(JSON.stringify(second.input[2])).toContain("seats");
    expect(world.ledger.rows).toHaveLength(2);
    expect(
      world.ledger.rows.every((r) => r.status === "error" && r.errorCode === "MODEL_INVALID_OUTPUT"),
    ).toBe(true);
  });

  it("maps status incomplete to MODEL_INCOMPLETE and records the billed usage", async () => {
    world = await makeWorld();
    world.server.on("/v1/responses", {
      json: responseBody([reasoningItem()], { status: "incomplete", incomplete: "max_output_tokens" }),
    });

    const code = await codeOf(
      world.gateway.structured(
        {
          model: "muse-spark-1.3",
          instructions: "x",
          input: [],
          schemaName: "Extraction",
          schema: Extraction,
          maxOutputTokens: 16,
        },
        ctx(),
      ),
    );

    expect(code).toBe("MODEL_INCOMPLETE");
    expect(world.ledger.rows[0]).toMatchObject({
      status: "incomplete",
      errorCode: "MODEL_INCOMPLETE",
      outputTokens: 300,
    });
    expect(world.ledger.rows[0]?.costUsd).toBeCloseTo(0.002555, 12);
  });

  it("times out with MODEL_TIMEOUT from ctx.timeoutMs", async () => {
    world = await makeWorld();
    world.server.on("/v1/responses", { delayMs: 400, json: responseBody([messageItem("{}")]) });

    const code = await codeOf(
      world.gateway.structured(
        {
          model: "muse-spark-1.3",
          instructions: "x",
          input: [],
          schemaName: "Extraction",
          schema: Extraction,
        },
        ctx("extract", { timeoutMs: 50 }),
      ),
    );

    expect(code).toBe("MODEL_TIMEOUT");
    expect(world.ledger.rows[0]).toMatchObject({ status: "timeout", errorCode: "MODEL_TIMEOUT", costUsd: 0 });
  });

  it("surfaces a 400 as MODEL_ERROR without retrying, with media and keys redacted from the message", async () => {
    world = await makeWorld();
    const envelope = docFixture<{ error: Record<string, unknown> }>("errors.validation.json");
    const echoed = `bad image data:image/png;base64,${"A".repeat(300)} sent with ${META_KEY}`;
    world.server.on("/v1/responses", {
      status: 400,
      json: { error: { ...envelope.error, message: echoed } },
    });

    let caught: unknown;
    try {
      await world.gateway.structured(
        {
          model: "muse-spark-1.3",
          instructions: "x",
          input: [],
          schemaName: "Extraction",
          schema: Extraction,
        },
        ctx(),
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(DockhandError);
    const err = caught as DockhandError;
    expect(err.code).toBe("MODEL_ERROR");
    expect(err.message).toContain("HTTP 400 invalid_request_error");
    expect(err.message).toContain("data:image/png;base64,<redacted>");
    expect(err.message).not.toContain(META_KEY);
    expect(err.detail).toMatchObject({ status: 400, param: "top_p", provider: "meta" });
    expect(world.server.requestsTo("/v1/responses")).toHaveLength(1);
    expect(world.ledger.rows[0]).toMatchObject({ status: "error", errorCode: "MODEL_ERROR" });
  });

  it("never logs the API key, request bodies or base64", async () => {
    world = await makeWorld();
    const image = await world.put(pngBytes(9), "image/png");
    world.server.on(
      "/v1/responses",
      { status: 429, json: docFixture("errors.rate-limit.json"), headers: { "retry-after": "1" } },
      { json: responseBody([messageItem("nope")]) },
      { json: responseBody([messageItem('{"company":null,"seats":2}')]) },
    );

    await world.gateway.structured(
      {
        model: "muse-spark-1.3",
        instructions: "secret instructions text",
        input: [{ type: "image", image }],
        schemaName: "Extraction",
        schema: Extraction,
      },
      ctx(),
    );

    const logText = world.logs.join("\n");
    expect(world.logs.length).toBeGreaterThan(0);
    expect(logText).not.toContain(META_KEY);
    expect(logText).not.toContain("base64");
    expect(logText).not.toContain("secret instructions text");
  });
});
